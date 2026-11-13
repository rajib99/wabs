import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildContext } from "@/lib/conversation/context";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/lib/db";
import { getMatch, respondToMatch } from "@/lib/matches";
import { handleFirstPaymentTimeout, handleSecondPaymentTimeout, rejectPayment, sendPaymentInstructions, settleVerifiedPayment, submitPayment, verifyPayment } from "@/lib/payments";
import { setSetting } from "@/lib/settings";
import { makeMatch, makeUser, outbound, sentEvents } from "./helpers";

const A = "+8801711000301";
const B = "+8801711000302";
const setup = async (state = "payment_pending") => { await makeUser(A, "male"); await makeUser(B, "female"); return makeMatch(A, B, state); };
const allOut = async (p: string) => (await outbound(p)).join("\n");
const pay = async (matchId: string, phone: string, trx: string) => {
  const r = await submitPayment(phone, matchId, "01712345678", trx);
  if (!r.ok) throw new Error(r.error);
  return r.paymentId;
};

describe("submit_payment", () => {
  it("keeps only the last 4 digits of a wallet, never a full account number", async () => {
    const m = await setup();
    expect(await submitPayment(A, m.id, "12", "ABCD123456")).toMatchObject({ ok: false });
    expect(await submitPayment(A, m.id, undefined, "bad trx!")).toMatchObject({ ok: false });
    expect(await submitPayment(A, m.id, "০১৭১২৩৪৫৬৭৮", "abcd123456")).toMatchObject({ ok: true });
    const [p] = await db().select().from(schema.payments);
    expect(p).toMatchObject({ senderWalletNumber: "5678", trxId: "ABCD123456", amount: 300, status: "pending" });
    expect(JSON.stringify(p)).not.toContain("01712345678");
  });
  it("a Transaction ID alone is enough", async () => {
    const m = await setup();
    expect(await submitPayment(A, m.id, undefined, "ABCD123456")).toMatchObject({ ok: true });
    expect((await db().select().from(schema.payments))[0]!.senderWalletNumber).toBeNull();
  });
  it("releases the contact number, not the channel identity", async () => {
    const m = await setup();
    await db().update(schema.users).set({ contactPhone: "+8801999000111" }).where(eq(schema.users.phone, B));
    await verifyPayment(await pay(m.id, A, "ABCD123456"), "admin@x");
    await handleSecondPaymentTimeout(m.id, A);
    expect(await allOut(A)).toContain("+8801999000111");
  });
  it("rejects reused IDs, across users and matches, and double submission", async () => {
    const m = await setup();
    await pay(m.id, A, "ABCD123456");
    expect(await submitPayment(B, m.id, "01712345678", "ABCD123456")).toMatchObject({ ok: false, error: expect.stringContaining("used") });
    expect(await submitPayment(A, m.id, "01712345678", "ZZZZ999999")).toMatchObject({ ok: false, error: expect.stringContaining("already") });
  });
  it("refuses strangers and matches not open for payment", async () => {
    const m = await setup("shown_to_a");
    expect(await submitPayment(A, m.id, "01712345678", "ABCD123456")).toMatchObject({ ok: false });
    expect(await submitPayment("+8801711000399", m.id, "01712345678", "ABCD123456")).toMatchObject({ ok: false });
  });
  it("allows a new transaction after rejection, but not the rejected ID again", async () => {
    const m = await setup();
    const id = await pay(m.id, A, "ABCD123456");
    await rejectPayment(id, "admin@x", "টাকা পাওয়া যায়নি");
    expect((await allOut(A))).toContain("টাকা পাওয়া যায়নি");
    expect(await submitPayment(A, m.id, "01712345678", "ABCD123456")).toMatchObject({ ok: false });
    expect(await submitPayment(A, m.id, "01712345678", "EFGH123456")).toMatchObject({ ok: true });
  });
});

describe("verification", () => {
  it("emits payment/verified exactly once despite a double click", async () => {
    const m = await setup();
    const id = await pay(m.id, A, "ABCD123456");
    expect(await verifyPayment(id, "admin@x")).toBe(true);
    expect(await verifyPayment(id, "admin@x")).toBe(false);
    expect(sentEvents().filter((e) => e.name === "payment/verified")).toHaveLength(1);
    expect(await rejectPayment(id, "admin@x", "x")).toBe(false);
  });
});

describe("release rules", () => {
  it("no number leaves while only one side has been verified", async () => {
    const m = await setup();
    const id = await pay(m.id, A, "ABCD123456");
    await verifyPayment(id, "admin@x");
    await settleVerifiedPayment(m.id, A);
    expect(await allOut(A)).not.toContain(B);
    expect(await allOut(B)).not.toContain(A);
    expect((await getMatch(m.id))!.state).toBe("payment_pending");
  });
  it("two-sided: both numbers go to both, once, even if settled repeatedly", async () => {
    const m = await setup();
    await verifyPayment(await pay(m.id, A, "ABCD123456"), "admin@x");
    await verifyPayment(await pay(m.id, B, "EFGH123456"), "admin@x");
    await settleVerifiedPayment(m.id, A);
    await settleVerifiedPayment(m.id, B);
    await settleVerifiedPayment(m.id, B);
    expect((await getMatch(m.id))!.state).toBe("contact_released");
    expect((await outbound(A)).filter((t) => t.includes(B))).toHaveLength(1);
    expect((await outbound(B)).filter((t) => t.includes(A))).toHaveLength(1);
  });
  it("one-sided timeout: payer gets the number, the non-payer does not, and is told", async () => {
    const m = await setup();
    await verifyPayment(await pay(m.id, A, "ABCD123456"), "admin@x");
    expect(await handleSecondPaymentTimeout(m.id, A)).toBe("one_sided");
    expect(await allOut(A)).toContain(B);
    expect(await allOut(B)).not.toContain(A);
    expect(await allOut(B)).toContain("আপনার ফোন নম্বর পেমেন্টকারী");
    expect((await getMatch(m.id))!).toMatchObject({ state: "contact_released", closeReason: "one_sided_timeout" });
  });
  it("a late second payer still receives the first payer's number", async () => {
    const m = await setup();
    await verifyPayment(await pay(m.id, A, "ABCD123456"), "admin@x");
    await handleSecondPaymentTimeout(m.id, A);
    await verifyPayment(await pay(m.id, B, "EFGH123456"), "admin@x");
    await settleVerifiedPayment(m.id, B);
    expect(await allOut(B)).toContain(A);
  });
  it("after a one-sided release the non-payer can still pay, and the payer has nothing left to pay", async () => {
    const m = await setup();
    await verifyPayment(await pay(m.id, A, "ABCD123456"), "admin@x");
    await handleSecondPaymentTimeout(m.id, A);
    const open = async (phone: string) => (await buildContext(phone, randomUUID(), "x")).context.active_matches[0]?.payment_open;
    expect(await open(B)).toBe(true);
    expect(await open(A)).toBe(false);
  });
  it("timeout firing after both paid releases both instead of one-sided", async () => {
    const m = await setup();
    await verifyPayment(await pay(m.id, A, "ABCD123456"), "admin@x");
    await verifyPayment(await pay(m.id, B, "EFGH123456"), "admin@x");
    expect(await handleSecondPaymentTimeout(m.id, A)).toBe("both");
    expect(await allOut(A)).toContain(B);
    expect(await allOut(B)).toContain(A);
  });
  it("an explicit decline stops the release and raises a refund escalation", async () => {
    const m = await setup();
    await verifyPayment(await pay(m.id, A, "ABCD123456"), "admin@x");
    await respondToMatch(B, m.id, "decline");
    expect(await handleSecondPaymentTimeout(m.id, A)).toBe("noop");
    expect(await allOut(A)).not.toContain(B);
    const [e] = await db().select().from(schema.escalations).where(eq(schema.escalations.kind, "refund"));
    expect(e!.phone).toBe(A);
  });
  it("verification after the match closed asks a human rather than releasing", async () => {
    const m = await setup();
    const id = await pay(m.id, A, "ABCD123456");
    await respondToMatch(B, m.id, "decline");
    await verifyPayment(id, "admin@x");
    await settleVerifiedPayment(m.id, A);
    expect(await allOut(A)).not.toContain(B);
    expect(await db().select().from(schema.escalations)).toHaveLength(1);
  });
  it("first-payment timeout expires the match, unless someone did pay", async () => {
    const m = await setup();
    expect(await handleFirstPaymentTimeout(m.id)).toBe(true);
    expect((await getMatch(m.id))!.state).toBe("expired");
  });
  it("instructions use amount and number from settings, and refuse an empty number", async () => {
    const m = await setup();
    await setSetting("price_bdt", 450);
    await sendPaymentInstructions(m);
    expect(await allOut(A)).toContain("450");
    expect(await allOut(A)).toContain("01700000000");
    await setSetting("bkash_number", "");
    await expect(sendPaymentInstructions(m)).rejects.toThrow(/bkash_number/);
  });
});
