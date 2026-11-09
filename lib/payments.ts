import { and, eq, inArray, ne } from "drizzle-orm";
import { inngest } from "@/inngest/client";
import { audit } from "@/lib/audit";
import { sendToUser } from "@/lib/conversation/outbound";
import { db, schema } from "@/lib/db";
import { closeMatch, getMatch, type Match, otherParty, transition } from "@/lib/matches";
import { getSetting, msg } from "@/lib/settings";
import { normalizeWalletNumber, toAsciiDigits } from "@/lib/text";

const { payments } = schema;

export async function paymentInfo() {
  const [amount, bkash_number] = await Promise.all([getSetting<number>("price_bdt"), getSetting<string>("bkash_number")]);
  return { amount, bkash_number };
}

export async function sendPaymentInstructions(match: Match) {
  const info = await paymentInfo();
  if (!info.bkash_number) throw new Error("settings.bkash_number is empty: set it in the admin panel");
  const text = await msg("payment_request", info);
  for (const phone of [match.userA, match.userB]) {
    await sendToUser(phone, text, { dedupeKey: `payreq-${match.id}-${phone}`, template: "payment_reminder" });
  }
}

export type SubmitResult = { ok: true; paymentId: string; note: string } | { ok: false; error: string };

export async function submitPayment(phone: string, matchId: string, wallet: string, trx: string): Promise<SubmitResult> {
  const d = db();
  const match = await getMatch(matchId);
  if (!match || (match.userA !== phone && match.userB !== phone)) return { ok: false, error: "match not found" };
  if (match.state !== "payment_pending" && match.state !== "contact_released") return { ok: false, error: "payment is not open for this match" };

  const senderWalletNumber = normalizeWalletNumber(wallet);
  if (!senderWalletNumber) return { ok: false, error: "invalid wallet number: must be a Bangladeshi number like 01XXXXXXXXX" };

  const trxId = toAsciiDigits(trx).trim().toUpperCase();
  const pattern = await getSetting<string>("trx_id_pattern");
  if (!new RegExp(pattern).test(trxId)) return { ok: false, error: "invalid transaction ID format" };

  const [used] = await d.select({ id: payments.id }).from(payments).where(eq(payments.trxId, trxId));
  if (used) {
    await audit("agent", "payment.trx_reused", "match", matchId, { trxId });
    return { ok: false, error: "this transaction ID has already been used" };
  }
  const [open] = await d.select({ status: payments.status }).from(payments)
    .where(and(eq(payments.matchId, matchId), eq(payments.payerPhone, phone), ne(payments.status, "rejected")));
  if (open) return { ok: false, error: `a payment for this match is already ${open.status}` };

  const [row] = await d.insert(payments).values({
    matchId, payerPhone: phone, senderWalletNumber, trxId, amount: await getSetting<number>("price_bdt"),
  }).onConflictDoNothing().returning({ id: payments.id });
  if (!row) return { ok: false, error: "this transaction ID has already been used" }; // lost a race on the unique index
  await audit("agent", "payment.submitted", "payment", row.id, { matchId });
  return { ok: true, paymentId: row.id, note: await msg("payment_received") };
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
  await sendToUser(row.payerPhone, await msg("payment_rejected", { reason }), { dedupeKey: `payreject-${paymentId}`, template: "payment_reminder", deferOnFailure: true });
  return true;
}

export async function verifiedPayers(matchId: string): Promise<string[]> {
  const rows = await db().select({ phone: payments.payerPhone }).from(payments)
    .where(and(eq(payments.matchId, matchId), eq(payments.status, "verified")));
  return rows.map((r) => r.phone);
}

/** The ONLY place one user's number is sent to another. Each direction is delivered at most once. */
export async function releaseContact(match: Match, to: string) {
  const number = otherParty(match, to);
  await sendToUser(to, await msg("contact_release", { phone: number }), { dedupeKey: `release-${match.id}-${to}`, template: "contact_release" });
  await audit("system", "contact.released", "match", match.id, { direction: match.userA === to ? "b_to_a" : "a_to_b" });
}

/**
 * Idempotent reaction to any verified payment: release when both have paid, or fulfil a late payer
 * after a one-sided release. Runs independently of the waiting flow so simultaneous verifies cannot be missed.
 */
export async function settleVerifiedPayment(matchId: string, phone: string) {
  const match = await getMatch(matchId);
  if (!match) return;
  if (match.state === "payment_pending") {
    const paid = await verifiedPayers(matchId);
    if (paid.includes(match.userA) && paid.includes(match.userB)) {
      await transition(matchId, "contact_released", "system");
      await releaseContact(match, match.userA);
      await releaseContact(match, match.userB);
    }
  } else if (match.state === "contact_released") {
    await releaseContact(match, phone);
  } else if (match.state === "declined" || match.state === "expired") {
    await db().insert(schema.escalations).values({
      phone, kind: "refund", matchId, reason: `Payment verified after the match closed as ${match.state}. Decide refund.`,
    });
  }
}

/** First-payment deadline passed. Returns false when a payment arrived after all. */
export async function handleFirstPaymentTimeout(matchId: string): Promise<boolean> {
  if ((await verifiedPayers(matchId)).length > 0) return false;
  await closeMatch(matchId, "expired", "system", "no_payment");
  return true;
}

export async function notifyAfterFirstPayment(match: Match, payer: string) {
  const info = await paymentInfo();
  await sendToUser(payer, await msg("payment_verified_waiting"), { dedupeKey: `paywait-${match.id}-${payer}`, template: "payment_reminder" });
  const other = otherParty(match, payer);
  const paid = await verifiedPayers(match.id);
  if (!paid.includes(other)) {
    await sendToUser(other, await msg("payment_reminder_other", info), { dedupeKey: `payremind-${match.id}-${other}`, template: "payment_reminder" });
  }
}

/** Second-payment deadline passed: one-sided release of the other number to the payer only, unless closed or fully paid. */
export async function handleSecondPaymentTimeout(matchId: string, payer: string) {
  const match = await getMatch(matchId);
  if (!match || match.state !== "payment_pending") return "noop";
  const paid = await verifiedPayers(matchId);
  if (paid.includes(match.userA) && paid.includes(match.userB)) {
    await settleVerifiedPayment(matchId, payer);
    return "both";
  }
  await transition(matchId, "contact_released", "system", { closeReason: "one_sided_timeout" });
  await releaseContact(match, payer);
  const other = otherParty(match, payer);
  await sendToUser(other, await msg("contact_shared_notice"), { dedupeKey: `shared-${matchId}-${other}`, template: "contact_release" });
  await audit("system", "contact.one_sided_release", "match", matchId);
  return "one_sided";
}

export const pendingPaymentsForUser = (phone: string) =>
  db().select({ matchId: payments.matchId, status: payments.status, amount: payments.amount, note: payments.note })
    .from(payments).where(and(eq(payments.payerPhone, phone), inArray(payments.status, ["pending", "rejected", "verified"])));
