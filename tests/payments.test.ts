import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildContext } from "@/lib/conversation/context";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/lib/db";
import { getMatch, requestNumber, respondToMatch } from "@/lib/matches";
import { rejectPayment, sendNumberPaymentInstructions, settleVerifiedPayment, submitPayment, verifyPayment } from "@/lib/payments";
import { setSetting } from "@/lib/settings";
import { makeMatch, makeUser, outbound, sentEvents } from "./helpers";

const A = "+8801711000301";
const B = "+8801711000302";
const setup = async (state = "both_interested") => { await makeUser(A, "male"); await makeUser(B, "female"); return makeMatch(A, B, state); };
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
    expect(p).toMatchObject({ senderWalletNumber: "5678", trxId: "ABCD123456", amount: 297, status: "pending" });
    expect(JSON.stringify(p)).not.toContain("01712345678");
  });
  it("a Transaction ID alone is enough", async () => {
    const m = await setup();
    expect(await submitPayment(A, m.id, undefined, "ABCD123456")).toMatchObject({ ok: true });
    expect((await db().select().from(schema.payments))[0]!.senderWalletNumber).toBeNull();
  });
  it("without a Transaction ID, needs the last 4 digits and when it was sent", async () => {
    const m = await setup();
    expect(await submitPayment(A, m.id, "5678", undefined)).toMatchObject({ ok: false });
    expect(await submitPayment(A, m.id, undefined, undefined, "আজ সকাল ১০টায়")).toMatchObject({ ok: false });
    const res = await submitPayment(A, m.id, "01712345678", undefined, "আজ সকাল ১০টায় ২৯৭ টাকা");
    expect(res).toMatchObject({ ok: true });
    const [p] = await db().select().from(schema.payments);
    expect(p).toMatchObject({ trxId: null, senderWalletNumber: "5678", claimDetails: "আজ সকাল ১০টায় ২৯৭ টাকা" });
    // The reply promises a check first, then the number.
    if (res.ok) expect(res.note).toContain("যাচাই");
  });
  it("rejects reused IDs, across users and matches, and double submission", async () => {
    const m = await setup();
    await pay(m.id, A, "ABCD123456");
    expect(await submitPayment(B, m.id, "01712345678", "ABCD123456")).toMatchObject({ ok: false, error: expect.stringContaining("used") });
    expect(await submitPayment(A, m.id, "01712345678", "ZZZZ999999")).toMatchObject({ ok: false, error: expect.stringContaining("already") });
  });
  it("refuses strangers, and payment before the other side has agreed", async () => {
    for (const state of ["shown_to_a", "a_interested", "offered_to_b", "shown_to_b"]) {
      const m = await setup(state);
      expect(await submitPayment(A, m.id, "01712345678", "ABCD123456"), state).toMatchObject({ ok: false });
      await db().delete(schema.users);
    }
    const m = await setup();
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
  it("nothing is released for a claim the admin has not approved", async () => {
    const m = await setup();
    await pay(m.id, A, "ABCD123456");
    await settleVerifiedPayment(m.id, A);
    expect(await allOut(A)).not.toContain(B);
    expect((await getMatch(m.id))!.state).toBe("both_interested");
  });
  it("approval sends the payer the other's contact number, once, and tells the other side", async () => {
    const m = await setup();
    await db().update(schema.users).set({ contactPhone: "+8801999000111" }).where(eq(schema.users.phone, B));
    await verifyPayment(await pay(m.id, A, "ABCD123456"), "admin@x");
    await settleVerifiedPayment(m.id, A);
    await settleVerifiedPayment(m.id, A);
    expect((await outbound(A)).filter((t) => t.includes("+8801999000111"))).toHaveLength(1);
    expect(await allOut(B)).not.toContain(A); // only the payer's direction
    expect(await allOut(B)).toContain("আপনার ফোন নম্বর নিয়েছেন");
    expect((await getMatch(m.id))!.state).toBe("contact_released");
    expect(sentEvents().filter((e) => e.name === "contact/released")).toHaveLength(2); // deduped by id in Inngest
    expect(sentEvents().find((e) => e.name === "contact/released")!.id).toBe(`released-${m.id}-${A}`);
    // The payer gets no new proposals until they ask for more.
    const [payer] = await db().select().from(schema.users).where(eq(schema.users.phone, A));
    expect(payer!.matchingPaused).toBe(true);
  });
  it("after one side got the number, the other side can still pay for theirs", async () => {
    const m = await setup();
    await verifyPayment(await pay(m.id, A, "ABCD123456"), "admin@x");
    await settleVerifiedPayment(m.id, A);
    const open = async (phone: string) => (await buildContext(phone, randomUUID(), "x")).context.active_matches[0]?.payment_open;
    expect(await open(B)).toBe(true);
    expect(await open(A)).toBe(false);
    await verifyPayment(await pay(m.id, B, "EFGH123456"), "admin@x");
    await settleVerifiedPayment(m.id, B);
    expect(await allOut(B)).toContain(A);
  });
  it("a decline with a claim in hand raises a refund escalation and releases nothing", async () => {
    const m = await setup();
    const id = await pay(m.id, A, "ABCD123456");
    await respondToMatch(B, m.id, "decline");
    await verifyPayment(id, "admin@x");
    await settleVerifiedPayment(m.id, A);
    expect(await allOut(A)).not.toContain(B);
    const refunds = await db().select().from(schema.escalations).where(eq(schema.escalations.kind, "refund"));
    expect(refunds.length).toBeGreaterThanOrEqual(1);
    expect(refunds.every((e) => e.phone === A)).toBe(true);
  });
  it("instructions use amount and number from settings, and refuse an empty number", async () => {
    const m = await setup();
    await setSetting("price_bdt", 450);
    await sendNumberPaymentInstructions(m.id, A);
    expect(await allOut(A)).toContain("450");
    expect(await allOut(A)).toContain("01700000000");
    await setSetting("bkash_number", "");
    await expect(sendNumberPaymentInstructions(m.id, B)).rejects.toThrow(/bkash_number/);
  });
});

describe("asking for the number", () => {
  it("before the other side has agreed, a's request asks b first and no payment details go out", async () => {
    const m = await setup("shown_to_a");
    expect(await requestNumber(A, m.id)).toMatchObject({ ok: true, state: "a_interested" });
    expect(await allOut(A)).not.toContain("01700000000");
    expect((await getMatch(m.id))!.numberRequestedBy).toEqual([A]);
  });
  it("once both are interested, the payment details go to whoever asked", async () => {
    const m = await setup("both_interested");
    await requestNumber(A, m.id);
    await requestNumber(A, m.id);
    expect((await outbound(A)).filter((t) => t.includes("01700000000"))).toHaveLength(1);
    expect(await allOut(B)).not.toContain("01700000000");
  });
  it("cannot be asked before the details were opened", async () => {
    const m = await setup("offered_to_a");
    expect(await requestNumber(A, m.id)).toMatchObject({ ok: false });
  });
});
