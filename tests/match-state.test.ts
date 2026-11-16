import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/lib/db";
import { advanceMatch, answerQuestion, askOtherParty, cardFields, closeMatch, getMatch, isVisibleTo, matchCardText, pastMatches, questionsFor, requestMoreMatches, requestNumber, respondToMatch, TRANSITIONS, transition, visibleMatches } from "@/lib/matches";
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
    expect(await transition(m.id, "both_interested", "t")).toBe(false);
    expect((await getMatch(m.id))!.state).toBe("proposed");
    expect(TRANSITIONS.contact_released).toEqual([]);
  });
  it("records timestamps, emits a deduped event, and is safe to repeat", async () => {
    await pair();
    const m = await makeMatch(A, B, "proposed");
    expect(await transition(m.id, "offered_to_a", "t")).toBe(true);
    expect(await transition(m.id, "offered_to_a", "t")).toBe(true);
    const row = await getMatch(m.id);
    expect(row!.stateTimestamps.offered_to_a).toBeTruthy();
    const ev = sentEvents().filter((e) => e.name === "match/state.changed");
    expect(ev.map((e) => e.id)).toEqual([`match-${m.id}-offered_to_a`, `match-${m.id}-offered_to_a`]);
  });
  it("walks the happy path: offer, consent, details, interest, the other side, then the number", async () => {
    await pair();
    const m = await makeMatch(A, B, "proposed");
    await advanceMatch(m.id, "proposed");
    expect((await getMatch(m.id))!.state).toBe("offered_to_a");
    // First only the question whether they want to see it: no details yet.
    const offer = (await outbound(A))[0]!;
    expect(offer).toContain("বিস্তারিত জানতে চান");
    expect(offer).not.toContain("পেশা");
    expect(await outbound(B)).toHaveLength(0);

    expect(await respondToMatch(A, m.id, "interested")).toMatchObject({ ok: false }); // must see it first
    expect((await respondToMatch(A, m.id, "see_details")).ok).toBe(true);
    expect((await getMatch(m.id))!.state).toBe("shown_to_a");
    const card = (await outbound(A)).at(-1)!;
    expect(card).toContain("পেশা");
    expect(card).toContain("জিজ্ঞেস");
    expect(card).not.toContain(B);

    expect((await respondToMatch(A, m.id, "interested")).ok).toBe(true);
    await advanceMatch(m.id, "a_interested");
    expect((await getMatch(m.id))!.state).toBe("offered_to_b");
    expect(await outbound(B)).toHaveLength(1);
    expect((await outbound(B))[0]).not.toContain("পেশা");

    await respondToMatch(B, m.id, "see_details");
    expect((await getMatch(m.id))!.state).toBe("shown_to_b");
    await respondToMatch(B, m.id, "interested");
    expect((await getMatch(m.id))!.state).toBe("both_interested");
    await advanceMatch(m.id, "both_interested");
    expect((await outbound(A)).at(-1)).toContain("সুখবর");
  });
  it("a's early number request gets the payment details as soon as b agrees", async () => {
    await pair();
    const m = await makeMatch(A, B, "shown_to_a");
    await requestNumber(A, m.id);
    await transition(m.id, "offered_to_b", "t");
    await respondToMatch(B, m.id, "see_details");
    await respondToMatch(B, m.id, "interested");
    await advanceMatch(m.id, "both_interested");
    expect((await outbound(A)).some((t) => t.includes("01700000000"))).toBe(true);
    expect((await outbound(B)).some((t) => t.includes("01700000000"))).toBe(false);
  });
});

describe("questions through BS", () => {
  it("a's question waits until b opens the details, then the answer comes back, without contact details", async () => {
    await pair();
    const m = await makeMatch(A, B, "shown_to_a");
    expect(await askOtherParty(A, m.id, "উনি কি রান্না করতে পারেন? আমার নম্বর 01712345678")).toMatchObject({ ok: true, state: "a_interested" });
    expect(await outbound(B)).toHaveLength(0); // b has not been asked about the match yet
    await transition(m.id, "offered_to_b", "t");
    await respondToMatch(B, m.id, "see_details");
    const delivered = (await outbound(B)).find((t) => t.includes("রান্না"))!;
    expect(delivered).toBeTruthy();
    expect(delivered).not.toContain("01712345678");

    const [q] = await questionsFor(B);
    expect(await answerQuestion(A, q!.id, "হ্যাঁ")).toMatchObject({ ok: false }); // only the other side answers
    expect(await answerQuestion(B, q!.id, "হ্যাঁ, ভালো রান্না করেন। কল দিন ০১৮১২৩৪৫৬৭৮")).toMatchObject({ ok: true });
    const answer = (await outbound(A)).at(-1)!;
    expect(answer).toContain("ভালো রান্না");
    expect(answer).not.toContain("০১৮১২৩৪৫৬৭৮");
    expect(await questionsFor(B)).toHaveLength(0);
  });
  it("a question to someone who already sees the match goes at once", async () => {
    await pair();
    const m = await makeMatch(A, B, "both_interested");
    await askOtherParty(B, m.id, "উনার অফিস কোথায়?");
    expect((await outbound(A)).at(-1)).toContain("অফিস");
  });
});

describe("past matches and the next one", () => {
  it("counts and lists every proposal sent, with details only for the ones opened", async () => {
    await pair(); await makeUser("+8801711000203", "female");
    const first = await makeMatch(A, B, "shown_to_a");
    await db().update(schema.matches).set({ state: "declined" }).where(eq(schema.matches.id, first.id)); // a said no
    await makeMatch(A, "+8801711000203", "offered_to_a");
    const past = await pastMatches(A);
    expect(past.total_sent).toBe(2);
    expect(past.matches[0]!.card).toContain("পেশা");
    expect(past.matches[1]!.card).toBeNull();
    expect((await pastMatches(B)).total_sent).toBe(0); // b was never asked
  });
  it("a decline asks the engine for the next proposal; asking for more resumes a paused person", async () => {
    await pair();
    const m = await makeMatch(A, B, "shown_to_a");
    await respondToMatch(A, m.id, "decline");
    expect(sentEvents().filter((e) => e.name === "matching/run").map((e) => e.data.phone)).toContain(A);
    await db().update(schema.users).set({ matchingPaused: true }).where(eq(schema.users.phone, A));
    await requestMoreMatches(A);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.phone, A));
    expect(u!.matchingPaused).toBe(false);
  });
});

describe("visibility and privacy", () => {
  it("b cannot see or act on a match before it is offered to them", async () => {
    await pair();
    const m = await makeMatch(A, B, "a_interested");
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
    for (const y of ["ha pathan", "thik ase", "ji pathiye din", "Haa"]) expect(isExplicitYes(y), y).toBe(true);
    for (const n of ["na", "thik ase na", "dibo na", "hahaha", "pore dekhi"]) expect(isExplicitYes(n), n).toBe(false);
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
  it("an owner who agreed in advance has the photo sent at once, without being asked", async () => {
    await makeUser(A, "male"); await makeUser(B, "female", {}, { photoShareConsent: true });
    await withPhoto(B);
    const m = await makeMatch(A, B, "shown_to_b");
    expect(await requestPhoto(A, m.id)).toMatchObject({ ok: true });
    const [req] = await db().select().from(schema.photoRequests);
    expect(req!.status).toBe("approved");
    expect(await outbound(B)).toHaveLength(0);
    const images = await db().select().from(schema.messages).where(eq(schema.messages.type, "image"));
    expect(images.map((i) => i.phone)).toEqual([A]);
  });
  it("advance consent never releases a photo the admin has not approved", async () => {
    await makeUser(A, "male"); await makeUser(B, "female", {}, { photoShareConsent: true });
    await db().insert(schema.photos).values({ phone: B, r2Key: "t/y.jpg", ownerConfirmedAt: new Date(), approvedByAdmin: null });
    const m = await makeMatch(A, B, "shown_to_b");
    await requestPhoto(A, m.id);
    expect((await db().select().from(schema.photoRequests))[0]!.status).toBe("no_photo");
    expect(await db().select().from(schema.messages).where(eq(schema.messages.type, "image"))).toHaveLength(0);
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
