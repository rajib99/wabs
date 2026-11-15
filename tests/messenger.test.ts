import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { inbound, makeMatch, makeUser, outbound, sentEvents } from "./helpers";

const SECRET = "app-secret-for-tests";
const TOKEN = "page-token";
const PSID = "6543210987654321";
const KEY = `fb:${PSID}`;

let server: Server;
let base: string;
let handler: (req: IncomingMessage, body: string) => { status?: number; json?: unknown } | undefined;
const seen: { method: string; url: string; body: string }[] = [];
let mid = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      const out = handler(req, body) ?? { json: { recipient_id: PSID, message_id: `m_${++mid}` } };
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(async () => {
  seen.length = 0;
  handler = () => undefined;
  for (const [k, v] of Object.entries({
    CHANNEL: "messenger", LLM_PROVIDER: "deepseek", MESSENGER_PAGE_ID: "111", MESSENGER_PAGE_ACCESS_TOKEN: TOKEN, MESSENGER_APP_ID: "999",
    MESSENGER_APP_SECRET: SECRET, MESSENGER_VERIFY_TOKEN: "verify-token-123456", MESSENGER_GRAPH_BASE_URL: base,
  })) vi.stubEnv(k, v);
  vi.resetModules();
  await (await import("@/lib/settings")).setSetting("typing_indicator", { per_char_ms: 0, max_ms: 0 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const mod = () => import("@/lib/channel/messenger");
const ev = (messaging: object[]) => ({ object: "page", entry: [{ id: "111", time: 1, messaging }] });
const msg = (message: object, ts = 1_900_000_000_000) => ({ sender: { id: PSID }, recipient: { id: "111" }, timestamp: ts, message: { mid: "mid.1", ...message } });
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const postHook = async (payload: unknown, secret = SECRET) => {
  const { POST } = await import("@/app/api/messenger/webhook/route");
  const body = JSON.stringify(payload);
  return POST(new NextRequest("http://x/", { method: "POST", body, headers: { "x-hub-signature-256": sign(body, secret) } }));
};
const sends = () => seen.filter((s) => s.url.startsWith("/v27.0/me/messages") && s.method === "POST").map((s) => { try { return JSON.parse(s.body); } catch { return { multipart: true }; } });

describe("parsing", () => {
  it("keys people by Page-scoped ID and keeps text", async () => {
    const { messages } = (await mod()).parseMessengerEvent(ev([msg({ text: "হাই" })]), "999");
    expect(messages[0]).toMatchObject({ phone: KEY, type: "text", text: "হাই", waMessageId: "mid.1" });
    expect(messages[0]!.timestamp.getTime()).toBe(1_900_000_000_000);
  });
  it("only a phone quick reply yields a shared number; typed digits never do", async () => {
    const { parseMessengerEvent } = await mod();
    expect(parseMessengerEvent(ev([msg({ text: "+880 1712 345678", quick_reply: { payload: "+8801712345678" } })])).messages[0]!.sharedPhone).toBe("+8801712345678");
    expect(parseMessengerEvent(ev([msg({ text: "01712345678", quick_reply: { payload: "01712345678" } })])).messages[0]!.sharedPhone).toBe("+8801712345678");
    expect(parseMessengerEvent(ev([msg({ text: "+8801712345678" })])).messages[0]!.sharedPhone).toBeUndefined();
  });
  it("maps voice, images, stickers and multiple attachments", async () => {
    const { parseMessengerEvent } = await mod();
    const audio = parseMessengerEvent(ev([msg({ attachments: [{ type: "audio", payload: { url: "https://cdn.fbsbx.com/v/a.mp4" } }] })])).messages[0]!;
    expect(audio).toMatchObject({ type: "voice", mediaId: "https://cdn.fbsbx.com/v/a.mp4" });
    const sticker = parseMessengerEvent(ev([msg({ attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/s.png", sticker_id: 369239263222822 } }] })])).messages[0]!;
    expect(sticker.type).toBe("other");
    const two = parseMessengerEvent(ev([msg({ attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/1.jpg" } }, { type: "file", payload: { url: "https://cdn.fbsbx.com/f" } }] })])).messages;
    expect(two.map((m) => [m.type, m.waMessageId])).toEqual([["image", "mid.1#0"], ["document", "mid.1#1"]]);
  });
  it("turns menu buttons into text the engine understands", async () => {
    const { parseMessengerEvent } = await mod();
    const pb = (payload: string) => parseMessengerEvent(ev([{ sender: { id: PSID }, recipient: { id: "111" }, timestamp: 5, postback: { payload, title: "x", mid: `pb.${payload}` } }])).messages[0]!;
    expect(pb("GET_STARTED").text).toBe("শুরু করতে চাই");
    expect(pb("HELP").text).toBe("মানুষের সাথে কথা বলতে চাই");
    expect(pb("STOP_INFO").text).toBe("__STOP_INFO__");
  });
  it("separates human replies from the Page inbox from our own app's echoes", async () => {
    const { parseMessengerEvent } = await mod();
    const echo = (app_id?: number) => parseMessengerEvent(ev([{ sender: { id: "111" }, recipient: { id: PSID }, timestamp: 9, message: { mid: "e.1", text: "আমি রহিম", is_echo: true, app_id } }]), "999");
    expect(echo(999).echoes[0]).toMatchObject({ userKey: KEY, byHuman: false });
    expect(echo(undefined).echoes[0]).toMatchObject({ byHuman: true, text: "আমি রহিম" });
    expect(echo(263902037430900).echoes[0]!.byHuman).toBe(true); // Page inbox / Business Suite
    expect(echo(999).messages).toHaveLength(0);
  });
  it("maps deliveries and reads, and ignores non-Page objects", async () => {
    const { parseMessengerEvent } = await mod();
    const p = parseMessengerEvent(ev([
      { sender: { id: PSID }, recipient: { id: "111" }, timestamp: 1, delivery: { mids: ["m_1", "m_2"], watermark: 5 } },
      { sender: { id: PSID }, recipient: { id: "111" }, timestamp: 1, read: { watermark: 6 } },
    ]));
    expect(p.statuses.map((s) => s.waMessageId)).toEqual(["m_1", "m_2"]);
    expect(p.reads[0]).toMatchObject({ userKey: KEY });
    expect(parseMessengerEvent({ object: "instagram", entry: [] }).messages).toEqual([]);
  });
  it("splits long replies under Messenger's 2,000-character limit", async () => {
    const { splitForMessenger } = await mod();
    const parts = splitForMessenger(`${"ক".repeat(1500)}\n${"খ".repeat(1500)}`);
    expect(parts.map((p) => p.length)).toEqual([1500, 1500]);
    expect(splitForMessenger("x".repeat(4100)).every((p) => p.length <= 2000)).toBe(true);
  });
});

describe("webhook route", () => {
  it("verifies the subscription token", async () => {
    const { GET } = await import("@/app/api/messenger/webhook/route");
    expect(await (await GET(new NextRequest("http://x/?hub.mode=subscribe&hub.verify_token=verify-token-123456&hub.challenge=42"))).text()).toBe("42");
    expect((await GET(new NextRequest("http://x/?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42"))).status).toBe(403);
  });
  it("rejects a bad signature and stores nothing", async () => {
    expect((await postHook(ev([msg({ text: "হাই" })]), "wrong-secret")).status).toBe(401);
    expect(await db().select().from(schema.messages)).toHaveLength(0);
  });
  it("stores a message once and queues one event, with no phone number assumed", async () => {
    await postHook(ev([msg({ text: "হাই" })]));
    await postHook(ev([msg({ text: "হাই" })]));
    expect(await db().select().from(schema.messages)).toHaveLength(1);
    const [u] = await db().select().from(schema.users);
    expect(u).toMatchObject({ phone: KEY, contactPhone: null, contactPhoneVerified: false });
    // Redelivery of an unprocessed message re-sends the same event id, which Inngest dedupes.
    expect(new Set(sentEvents().filter((e) => e.name === "wa/message.received").map((e) => e.id))).toEqual(new Set(["wa-mid.1"]));
  });
  it("a human reply in the Page inbox silences BS for that person and joins the transcript", async () => {
    await makeUser(KEY, "male");
    await setSetting("human_takeover_hours", 2);
    await postHook(ev([{ sender: { id: "111" }, recipient: { id: PSID }, timestamp: Date.now(), message: { mid: "e.9", text: "আমি অ্যাডমিন বলছি", is_echo: true } }]));
    const [u] = await db().select().from(schema.users).where(eq(schema.users.phone, KEY));
    expect(u!.humanUntil!.getTime()).toBeGreaterThan(Date.now() + 3600_000);
    expect(await outbound(KEY)).toEqual(["আমি অ্যাডমিন বলছি"]);
    // A stranger's echo creates nobody.
    await postHook(ev([{ sender: { id: "111" }, recipient: { id: "777" }, timestamp: Date.now(), message: { mid: "e.10", text: "x", is_echo: true } }]));
    expect(await db().select().from(schema.users)).toHaveLength(1);
  });
  it("read receipts mark earlier sends as read", async () => {
    await makeUser(KEY, "male");
    await db().insert(schema.messages).values({ phone: KEY, direction: "outbound", type: "text", rawText: "x", status: "sent", waMessageId: "m_a", createdAt: new Date(Date.now() - 60_000) });
    await postHook(ev([{ sender: { id: PSID }, recipient: { id: "111" }, timestamp: Date.now(), read: { watermark: Date.now() } }]));
    expect((await db().select().from(schema.messages))[0]!.status).toBe("read");
  });
  it("is closed when another channel is active", async () => {
    vi.stubEnv("CHANNEL", "whatsapp");
    expect((await postHook(ev([msg({ text: "হাই" })]))).status).toBe(503);
  });
});

describe("sending", () => {
  it("sends with appsecret_proof and the RESPONSE type, never exposing a bare token", async () => {
    const { MessengerAdapter } = await mod();
    expect(await new MessengerAdapter().sendText(KEY, "হ্যালো")).toEqual({ waMessageId: "m_1" });
    const call = seen.find((s) => s.url.startsWith("/v27.0/me/messages"))!;
    const proof = createHmac("sha256", SECRET).update(TOKEN).digest("hex");
    expect(call.url).toContain(`appsecret_proof=${proof}`);
    expect(JSON.parse(call.body)).toEqual({ recipient: { id: PSID }, messaging_type: "RESPONSE", message: { text: "হ্যালো" } });
  });
  it("refuses to send to something that is not a Messenger user", async () => {
    const { MessengerAdapter } = await mod();
    const { PermanentSendError } = await import("@/lib/channel");
    await expect(new MessengerAdapter().sendText("+8801711000000", "x")).rejects.toBeInstanceOf(PermanentSendError);
  });
  it("asks for the profile number with the phone quick reply", async () => {
    const { MessengerAdapter } = await mod();
    await new MessengerAdapter().requestPhone(KEY, "নম্বর দিন");
    expect(sends()[0].message).toEqual({ text: "নম্বর দিন", quick_replies: [{ content_type: "user_phone_number" }] });
  });
  it("sends an approved utility template outside the window, with parameters", async () => {
    await makeUser(KEY, "male", {}, { lastInboundAt: new Date(Date.now() - 48 * 3600_000) });
    await setSetting("messenger_templates", { contact_release: "bs_contact_release" });
    const { sendToUser } = await import("@/lib/conversation/outbound");
    expect(await sendToUser(KEY, "নম্বর: +8801999000111", { dedupeKey: "r1", template: "contact_release", templateParams: ["+8801999000111"] })).toBe("sent");
    expect(sends()[0]).toEqual({
      recipient: { id: PSID },
      message: { template: { name: "bs_contact_release", language: { code: "bn" }, components: [{ type: "body", parameters: [{ type: "text", text: "+8801999000111" }] }] } },
    });
  });
  it("outside the window with no approved template, nothing is sent at all", async () => {
    await makeUser(KEY, "male", {}, { lastInboundAt: new Date(Date.now() - 48 * 3600_000) });
    const { sendToUser } = await import("@/lib/conversation/outbound");
    expect(await sendToUser(KEY, "নতুন প্রস্তাব!", { dedupeKey: "c1", template: "match_intro" })).toBe("skipped_window");
    expect(sends()).toHaveLength(0);
  });
  it.each([
    ["outside the window", { code: 10, error_subcode: 2018278 }],
    ["person unavailable", { code: 551 }],
    ["deprecated tag / invalid", { code: 100 }],
  ])("%s is marked failed once and never retried", async (_n, error) => {
    await makeUser(KEY, "male");
    handler = (q) => (q.url?.startsWith("/v27.0/me/messages") ? { status: 400, json: { error } } : undefined);
    const { sendToUser, flushOutboundQueue } = await import("@/lib/conversation/outbound");
    expect(await sendToUser(KEY, "x", { dedupeKey: "p1" })).toBe("failed");
    await db().update(schema.messages).set({ createdAt: new Date(Date.now() - 20 * 60_000) });
    seen.length = 0;
    await flushOutboundQueue();
    expect(sends()).toHaveLength(0);
    expect((await db().select().from(schema.messages))[0]!.status).toBe("failed");
  });
  it("rate limits wait instead of hammering", async () => {
    handler = (q) => (q.url?.startsWith("/v27.0/me/messages") ? { status: 400, json: { error: { code: 613 } } } : undefined);
    const { MessengerAdapter } = await mod();
    const { RetryAfterError } = await import("inngest");
    await expect(new MessengerAdapter().sendText(KEY, "x")).rejects.toBeInstanceOf(RetryAfterError);
  });
  it("fetches media only from Meta's CDN over HTTPS", async () => {
    const { isMessengerMediaUrl, MessengerAdapter } = await mod();
    expect(isMessengerMediaUrl("https://cdn.fbsbx.com/v/t59/a.mp4?x=1")).toBe(true);
    expect(isMessengerMediaUrl("https://scontent.xx.fbcdn.net/v/a.jpg")).toBe(true);
    for (const bad of ["http://cdn.fbsbx.com/a", "https://fbsbx.com.evil.com/a", "https://169.254.169.254/latest", "file:///etc/passwd", `${base}/x`]) {
      expect(isMessengerMediaUrl(bad)).toBe(false);
    }
    await expect(new MessengerAdapter().downloadMedia("https://evil.example/a.jpg", 100)).rejects.toThrow(/CDN/);
  });
});

describe("contact number step", () => {
  // Every profile question answered, no number yet: the state right after the last question.
  const answeredAll = (fields: Partial<typeof schema.users.$inferInsert> = {}) =>
    makeUser(KEY, "male", {}, { contactPhone: null, contactPhoneVerified: false, contactPhoneSource: null, contactHasWhatsapp: null, ...fields });
  const step = async (text: string, sharedPhone?: string) => {
    const m = await inbound(KEY, text, "text", sharedPhone ? { sharedPhone } : {});
    return (await import("@/lib/conversation/pipeline")).preflight(m.id);
  };
  const user = async () => (await db().select().from(schema.users).where(eq(schema.users.phone, KEY)))[0]!;

  it("consent leads to the biodata question, not a phone request", async () => {
    await db().insert(schema.users).values({ phone: KEY, status: "awaiting_consent", lastInboundAt: new Date() });
    await step("হ্যাঁ");
    expect((await user()).status).toBe("active");
    expect(sends().at(-1).message.text).toContain("বায়োডাটা");
    expect(sends().at(-1).message.quick_replies).toBeUndefined();
  });
  it("while the profile is unfinished a number is just a message for the agent", async () => {
    await db().insert(schema.users).values({ phone: KEY, status: "active", consentAt: new Date(), lastInboundAt: new Date() });
    expect(await step("01712345678")).toBe("agent");
    expect((await user()).contactPhone).toBeNull();
  });
  it("a number from the share button is verified, then WhatsApp is asked", async () => {
    await answeredAll();
    await step("+8801712345678", "+8801712345678");
    expect(await user()).toMatchObject({ contactPhone: "+8801712345678", contactPhoneVerified: true, contactPhoneSource: "messenger_profile", contactHasWhatsapp: null });
    expect(await db().select().from(schema.escalations)).toHaveLength(0);
    expect(sends().at(-1).message.text).toContain("WhatsApp");
    expect(sends().at(-1).message.text).toContain("01712345678");
  });
  it("the WhatsApp answer is stored, onboarding ends and matching starts", async () => {
    await answeredAll({ contactPhone: "+8801712345678", contactPhoneVerified: true, contactPhoneSource: "messenger_profile" });
    expect(await step("না")).toBe("done");
    expect((await user()).contactHasWhatsapp).toBe(false);
    expect(sends().at(-2).message.text).toContain("প্রোফাইল সম্পূর্ণ");
    // Onboarding done: the natural pause to ask for a new-proposal alert.
    expect(sends().at(-1).message.attachment.payload).toMatchObject({ template_type: "one_time_notif_req", payload: "OTN:new_proposal" });
    expect(sentEvents().some((e) => e.name === "profile/updated" && e.data.phone === KEY)).toBe(true);
  });
  it("a typed number is accepted but must be checked by an admin before matching", async () => {
    await answeredAll();
    await step("আমার নম্বর ০১৭১২৩৪৫৬৭৮");
    expect(await user()).toMatchObject({ contactPhone: "+8801712345678", contactPhoneVerified: false, contactPhoneSource: "typed" });
    const [e] = await db().select().from(schema.escalations);
    expect(e).toMatchObject({ kind: "verify_phone", phone: KEY });
    expect(e!.reason).toContain("+8801712345678");
    await step("হ্যাঁ");
    expect((await user()).contactHasWhatsapp).toBe(true);
    expect(sends().at(-2).message.text).toContain("যাচাই");
    expect(sentEvents().some((ev) => ev.name === "profile/updated")).toBe(false);
  });
  it("a wrong number asks again with the button; a question goes to the agent", async () => {
    await answeredAll();
    expect(await step("০১৭১২৩৪")).toBe("done");
    expect(sends().at(-1).message.quick_replies).toBeTruthy();
    expect(await step("নম্বর কেন লাগবে?")).toBe("agent");
    expect((await user()).contactPhone).toBeNull();
  });
  it("an unclear WhatsApp answer asks again", async () => {
    await answeredAll({ contactPhone: "+8801712345678", contactPhoneVerified: true });
    expect(await step("জানি")).toBe("done");
    expect(sends().at(-1).message.text).toContain("WhatsApp");
    expect((await user()).contactHasWhatsapp).toBeNull();
  });
  it("matching waits for a checked number on both sides", async () => {
    await makeUser(KEY, "male", {}, { contactPhone: "+8801712345678", contactPhoneVerified: false });
    await makeUser("fb:222", "female", {}, { contactPhone: "+8801812345678", contactPhoneVerified: true });
    const { findMatches } = await import("@/lib/matching/find");
    expect(await findMatches(KEY)).toHaveLength(0);
    expect(await findMatches("fb:222")).toHaveLength(0);
    await db().update(schema.users).set({ contactPhoneVerified: true }).where(eq(schema.users.phone, KEY));
    expect(await findMatches(KEY)).toHaveLength(1);
  });
});

describe("takeover and menu", () => {
  it("BS stays quiet during a takeover, then announces itself when back", async () => {
    await makeUser(KEY, "male", {}, { humanUntil: new Date(Date.now() + 3600_000) });
    const { preflight } = await import("@/lib/conversation/pipeline");
    const m1 = await inbound(KEY, "হ্যালো");
    expect(await preflight(m1.id)).toBe("done");
    expect(sends()).toHaveLength(0);
    await db().update(schema.users).set({ humanUntil: new Date(Date.now() - 1000) }).where(eq(schema.users.phone, KEY));
    const m2 = await inbound(KEY, "আছেন?");
    expect(await preflight(m2.id)).toBe("agent");
    expect(sends()[0].message.text).toContain("স্বয়ংক্রিয়");
  });
  it("the delete menu explains STOP instead of erasing on one tap", async () => {
    await makeUser(KEY, "male");
    const m = await inbound(KEY, "__STOP_INFO__");
    await (await import("@/lib/conversation/pipeline")).preflight(m.id);
    expect(await db().select().from(schema.users)).toHaveLength(1);
    expect(sends()[0].message.text).toContain("STOP");
  });
  it("STOP erases a Messenger user and confirms", async () => {
    await makeUser(KEY, "male");
    const m = await inbound(KEY, "STOP");
    await (await import("@/lib/conversation/pipeline")).preflight(m.id);
    expect(await db().select().from(schema.users).where(eq(schema.users.phone, KEY))).toHaveLength(0);
    expect(sends()[0].message.text).toContain("মুছে");
  });
});

describe("release on Messenger", () => {
  it("both sides receive each other's contact number, never a Messenger ID", async () => {
    await makeUser(KEY, "male", {}, { contactPhone: "+8801712345678", contactPhoneVerified: true });
    await makeUser("fb:222", "female", {}, { contactPhone: "+8801812345678", contactPhoneVerified: true });
    const m = await makeMatch(KEY, "fb:222", "payment_pending");
    await db().insert(schema.payments).values([
      { matchId: m.id, payerPhone: KEY, trxId: "AAAA111111", amount: 300, status: "verified" },
      { matchId: m.id, payerPhone: "fb:222", trxId: "BBBB111111", amount: 300, status: "verified" },
    ]);
    await (await import("@/lib/payments")).settleVerifiedPayment(m.id, KEY);
    const texts = sends().map((s) => s.message?.text ?? "");
    expect(texts.some((t) => t.includes("+8801812345678"))).toBe(true);
    expect(texts.some((t) => t.includes("+8801712345678"))).toBe(true);
    expect(texts.join(" ")).not.toContain("fb:");
    expect(texts.join(" ")).not.toContain(PSID);
  });
  it("the LLM reply guard allows the user's own contact number only", async () => {
    const { guardReply } = await import("@/lib/safety");
    expect(guardReply("আপনার নম্বর +8801712345678, ওনার 01812345678", ["+8801712345678"])).toBe("আপনার নম্বর +8801712345678, ওনার [গোপন]");
  });
});

describe("one-time notifications", () => {
  const OLD = new Date(Date.now() - 48 * 3600_000);
  const optinEvent = (token: string, payload = "OTN:new_proposal", extra: object = {}) =>
    ({ sender: { id: PSID }, recipient: { id: "111" }, timestamp: 1_900_000_000_000, optin: { type: "one_time_notif_req", payload, one_time_notif_token: token, ...extra } });
  const tokens = () => db().select().from(schema.notificationTokens);
  const giveToken = async (token = "tok-1", topic = "new_proposal", expiresAt = new Date(Date.now() + 86400_000)) =>
    db().insert(schema.notificationTokens).values({ phone: KEY, topic, token, expiresAt });
  const out = async () => db().select().from(schema.messages).where(eq(schema.messages.direction, "outbound"));
  const send = async (key: string, template: string) => (await import("@/lib/conversation/outbound")).sendToUser(KEY, "card text", { dedupeKey: key, template });
  const refuse = (match: (body: string) => boolean) => {
    handler = (q, body) => (q.url?.startsWith("/v27.0/me/messages") && match(body) ? { status: 400, json: { error: { code: 100, message: "template paused" } } } : undefined);
  };

  it("parses an opt-in, keeping the topic, token and expiry; ignores anything else", async () => {
    const { parseMessengerEvent } = await mod();
    const { optins } = parseMessengerEvent(ev([
      optinEvent("t1", "OTN:new_proposal", { token_expiry_timestamp: 1_950_000_000_000 }),
      optinEvent("t2", "SOMETHING_ELSE"),
      { ...optinEvent("t3"), optin: { type: "one_time_notif_req", payload: "OTN:new_proposal" } },
      { ...optinEvent("t4"), optin: { type: "notification_messages", payload: "OTN:new_proposal", one_time_notif_token: "t4" } },
    ]));
    expect(optins).toEqual([{ phone: KEY, topic: "new_proposal", token: "t1", timestamp: new Date(1_900_000_000_000), expiresAt: new Date(1_950_000_000_000) }]);
  });
  it("the webhook stores a token; a newer opt-in replaces the unused one; unknown people and topics are ignored", async () => {
    expect((await postHook(ev([optinEvent("t1")]))).status).toBe(200);
    expect(await tokens()).toHaveLength(0); // no such user yet
    await makeUser(KEY, "male");
    await postHook(ev([optinEvent("t1"), optinEvent("t2"), optinEvent("t3", "OTN:made_up")]));
    const rows = await tokens();
    expect(rows.map((r) => [r.topic, r.token, r.usedAt])).toEqual([["new_proposal", "t2", null]]);
    expect(rows[0]!.expiresAt.getTime()).toBe(1_900_000_000_000 + 365 * 86400_000);
  });
  it("outside the window an approved template wins and the token is kept", async () => {
    await makeUser(KEY, "male", {}, { lastInboundAt: OLD });
    await setSetting("messenger_templates", { match_intro: "bs_proposal_alert" });
    await giveToken();
    expect(await send("c1", "match_intro")).toBe("sent");
    expect(sends()).toHaveLength(1);
    expect(sends()[0].message.template.name).toBe("bs_proposal_alert");
    expect((await tokens())[0]!.usedAt).toBeNull();
    expect((await out())[0]).toMatchObject({ type: "template", status: "sent" });
  });
  it("a refused template is never retried: the token is spent once instead, then nothing", async () => {
    await makeUser(KEY, "male", {}, { lastInboundAt: OLD });
    await setSetting("messenger_templates", { match_intro: "bs_proposal_alert" });
    await giveToken("tok-9");
    refuse((b) => b.includes("bs_proposal_alert"));
    expect(await send("c1", "match_intro")).toBe("sent");
    const [tpl, otn] = sends();
    expect(tpl.message.template.name).toBe("bs_proposal_alert");
    expect(otn.recipient).toEqual({ one_time_notif_token: "tok-9" });
    expect(otn.message.text).toBeTruthy();
    expect(otn.message.text).not.toContain("card text"); // generic: the card waits for their reply
    expect((await tokens())[0]!.usedAt).not.toBeNull();
    expect((await out())[0]).toMatchObject({ type: "notification", status: "sent" });

    seen.length = 0;
    expect(await send("c2", "match_intro")).toBe("skipped_window");
    expect(sends().filter((b) => b.recipient.one_time_notif_token)).toHaveLength(0);
  });
  it("with no template the token is used; an expired token is not", async () => {
    await makeUser(KEY, "male", {}, { lastInboundAt: OLD });
    await giveToken("expired", "new_proposal", new Date(Date.now() - 1000));
    expect(await send("c1", "match_intro")).toBe("skipped_window");
    expect(sends()).toHaveLength(0);
    await db().delete(schema.notificationTokens);
    await giveToken("live", "proposal_update");
    expect(await send("u1", "match_update")).toBe("sent");
    expect(sends()[0].recipient).toEqual({ one_time_notif_token: "live" });
  });
  it("payment and contact sends never fall back to a token", async () => {
    await makeUser(KEY, "male", {}, { lastInboundAt: OLD });
    await giveToken("a", "new_proposal");
    await giveToken("b", "proposal_update");
    expect(await send("p1", "payment_reminder")).toBe("skipped_window");
    expect(await send("r1", "contact_release")).toBe("skipped_window");
    expect(sends()).toHaveLength(0);
  });
  it("a transient failure gives the token back for the retry; a refused token stays spent", async () => {
    await makeUser(KEY, "male", {}, { lastInboundAt: OLD });
    await giveToken("tok");
    handler = (q) => (q.url?.startsWith("/v27.0/me/messages") ? { status: 500, json: { error: { code: 2 } } } : undefined);
    await expect(send("c1", "match_intro")).rejects.toThrow();
    expect((await tokens())[0]!.usedAt).toBeNull();
    expect((await out())[0]!.status).toBe("queued");

    refuse(() => true);
    expect(await send("c1", "match_intro")).toBe("skipped_window");
    expect((await tokens())[0]!.usedAt).not.toBeNull();
  });
  it("asks once per token, inside the window only; asks about updates while waiting on a proposal", async () => {
    const { askForNotifications } = await import("@/lib/conversation/notify");
    await makeUser(KEY, "male", {}, { contactPhone: "+8801712345678", contactPhoneVerified: true });
    expect(await askForNotifications(KEY)).toBe("sent");
    expect(sends()[0].message.attachment.payload).toMatchObject({ template_type: "one_time_notif_req", payload: "OTN:new_proposal" });
    expect(sends()[0].message.attachment.payload.title.length).toBeLessThanOrEqual(65);
    expect(await askForNotifications(KEY)).toBe("none"); // ignored: not asked again

    await makeUser("fb:other", "female");
    await makeMatch(KEY, "fb:other", "a_interested");
    expect(await askForNotifications(KEY)).toBe("sent");
    expect(sends()[1].message.attachment.payload.payload).toBe("OTN:proposal_update");

    // Once the token is given and spent, the next pause asks again.
    await postHook(ev([optinEvent("t1")]));
    await db().update(schema.notificationTokens).set({ usedAt: new Date() });
    seen.length = 0;
    expect(await askForNotifications(KEY)).toBe("sent");
    expect(sends()[0].message.attachment.payload.payload).toBe("OTN:new_proposal");

    await db().update(schema.users).set({ lastInboundAt: OLD });
    await db().delete(schema.notificationTokens);
    await db().delete(schema.messages);
    seen.length = 0;
    expect(await askForNotifications(KEY)).toBe("skipped_window");
    expect(sends()).toHaveLength(0);
  });
  it("does not ask before onboarding is done, or when disabled", async () => {
    const { askForNotifications } = await import("@/lib/conversation/notify");
    await makeUser(KEY, "male", {}, { contactPhone: "+8801712345678", contactHasWhatsapp: null });
    expect(await askForNotifications(KEY)).toBe("none");
    await db().update(schema.users).set({ contactHasWhatsapp: true });
    const { DEFAULT_SETTINGS } = await import("@/lib/settings-defaults");
    const topics = DEFAULT_SETTINGS.notification_topics as Record<string, { enabled: boolean }>;
    await setSetting("notification_topics", Object.fromEntries(Object.entries(topics).map(([k, t]) => [k, { ...t, enabled: false }])));
    expect(await askForNotifications(KEY)).toBe("none");
    expect(sends()).toHaveLength(0);
  });
  it("the agent knows an alert is not the message itself", async () => {
    const { historyText } = await import("@/lib/conversation/context");
    expect(historyText({ rawText: "card text", transcript: null, dedupeKey: "card-1", direction: "outbound", type: "notification" })).toContain("NOT yet shown");
    expect(historyText({ rawText: "card text", transcript: null, dedupeKey: "card-1", direction: "outbound", type: "text" })).toBe("card text");
  });
  it("STOP erases the person's tokens", async () => {
    await makeUser(KEY, "male");
    await giveToken();
    await (await import("@/lib/safety")).eraseUser(KEY, "test");
    expect(await tokens()).toHaveLength(0);
  });
});
