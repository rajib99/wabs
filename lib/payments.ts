import { and, eq, inArray, ne } from "drizzle-orm";
import { inngest } from "@/inngest/client";
import { audit } from "@/lib/audit";
import { sendToUser } from "@/lib/conversation/outbound";
import { db, schema } from "@/lib/db";
import { getMatch, type Match, otherParty, transition } from "@/lib/matches";
import { getSetting, msg } from "@/lib/settings";
import { normalizeDigits, toAsciiDigits } from "@/lib/text";

const { payments } = schema;

export async function paymentInfo() {
  const [amount, bkash_number] = await Promise.all([getSetting<number>("price_bdt"), getSetting<string>("bkash_number")]);
  return { amount, bkash_number };
}

/** States in which a person may pay for the other side's number: both sides have said they are interested. */
export const PAYABLE_STATES = ["both_interested", "contact_released"];

/** This person's payment for this match that is not rejected, if any. */
async function openPayment(matchId: string, phone: string) {
  const [row] = await db().select().from(payments)
    .where(and(eq(payments.matchId, matchId), eq(payments.payerPhone, phone), ne(payments.status, "rejected")));
  return row;
}

/**
 * Sends the bKash details to someone who asked for the other side's number. Returns a note for the agent:
 * nothing is sent when their payment is already waiting for verification or already verified.
 */
export async function sendNumberPaymentInstructions(matchId: string, phone: string): Promise<string> {
  const existing = await openPayment(matchId, phone);
  if (existing?.status === "verified") return "This user already paid and was sent the number.";
  if (existing) return "Their payment is waiting for verification. Tell them we verify it first and then send the number.";
  const info = await paymentInfo();
  if (!info.bkash_number) throw new Error("settings.bkash_number is empty: set it in the admin panel");
  // Once per attempt: after a rejected payment the details may go again.
  const rejected = await db().select({ id: payments.id }).from(payments)
    .where(and(eq(payments.matchId, matchId), eq(payments.payerPhone, phone), eq(payments.status, "rejected")));
  await sendToUser(phone, await msg("number_payment_request", info), {
    dedupeKey: `numpay-${matchId}-${phone}-${rejected.length}`, template: "payment_reminder",
  });
  await audit("system", "payment.instructions_sent", "match", matchId);
  return "The system has sent the bKash payment details. Do not repeat them; ask the user to send the Transaction ID after paying.";
}

export type SubmitResult = { ok: true; paymentId: string; note: string } | { ok: false; error: string };

/**
 * Meta's policy forbids asking for financial account numbers in messages, so only the last 4 digits of the
 * sending wallet are kept, and only if offered. A full number someone types anyway is cut down to 4.
 */
export function walletLast4(input: string | undefined): string | null | "invalid" {
  if (!input?.trim()) return null;
  const digits = normalizeDigits(input);
  if (digits.length < 4) return "invalid";
  return digits.slice(-4);
}

/**
 * A payment claim: a bKash Transaction ID, or, without one, the last 4 digits of the sending number plus when it
 * was sent. Waits for an admin; nothing is released here.
 */
export async function submitPayment(phone: string, matchId: string, walletHint: string | undefined, trx: string | undefined, details?: string): Promise<SubmitResult> {
  const d = db();
  const match = await getMatch(matchId);
  if (!match || (match.userA !== phone && match.userB !== phone)) return { ok: false, error: "match not found" };
  if (!PAYABLE_STATES.includes(match.state)) return { ok: false, error: "payment is not open for this match: the other side has not agreed yet" };

  const senderWalletNumber = walletLast4(walletHint);
  if (senderWalletNumber === "invalid") return { ok: false, error: "wallet_last4 must be the last 4 digits" };

  let trxId: string | null = null;
  if (trx?.trim()) {
    trxId = toAsciiDigits(trx).trim().toUpperCase();
    const pattern = await getSetting<string>("trx_id_pattern");
    if (!new RegExp(pattern).test(trxId)) return { ok: false, error: "invalid transaction ID format" };
    const [used] = await d.select({ id: payments.id }).from(payments).where(eq(payments.trxId, trxId));
    if (used) {
      await audit("agent", "payment.trx_reused", "match", matchId, { trxId });
      return { ok: false, error: "this transaction ID has already been used" };
    }
  } else if (!senderWalletNumber || !details?.trim()) {
    return { ok: false, error: "need the Transaction ID, or else the last 4 digits of the sending number and when it was sent" };
  }

  const open = await openPayment(matchId, phone);
  if (open) return { ok: false, error: `a payment for this match is already ${open.status}` };

  const [row] = await d.insert(payments).values({
    matchId, payerPhone: phone, senderWalletNumber, trxId, claimDetails: details?.trim().slice(0, 300) || null, amount: await getSetting<number>("price_bdt"),
  }).onConflictDoNothing().returning({ id: payments.id });
  if (!row) return { ok: false, error: "this transaction ID has already been used" }; // lost a race on a unique index
  await audit("agent", "payment.submitted", "payment", row.id, { matchId, withTrx: !!trxId });
  return { ok: true, paymentId: row.id, note: await msg("payment_claim_received") };
}

/** Admin action. The atomic status change means a double click cannot verify twice. */
export async function verifyPayment(paymentId: string, admin: string): Promise<boolean> {
  const [row] = await db().update(payments)
    .set({ status: "verified", verifiedBy: admin, verifiedAt: new Date() })
    .where(and(eq(payments.id, paymentId), eq(payments.status, "pending"))).returning();
  if (!row) return false;
  await audit(admin, "payment.verified", "payment", paymentId, { matchId: row.matchId });
  await inngest.send({ id: `payment-verified-${paymentId}`, name: "payment/verified", data: { matchId: row.matchId, phone: row.payerPhone, paymentId } });
  return true;
}

export async function rejectPayment(paymentId: string, admin: string, reason: string): Promise<boolean> {
  const [row] = await db().update(payments)
    .set({ status: "rejected", note: reason, verifiedBy: admin, verifiedAt: new Date() })
    .where(and(eq(payments.id, paymentId), eq(payments.status, "pending"))).returning();
  if (!row) return false;
  await audit(admin, "payment.rejected", "payment", paymentId, { reason });
  await sendToUser(row.payerPhone, await msg("payment_rejected", { reason }), { dedupeKey: `payreject-${paymentId}`, template: "payment_reminder", templateParams: [reason], deferOnFailure: true });
  return true;
}

export async function verifiedPayers(matchId: string): Promise<string[]> {
  const rows = await db().select({ phone: payments.payerPhone }).from(payments)
    .where(and(eq(payments.matchId, matchId), eq(payments.status, "verified")));
  return rows.map((r) => r.phone);
}

/** The ONLY place one user's number is sent to another. Each direction is delivered at most once. */
export async function releaseContact(match: Match, to: string) {
  const [other] = await db().select({ contactPhone: schema.users.contactPhone, verified: schema.users.contactPhoneVerified })
    .from(schema.users).where(eq(schema.users.phone, otherParty(match, to)));
  // Matching only pairs people with checked numbers, so this is a data problem for a human, not a retry.
  if (!other?.contactPhone || !other.verified) throw new Error(`match ${match.id}: counterparty has no verified contact number`);
  const number = other.contactPhone;
  await sendToUser(to, await msg("contact_release", { phone: number }), {
    dedupeKey: `release-${match.id}-${to}`, template: "contact_release", templateParams: [number], deferOnFailure: true,
  });
  await audit("system", "contact.released", "match", match.id, { direction: match.userA === to ? "b_to_a" : "a_to_b" });
}

/**
 * Idempotent reaction to a verified payment: the payer gets the other side's number, and the other side is told.
 * Only the payer's direction is released; the other side can still pay for theirs.
 */
export async function settleVerifiedPayment(matchId: string, phone: string) {
  const match = await getMatch(matchId);
  if (!match) return;
  if (!(await verifiedPayers(matchId)).includes(phone)) return;
  if (PAYABLE_STATES.includes(match.state)) {
    if (match.state === "both_interested") await transition(matchId, "contact_released", "system");
    await releaseContact(match, phone);
    const other = otherParty(match, phone);
    await sendToUser(other, await msg("number_shared_notice"), { dedupeKey: `shared-${matchId}-${other}`, template: "contact_release", deferOnFailure: true });
    // They are talking to someone now: no new proposals until they say they want more.
    await db().update(schema.users).set({ matchingPaused: true, updatedAt: new Date() }).where(eq(schema.users.phone, phone));
    await inngest.send({ id: `released-${matchId}-${phone}`, name: "contact/released", data: { matchId, phone } });
  } else {
    await db().insert(schema.escalations).values({
      phone, kind: "refund", matchId, reason: `Payment verified after the match closed as ${match.state}. Decide refund.`,
    });
  }
}

/** A match where both sides are interested but nobody paid in time. Returns false when a payment is in hand. */
export async function hasOpenPayments(matchId: string): Promise<boolean> {
  const rows = await db().select({ id: payments.id }).from(payments)
    .where(and(eq(payments.matchId, matchId), inArray(payments.status, ["pending", "verified"])));
  return rows.length > 0;
}

export const pendingPaymentsForUser = (phone: string) =>
  db().select({ matchId: payments.matchId, status: payments.status, amount: payments.amount, note: payments.note })
    .from(payments).where(and(eq(payments.payerPhone, phone), inArray(payments.status, ["pending", "rejected", "verified"])));
