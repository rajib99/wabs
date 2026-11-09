import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/lib/db";
import { advanceMatch, cardFields, closeMatch, getMatch, isVisibleTo, matchCardText, respondToMatch, TRANSITIONS, transition, visibleMatches } from "@/lib/matches";
import { approvedPhoto, isExplicitYes, requestPhoto, respondToPhotoRequest } from "@/lib/photos";
import { getStorage } from "@/lib/storage";
import { makeMatch, makeUser, outbound, sentEvents } from "./helpers";

const A = "+8801711000201";
const B = "+8801711000202";
const pair = async () => { await makeUser(A, "male"); await makeUser(B, "female"); };

describe("state machine", () => {
  it("refuses transitions that are not in the table", async () => {
    await pair();
    const m = await makeMatch(A, B, "proposed");
    expect(await transition(m.id, "payment_pending", "t")).toBe(false);
    expect((await getMatch(m.id))!.state).toBe("proposed");
    expect(TRANSITIONS.contact_released).toEqual([]);
  });
  it("records timestamps, emits a deduped event, and is safe to repeat", async () => {
    await pair();
    const m = await makeMatch(A, B, "proposed");
    expect(await transition(m.id, "shown_to_a", "t")).toBe(true);
    expect(await transition(m.id, "shown_to_a", "t")).toBe(true);
    const row = await getMatch(m.id);
    expect(row!.stateTimestamps.shown_to_a).toBeTruthy();
    const ev = sentEvents().filter((e) => e.name === "match/state.changed");
    expect(ev.map((e) => e.id)).toEqual([`match-${m.id}-shown_to_a`, `match-${m.id}-shown_to_a`]);
  });
  it("walks the happy path through advanceMatch and respondToMatch", async () => {
    await pair();
    const m = await makeMatch(A, B, "proposed");
    await advanceMatch(m.id, "proposed");
    expect((await getMatch(m.id))!.state).toBe("shown_to_a");
    expect((await outbound(A))[0]).toContain("আগ্রহী");
    expect(await outbound(B)).toHaveLength(0);

    expect((await respondToMatch(A, m.id, "interested")).ok).toBe(true);
    await advanceMatch(m.id, "a_interested");
    expect((await getMatch(m.id))!.state).toBe("shown_to_b");
    expect(await outbound(B)).toHaveLength(1);

    await respondToMatch(B, m.id, "interested");
    await advanceMatch(m.id, "b_interested");
    expect((await getMatch(m.id))!.state).toBe("both_interested");
    await advanceMatch(m.id, "both_interested");
    expect(sentEvents().some((e) => e.name === "match/both_interested")).toBe(true);
  });
});

describe("visibility and privacy", () => {
  it("b cannot see or act on a match before it is shown to them", async () => {
    await pair();
    const m = await makeMatch(A, B, "shown_to_a");
    expect(isVisibleTo(m, B)).toBe(false);
    expect(await visibleMatches(B)).toHaveLength(0);
    expect(await respondToMatch(B, m.id, "interested")).toMatchObject({ ok: false });
    expect(await respondToMatch(B, m.id, "decline")).toMatchObject({ ok: false });
  });
  it("a stranger cannot act on or see a match", async () => {
    await pair(); await makeUser("+8801711000299", "male");
    const m = await makeMatch(A, B, "shown_to_b");
    expect(await respondToMatch("+8801711000299", m.id, "interested")).toMatchObject({ ok: false });
    expect(await requestPhoto("+8801711000299", m.id)).toMatchObject({ ok: false });
  });
  it("the card has no name or phone, and strips contact details typed into free text", async () => {
    await makeUser(A, "male", { name: "গোপন-নাম", profession: "ব্যবসায়ী, কল করুন 01712345678", family_details: "ইমেইল me@x.com, নম্বর ০১৭১২৩৪৫৬৭৮" });
    const fields = await cardFields(A);
    const card = await matchCardText(A, 88);
    expect(card).not.toContain("গোপন-নাম");
    expect(card).not.toContain("01712345678");
    expect(card).not.toContain("০১৭১২৩৪৫৬৭৮");
    expect(card).not.toContain("me@x.com");
    expect(card).not.toContain(A);
    expect(fields.family).toContain("[গোপন]");
    expect(card).toContain("৮৮%");
  });
});

describe("decline and expiry", () => {
  it("decline and expiry send the other party the identical neutral text", async () => {
    await pair(); await makeUser("+8801711000203", "female");
    const declined = await makeMatch(A, B, "shown_to_b");
    await respondToMatch(B, declined.id, "decline");
    const expired = await makeMatch(A, "+8801711000203", "shown_to_b");
    await closeMatch(expired.id, "expired", "system", "no_response");
    const texts = await outbound(A);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(texts[1]);
    expect(await outbound(B)).toHaveLength(0); // the decliner gets the agent's reply instead
  });
  it("b is not told about a match that a declined before b saw it", async () => {
    await pair();
    const m = await makeMatch(A, B, "shown_to_a");
    await respondToMatch(A, m.id, "decline");
    expect(await outbound(B)).toHaveLength(0);
  });
  it("expiry guarded by onlyFrom does not overwrite a newer state", async () => {
    await pair();
    const m = await makeMatch(A, B, "a_interested");
    expect(await closeMatch(m.id, "expired", "system", "no_response", undefined, "shown_to_a")).toBe(false);
    expect((await getMatch(m.id))!.state).toBe("a_interested");
  });
});

describe("photo consent", () => {
  const withPhoto = async (phone: string) => {
    await getStorage().put(`t/${phone}.jpg`, new Uint8Array([1, 2, 3]), "image/jpeg");
    await db().insert(schema.photos).values({ phone, r2Key: `t/${phone}.jpg`, ownerConfirmedAt: new Date(), approvedByAdmin: true });
  };
  it("recognises explicit yes only", () => {
    for (const y of ["হ্যাঁ", "জি পাঠান", "ঠিক আছে", "yes", "রাজি"]) expect(isExplicitYes(y)).toBe(true);
    for (const n of ["না", "ঠিক আছে না", "হ্যাঁ না মানে না", "পরে দেখি", "no"]) expect(isExplicitYes(n)).toBe(false);
  });
  it("sends only after an explicit yes from the owner", async () => {
    await pair(); await withPhoto(B);
    const m = await makeMatch(A, B, "shown_to_b");
    expect(await requestPhoto(A, m.id)).toMatchObject({ ok: true });
    const [req] = await db().select().from(schema.photoRequests);
    expect(req!.status).toBe("pending");
    expect((await outbound(B)).at(-1)).toContain("অনুমতি");

    // The model claiming allow=true without a user yes is refused.
    expect(await respondToPhotoRequest(B, req!.id, true, "পরে দেখি")).toMatchObject({ ok: false });
    let images = await db().select().from(schema.messages).where(eq(schema.messages.type, "image"));
    expect(images).toHaveLength(0);

    // A third party cannot answer for the owner.
    expect(await respondToPhotoRequest(A, req!.id, true, "হ্যাঁ")).toMatchObject({ ok: false });

    expect(await respondToPhotoRequest(B, req!.id, true, "হ্যাঁ দিন")).toMatchObject({ ok: true });
    images = await db().select().from(schema.messages).where(eq(schema.messages.type, "image"));
    expect(images).toHaveLength(1);
    expect(images[0]!.phone).toBe(A);
  });
  it("a no is relayed politely and nothing is sent", async () => {
    await pair(); await withPhoto(B);
    const m = await makeMatch(A, B, "shown_to_b");
    await requestPhoto(A, m.id);
    const [req] = await db().select().from(schema.photoRequests);
    await respondToPhotoRequest(B, req!.id, false, "না");
    expect((await db().select().from(schema.messages).where(eq(schema.messages.type, "image")))).toHaveLength(0);
    expect((await outbound(A)).at(-1)).toContain("রাজি হননি");
  });
  it("unapproved photos are never shared", async () => {
    await pair();
    await db().insert(schema.photos).values({ phone: B, r2Key: "t/x.jpg", ownerConfirmedAt: new Date(), approvedByAdmin: null });
    expect(await approvedPhoto(B)).toBeUndefined();
    const m = await makeMatch(A, B, "shown_to_b");
    await requestPhoto(A, m.id);
    const [req] = await db().select().from(schema.photoRequests);
    expect(req!.status).toBe("no_photo");
  });
});
