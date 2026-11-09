import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { audit } from "@/lib/audit";
import { mockMediaKey } from "@/lib/channel/mock";
import { ingestPayload } from "@/lib/conversation/ingest";
import { inServiceWindow, sendToUser } from "@/lib/conversation/outbound";
import { handleImage, preflight, storeMedia, transcribeMessage } from "@/lib/conversation/pipeline";
import { db, schema } from "@/lib/db";
import { getMatch } from "@/lib/matches";
import { confirmProfilePhoto } from "@/lib/photos";
import { eraseUser, guardReply, isStopCommand, parseAgeGate, parseYesNo } from "@/lib/safety";
import { setSetting } from "@/lib/settings";
import { getStorage } from "@/lib/storage";
import { inbound, makeMatch, makeUser, outbound, sentEvents } from "./helpers";

const P = "+8801711000501";
const payloadMsg = (id: string, text: string, phone = P) => ({
  messages: [{ waMessageId: id, phone, type: "text" as const, text, timestamp: new Date() }], statuses: [],
});
const user = async (phone = P) => (await db().select().from(schema.users).where(eq(schema.users.phone, phone)))[0];

describe("ingest", () => {
  it("dedupes redelivery: one row, event re-sent with the same id only until processed", async () => {
    await ingestPayload(payloadMsg("w1", "হাই"));
    await ingestPayload(payloadMsg("w1", "হাই"));
    expect(await db().select().from(schema.messages)).toHaveLength(1);
    const ev = sentEvents().filter((e) => e.name === "wa/message.received");
    expect(new Set(ev.map((e) => e.id))).toEqual(new Set(["wa-w1"]));
    await db().update(schema.messages).set({ processedAt: new Date() });
    const before = sentEvents().length;
    await ingestPayload(payloadMsg("w1", "হাই"));
    expect(sentEvents().length).toBe(before);
  });
  it("tracks the 24-hour window from inbound timestamps", async () => {
    await ingestPayload(payloadMsg("w2", "হাই"));
    expect(inServiceWindow((await user())!.lastInboundAt)).toBe(true);
    expect(inServiceWindow(new Date(Date.now() - 25 * 3600 * 1000))).toBe(false);
    expect(inServiceWindow(null)).toBe(false);
  });
  it("stores delivery and read statuses and never moves them backwards", async () => {
    await makeUser(P, "male");
    await db().insert(schema.messages).values({ phone: P, direction: "outbound", type: "text", rawText: "x", waMessageId: "out1", status: "sent" });
    const st = (status: "delivered" | "read" | "failed") => ({ messages: [], statuses: [{ waMessageId: "out1", status, timestamp: new Date() }] });
    await ingestPayload(st("read"));
    await ingestPayload(st("delivered"));
    const [m] = await db().select().from(schema.messages).where(eq(schema.messages.waMessageId, "out1"));
    expect(m!.status).toBe("read");
  });
});

describe("24-hour window on outbound", () => {
  it("skips free text outside the window when no template is set, and uses one when it is", async () => {
    await makeUser(P, "male", {}, { lastInboundAt: new Date(Date.now() - 48 * 3600 * 1000) });
    expect(await sendToUser(P, "কার্ড", { dedupeKey: "a", template: "match_intro" })).toBe("skipped_window");
    await setSetting("templates", { match_intro: "bs_match_intro" });
    expect(await sendToUser(P, "কার্ড", { dedupeKey: "b", template: "match_intro" })).toBe("sent");
    const rows = await db().select().from(schema.messages).orderBy(schema.messages.createdAt);
    expect(rows.map((r) => [r.type, r.status])).toEqual([["text", "skipped_window"], ["template", "sent"]]);
  });
  it("dedupe key delivers once across retries", async () => {
    await makeUser(P, "male");
    expect(await sendToUser(P, "x", { dedupeKey: "k" })).toBe("sent");
    expect(await sendToUser(P, "x", { dedupeKey: "k" })).toBe("duplicate");
    expect(await outbound(P)).toHaveLength(1);
  });
});

describe("age gate and consent", () => {
  it("parsers", () => {
    expect(parseAgeGate("হ্যাঁ", 18)).toBe("adult");
    expect(parseAgeGate("না", 18)).toBe("minor");
    expect(parseAgeGate("আমার বয়স ১৬", 18)).toBe("minor");
    expect(parseAgeGate("২২", 18)).toBe("adult");
    expect(parseAgeGate("18", 18)).toBe("adult");
    expect(parseAgeGate("কী?", 18)).toBe("unclear");
    expect(parseYesNo("জি না")).toBe("no");
    expect(parseYesNo("রাজি")).toBe("yes");
    expect(parseYesNo("পরে দেখি")).toBe("unclear");
  });
  const step = async (text: string) => { const m = await inbound(P, text); return { action: await preflight(m.id), id: m.id }; };

  it("walks new → age → consent → active, keeping no pre-consent text", async () => {
    expect((await step("আসসালামু আলাইকুম আমি করিম, ফোন ০১৭১১")).action).toBe("done");
    expect((await user())!.status).toBe("awaiting_age");
    expect((await outbound(P))[0]).toContain("১৮");
    await step("হ্যাঁ");
    expect((await user())!.status).toBe("awaiting_consent");
    expect((await outbound(P)).at(-1)).toContain("STOP");
    await step("হ্যাঁ");
    const u = await user();
    expect(u!.status).toBe("active");
    expect(u!.consentAt).toBeTruthy();
    const kept = await db().select().from(schema.messages).where(eq(schema.messages.direction, "inbound"));
    expect(kept.filter((m) => m.rawText?.includes("করিম"))).toHaveLength(0);
    expect((await outbound(P)).at(-1)).toContain("নাম");
    expect((await step("করিম")).action).toBe("agent");
  });
  it("an under-18 answer stops everything and later messages get silence", async () => {
    await step("হাই");
    await step("না");
    const u = await user();
    expect(u).toMatchObject({ status: "ended_underage", blocked: true });
    expect(await db().select().from(schema.messages)).toHaveLength(0);
    expect((await step("আমার বয়স ২৫")).action).toBe("done");
    expect(await db().select().from(schema.messages)).toHaveLength(0);
  });
  it("declining consent stores nothing and can restart later", async () => {
    await step("হাই"); await step("হ্যাঁ"); await step("না");
    expect((await user())!.status).toBe("consent_declined");
    await step("আবার শুরু");
    expect((await user())!.status).toBe("awaiting_age");
  });
  it("voice before consent is not downloaded", async () => {
    await step("হাই");
    const m = await inbound(P, "", "voice", { mediaId: "v1" });
    expect(await preflight(m.id)).toBe("done");
    expect((await outbound(P)).at(-1)).toContain("লিখে");
  });
});

describe("rate limit", () => {
  it("over the limit gets one notice and no agent run", async () => {
    await makeUser(P, "male");
    await setSetting("rate_limit_per_minute", 2);
    const actions = [];
    for (let i = 0; i < 5; i++) { const m = await inbound(P, `x${i}`); actions.push(await preflight(m.id)); }
    expect(actions).toEqual(["agent", "agent", "done", "done", "done"]);
    expect((await outbound(P)).filter((t) => t.includes("দ্রুত"))).toHaveLength(1);
  });
});

describe("media", () => {
  const SAMPLE = new Uint8Array([9, 9, 9]);
  const voice = async (bytes = SAMPLE) => {
    await getStorage().put(mockMediaKey("media1"), bytes, "audio/ogg");
    return inbound(P, "", "voice", { mediaId: "media1", rawText: null });
  };
  it("rejects files over the limit politely", async () => {
    await makeUser(P, "male");
    await setSetting("max_media_bytes", 2);
    const m = await voice();
    expect(await storeMedia(m.id, "voice")).toBe(false);
    expect((await outbound(P))[0]).toContain("১৬");
    expect((await db().select().from(schema.messages).where(eq(schema.messages.id, m.id)))[0]!.mediaKey).toBeNull();
  });
  it("stores voice privately, and an unintelligible transcript asks to retype", async () => {
    await makeUser(P, "male");
    const m = await voice();
    expect(await storeMedia(m.id, "voice")).toBe(true);
    const [row] = await db().select().from(schema.messages).where(eq(schema.messages.id, m.id));
    expect(row!.mediaKey).toMatch(/^voice\//);
    expect((await getStorage().get(row!.mediaKey!)).mime).toBe("audio/ogg");
    expect(await transcribeMessage(m.id)).toBe(false); // not in the manifest → empty text
  });
  it("uses the sample transcript and logs usage seconds", async () => {
    await makeUser(P, "male");
    const bytes = new Uint8Array(readFileSync("samples/voice/01.ogg"));
    const m = await voice(bytes);
    await storeMedia(m.id, "voice");
    expect(await transcribeMessage(m.id)).toBe(true);
    const [row] = await db().select().from(schema.messages).where(eq(schema.messages.id, m.id));
    expect(row!.transcript).toBeTruthy();
    expect(row!.usageSeconds).toBeGreaterThan(0);
  });
  it("image: stored, asks the owner, pending admin approval", async () => {
    await makeUser(P, "male");
    await getStorage().put(mockMediaKey("img1"), new Uint8Array([1]), "image/jpeg");
    const m = await inbound(P, "", "image", { mediaId: "img1" });
    await storeMedia(m.id, "photos");
    await handleImage(m.id);
    await handleImage(m.id);
    const photos = await db().select().from(schema.photos);
    expect(photos).toHaveLength(1);
    expect(photos[0]!.approvedByAdmin).toBeNull();
    expect((await outbound(P))).toHaveLength(1);
    expect(await confirmProfilePhoto(P, true)).toMatchObject({ ok: true });
    expect((await db().select().from(schema.photos))[0]!.ownerConfirmedAt).toBeTruthy();
  });
});

describe("STOP", () => {
  it("only an exact command triggers it", () => {
    expect(isStopCommand("STOP")).toBe(true);
    expect(isStopCommand("ডিলিট করুন।")).toBe(true);
    expect(isStopCommand("বন্ধ")).toBe(true);
    expect(isStopCommand("অফিস বন্ধ থাকলে কথা হবে")).toBe(false);
  });
  it("erases profile, messages and media, closes matches, keeps no link to the number", async () => {
    const OTHER = "+8801711000502";
    await makeUser(P, "male"); await makeUser(OTHER, "female");
    const m = await makeMatch(P, OTHER, "shown_to_b");
    await getStorage().put(mockMediaKey("img2"), new Uint8Array([1]), "image/jpeg");
    const img = await inbound(P, "", "image", { mediaId: "img2" });
    await storeMedia(img.id, "photos");
    await handleImage(img.id);
    const [row] = await db().select().from(schema.messages).where(eq(schema.messages.id, img.id));
    const key = row!.mediaKey!;

    const stop = await inbound(P, "STOP");
    expect(await preflight(stop.id)).toBe("done");

    expect(await db().select().from(schema.profileAnswers).where(eq(schema.profileAnswers.phone, P))).toHaveLength(0);
    expect(await db().select().from(schema.messages).where(eq(schema.messages.phone, P))).toHaveLength(0);
    expect(await db().select().from(schema.photos)).toHaveLength(0);
    await expect(getStorage().get(key)).rejects.toThrow();
    expect(await user()).toBeUndefined();

    const closed = await getMatch(m.id);
    expect(closed!.state).toBe("declined");
    expect(closed!.userA).toMatch(/^deleted:/);
    expect(await outbound(OTHER)).toHaveLength(1);
    expect((await outbound(OTHER))[0]).toBe("প্রস্তাবটি আর এগোচ্ছে না। মন খারাপ করবেন না, নতুন উপযুক্ত প্রস্তাব পেলে জানাব।");
  });
  it("keeps a verified payment for the books without the wallet number, and starts fresh on return", async () => {
    const OTHER = "+8801711000503";
    await makeUser(P, "male"); await makeUser(OTHER, "female");
    const m = await makeMatch(P, OTHER, "payment_pending");
    await db().insert(schema.payments).values({ matchId: m.id, payerPhone: P, senderWalletNumber: "01712345678", trxId: "ABCD123456", amount: 300, status: "verified" });
    await audit("admin@x", "user.blocked", "user", P);
    await eraseUser(P);
    expect(JSON.stringify(await db().select().from(schema.auditLog))).not.toContain(P);
    const [p] = await db().select().from(schema.payments);
    expect(p).toMatchObject({ senderWalletNumber: null, trxId: "ABCD123456", status: "verified" });
    expect(p!.payerPhone).toMatch(/^deleted:/);
    await eraseUser(P); // retry is harmless
    await ingestPayload(payloadMsg("w9", "হাই"));
    expect((await user())!.status).toBe("new");
  });
});

describe("guardReply", () => {
  it("handles formats with spaces, dashes and country code", () => {
    for (const leak of ["০১৭১২-৩৪৫৬৭৮", "+880 1712 345678", "01712 345678", "8801712345678"]) {
      expect(guardReply(`নম্বর ${leak} ঠিক?`, [])).not.toMatch(/\d{5}|[০-৯]{5}/);
    }
    expect(guardReply("৩০০ টাকা, বয়স ২৭, ২০২৬ সাল", [])).toBe("৩০০ টাকা, বয়স ২৭, ২০২৬ সাল");
  });
});
