import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { inbound, makeMatch, makeUser, outbound, sentEvents } from "./helpers";

const SECRET = "test-webhook-secret-123456";
const PHONE = "+8801711000700";
const SESSION = { id: "s-1", name: "biyeshadi", status: "ready" };

type Reply = { status?: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string> };
let server: Server;
let base: string;
let handler: (req: IncomingMessage, body: string) => Reply | undefined;
const seen: { method: string; url: string; key?: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? "", url: req.url ?? "", key: req.headers["x-api-key"] as string, body });
      const out = handler(req, body) ?? (req.url === "/api/sessions" ? { json: [SESSION] } : { json: { messageId: "wa-out-1" } });
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json", ...out.headers });
      res.end(out.bytes ?? JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(async () => {
  seen.length = 0;
  handler = () => undefined;
  for (const [k, v] of Object.entries({ CHANNEL: "openwa", OPENWA_BASE_URL: base, OPENWA_API_KEY: "key", OPENWA_WEBHOOK_SECRET: SECRET, LLM_PROVIDER: "deepseek" })) vi.stubEnv(k, v);
  vi.resetModules();
  // The modules below hold state, and each test wants a clean adapter bound to the stubbed env.
  const settings = await import("@/lib/settings");
  await settings.setSetting("typing_indicator", { per_char_ms: 0, max_ms: 0 });
});
afterEach(() => vi.unstubAllEnvs());

const adapter = async () => new (await import("@/lib/channel/openwa")).OpenWAAdapter();
const parse = async (p: unknown) => (await import("@/lib/channel/openwa")).parseOpenWAEvent(p);
const direct = (over: object = {}) => ({
  event: "message.received",
  data: { id: "3EB0A", from: "8801711000700@c.us", chatId: "8801711000700@c.us", body: "হাই", type: "text", timestamp: 1900000000, isGroup: false, kind: "individual", fromMe: false, ...over },
});
const postHook = async (payload: unknown, secret = SECRET) => {
  const { POST } = await import("@/app/api/openwa/webhook/route");
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return POST(new NextRequest("http://x/", { method: "POST", body, headers: { "x-openwa-signature": sig } }));
};

describe("who reaches the agent", () => {
  it("accepts a direct message and keeps the WhatsApp timestamp", async () => {
    const { messages } = await parse(direct());
    expect(messages[0]).toMatchObject({ phone: PHONE, type: "text", text: "হাই", waMessageId: "3EB0A" });
    expect(messages[0]!.timestamp.getTime()).toBe(1900000000 * 1000);
  });
  it.each([
    ["group", { isGroup: true, from: "1203@g.us", chatId: "1203@g.us", kind: "group" }],
    ["status", { from: "status@broadcast", kind: "status" }],
    ["channel", { from: "120@newsletter", kind: "channel" }],
    ["our own send", { fromMe: true }],
    ["broadcast", { kind: "broadcast" }],
  ])("ignores %s", async (_n, over) => {
    const out = await parse(direct(over));
    expect(out.messages).toHaveLength(0);
    expect(out.unresolved).toHaveLength(0);
  });
  it("uses the verified number for an @lid sender", async () => {
    const { messages } = await parse(direct({ from: "162878178984075@lid", chatId: "162878178984075@lid", senderPhone: "8801711000700" }));
    expect(messages[0]!.phone).toBe(PHONE);
  });
  it("never treats LID digits as a phone number", async () => {
    const out = await parse(direct({ from: "162878178984075@lid", chatId: "162878178984075@lid", senderPhone: null }));
    expect(out.messages).toHaveLength(0);
    expect(out.unresolved).toEqual([{ chatId: "162878178984075@lid" }]);
  });
  it("ignores a phone number typed in the message when working out identity", async () => {
    const { messages } = await parse(direct({ body: "আমার নম্বর +8801999999999" }));
    expect(messages[0]!.phone).toBe(PHONE);
  });
  it("strips a device suffix from the sender id", async () => {
    expect((await parse(direct({ from: "8801711000700:12@c.us" }))).messages[0]!.phone).toBe(PHONE);
  });
  it("maps media types and addresses media by chat and message", async () => {
    expect((await parse(direct({ type: "voice" }))).messages[0]).toMatchObject({ type: "voice", mediaId: "8801711000700@c.us::3EB0A" });
    expect((await parse(direct({ type: "audio" }))).messages[0]!.type).toBe("voice");
    expect((await parse(direct({ type: "image", body: "আমি" }))).messages[0]).toMatchObject({ type: "image", text: "আমি" });
    expect((await parse(direct({ type: "sticker" }))).messages[0]!.type).toBe("other");
  });
  it("maps delivery receipts and session events", async () => {
    expect((await parse({ event: "message.ack", data: { id: "x", messageId: "m1", status: "read", ack: 3 } })).statuses[0]).toMatchObject({ waMessageId: "m1", status: "read" });
    expect((await parse({ event: "message.failed", data: { messageId: "m2", status: "failed" } })).statuses[0]!.status).toBe("failed");
    expect((await parse({ event: "session.disconnected", data: { reason: "conflict" } })).session).toMatchObject({ event: "session.disconnected", reason: "conflict" });
    expect((await parse({})).messages).toEqual([]);
  });
});

describe("webhook route", () => {
  it("rejects a bad signature and stores nothing", async () => {
    await setSetting("live_allowlist", [PHONE]);
    expect((await postHook(direct(), "wrong-secret-wrong-secret")).status).toBe(401);
    expect(await db().select().from(schema.messages)).toHaveLength(0);
  });
  it("stores an allowed sender and queues exactly one event despite redelivery", async () => {
    await setSetting("live_allowlist", [PHONE]);
    expect((await postHook(direct())).status).toBe(200);
    expect((await postHook(direct())).status).toBe(200);
    expect(await db().select().from(schema.messages)).toHaveLength(1);
    expect(new Set(sentEvents().map((e) => e.id))).toEqual(new Set(["wa-3EB0A"]));
  });
  it("the allowlist starts closed: strangers leave no trace", async () => {
    expect((await postHook(direct())).status).toBe(200);
    expect(await db().select().from(schema.users)).toHaveLength(0);
    expect(await db().select().from(schema.messages)).toHaveLength(0);
    expect(sentEvents()).toHaveLength(0);
  });
  it("turning the allowlist off serves everyone", async () => {
    await setSetting("live_allowlist_enabled", false);
    await postHook(direct());
    expect(await db().select().from(schema.messages)).toHaveLength(1);
  });
  it("audits an unverifiable sender and apologizes at most once an hour, only when open to the public", async () => {
    const lid = direct({ from: "9@lid", chatId: "9@lid", senderPhone: null });
    await postHook(lid);
    expect(seen.filter((s) => s.url.endsWith("send-text"))).toHaveLength(0);
    await setSetting("live_allowlist_enabled", false);
    await postHook(lid);
    await postHook(lid);
    const sends = seen.filter((s) => s.url.endsWith("send-text"));
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0]!.body).chatId).toBe("9@lid");
    expect(await db().select().from(schema.users)).toHaveLength(0);
    const audited = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "channel.unverified_sender"));
    expect(audited).toHaveLength(3);
  });
  it("records session trouble where the owner can see it", async () => {
    await postHook({ event: "session.restriction", data: { active: true, kind: "temporary", code: "x", expiresAt: null } });
    const [row] = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "session.restriction"));
    expect(row).toBeTruthy();
  });
  it("is closed when another channel is active", async () => {
    vi.stubEnv("CHANNEL", "whatsapp");
    expect((await postHook(direct())).status).toBe(503);
  });
});

describe("sending", () => {
  it("sends text to the phone chat with the API key, and returns the message id", async () => {
    const a = await adapter();
    expect(await a.sendText(PHONE, "হ্যালো")).toEqual({ waMessageId: "wa-out-1" });
    const send = seen.find((s) => s.url === "/api/sessions/s-1/messages/send-text")!;
    expect(send.key).toBe("key");
    expect(JSON.parse(send.body)).toMatchObject({ chatId: "8801711000700@c.us", text: "হ্যালো" });
  });
  it("shows typing before sending, and a typing failure never blocks the message", async () => {
    await setSetting("typing_indicator", { per_char_ms: 0, max_ms: 1 });
    const a = await adapter();
    await a.sendText(PHONE, "x");
    expect(seen.map((s) => s.url).filter((u) => u.includes("/chats/") || u.includes("send-text"))).toEqual([
      "/api/sessions/s-1/chats/read", "/api/sessions/s-1/chats/typing", "/api/sessions/s-1/messages/send-text",
    ]);
    seen.length = 0;
    handler = (q) => (q.url?.includes("/chats/") ? { status: 500 } : undefined);
    await expect(a.sendText(PHONE, "x")).resolves.toEqual({ waMessageId: "wa-out-1" });
  });
  it("sends images as base64 with a caption", async () => {
    await (await adapter()).sendImage(PHONE, { bytes: new Uint8Array([1, 2]), mime: "image/jpeg" }, "ক্যাপশন");
    expect(JSON.parse(seen.find((s) => s.url.endsWith("send-image"))!.body)).toEqual({ chatId: "8801711000700@c.us", base64: "AQI=", mimetype: "image/jpeg", caption: "ক্যাপশন" });
  });
  it("a pacing refusal waits as asked, capped at five minutes", async () => {
    const { RetryAfterError } = await import("inngest");
    handler = (q) => (q.url?.endsWith("send-text") ? { status: 429, json: { code: "SEND_PACING_LIMITED", retryAfterSeconds: 9999 } } : undefined);
    const err = await (await adapter()).sendText(PHONE, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryAfterError);
    expect((err as InstanceType<typeof RetryAfterError>).retryAfter).toBe("300");
  });
  it("surfaces other failures so the step retries", async () => {
    handler = (q) => (q.url?.endsWith("send-text") ? { status: 500, json: {} } : undefined);
    await expect((await adapter()).sendText(PHONE, "x")).rejects.toThrow(/500/);
  });
  it("downloads media, encoding ids, and enforces the size limit", async () => {
    handler = (q) => (q.url?.includes("/media") ? { bytes: Buffer.from([7, 8, 9]), headers: { "Content-Type": "audio/ogg; codecs=opus" } } : undefined);
    const a = await adapter();
    const f = await a.downloadMedia("88017@c.us::3EB0/A", 10);
    expect([...f.bytes]).toEqual([7, 8, 9]);
    expect(f.mime).toBe("audio/ogg");
    expect(seen.at(-1)!.url).toBe("/api/sessions/s-1/messages/88017%40c.us/3EB0%2FA/media");
    const { MediaTooLargeError } = await import("@/lib/channel");
    await expect(a.downloadMedia("88017@c.us::1", 2)).rejects.toBeInstanceOf(MediaTooLargeError);
  });
});

describe("no Meta window on OpenWA", () => {
  it("delivers plain text to a user silent for days, with no template", async () => {
    await makeUser(PHONE, "male", {}, { lastInboundAt: new Date(Date.now() - 96 * 3600 * 1000) });
    const { sendToUser } = await import("@/lib/conversation/outbound");
    expect(await sendToUser(PHONE, "কার্ড", { dedupeKey: "k", template: "match_intro" })).toBe("sent");
    const [row] = await db().select().from(schema.messages);
    expect(row).toMatchObject({ type: "text", status: "sent", waMessageId: "wa-out-1" });
  });
});

describe("outbound queue", () => {
  const backdate = (mins: number) => db().update(schema.messages).set({ createdAt: new Date(Date.now() - mins * 60_000) });
  const failing = () => { handler = (q) => (q.url?.endsWith("send-text") ? { status: 503, json: {} } : undefined); };

  it("a deferred send stays queued, then goes out in order when the channel recovers", async () => {
    await makeUser(PHONE, "male");
    const { flushOutboundQueue, sendToUser } = await import("@/lib/conversation/outbound");
    failing();
    expect(await sendToUser(PHONE, "প্রথম", { dedupeKey: "a", deferOnFailure: true })).toBe("deferred");
    await backdate(20);
    expect(await sendToUser(PHONE, "দ্বিতীয়", { dedupeKey: "b", deferOnFailure: true })).toBe("deferred");
    await db().update(schema.messages).set({ createdAt: new Date(Date.now() - 15 * 60_000) }).where(eq(schema.messages.dedupeKey, "b"));

    expect((await flushOutboundQueue()).sent).toBe(0); // still down
    let n = 0;
    handler = (q) => (q.url?.endsWith("send-text") ? { json: { messageId: `wa-out-q${++n}` } } : undefined);
    seen.length = 0;
    expect((await flushOutboundQueue()).sent).toBe(2);
    expect(seen.filter((s) => s.url.endsWith("send-text")).map((s) => JSON.parse(s.body).text)).toEqual(["প্রথম", "দ্বিতীয়"]);
    expect((await flushOutboundQueue()).sent).toBe(0); // and only once
  });
  it("leaves recent messages to Inngest's retries, and retires ones over a day old", async () => {
    await makeUser(PHONE, "male");
    const { flushOutboundQueue, sendToUser } = await import("@/lib/conversation/outbound");
    failing();
    await sendToUser(PHONE, "নতুন", { dedupeKey: "a", deferOnFailure: true });
    handler = () => undefined;
    expect((await flushOutboundQueue()).sent).toBe(0);
    await backdate(25 * 60);
    expect(await flushOutboundQueue()).toEqual({ sent: 0, expired: 1 });
    expect((await db().select().from(schema.messages))[0]!.status).toBe("failed");
  });
  it("re-sends a queued image from storage", async () => {
    await makeUser(PHONE, "male");
    await (await import("@/lib/storage")).getStorage().put("q/a.jpg", new Uint8Array([5]), "image/jpeg");
    await db().insert(schema.messages).values({ phone: PHONE, direction: "outbound", type: "image", rawText: "ক্যাপশন", mediaKey: "q/a.jpg", dedupeKey: "img", status: "queued", createdAt: new Date(Date.now() - 20 * 60_000) });
    const { flushOutboundQueue } = await import("@/lib/conversation/outbound");
    expect((await flushOutboundQueue()).sent).toBe(1);
    expect(seen.some((s) => s.url.endsWith("send-image"))).toBe(true);
  });
  it("a closed-match notice during an outage is deferred rather than failing the close", async () => {
    await makeUser(PHONE, "male"); await makeUser("+8801711000701", "female");
    const m = await makeMatch(PHONE, "+8801711000701", "shown_to_b");
    failing();
    const { respondToMatch, getMatch } = await import("@/lib/matches");
    expect((await respondToMatch("+8801711000701", m.id, "decline")).ok).toBe(true);
    expect((await getMatch(m.id))!.state).toBe("declined");
    expect(await outbound(PHONE)).toHaveLength(1);
    expect((await db().select().from(schema.messages))[0]!.status).toBe("queued");
  });
});

describe("pause", () => {
  it("holds a message, then answers it on resume, with a fresh event id", async () => {
    await makeUser(PHONE, "male");
    await setSetting("bot_paused", true);
    const m = await inbound(PHONE, "হাই");
    const { preflight } = await import("@/lib/conversation/pipeline");
    expect(await preflight(m.id)).toBe("done");
    expect((await db().select().from(schema.messages))[0]!.processedAt).toBeNull();
    await setSetting("bot_paused", false);
    const { resumeHeldMessages } = await import("@/lib/conversation/ingest");
    expect(await resumeHeldMessages()).toBe(1);
    expect(sentEvents().at(-1)).toMatchObject({ name: "wa/message.received", data: { messageId: m.id } });
    expect(sentEvents().at(-1)!.id).toMatch(/^resume-/);
    expect(await preflight(m.id)).toBe("agent");
  });
  it("STOP still works while paused", async () => {
    await makeUser(PHONE, "male");
    await setSetting("bot_paused", true);
    const m = await inbound(PHONE, "STOP");
    await (await import("@/lib/conversation/pipeline")).preflight(m.id);
    expect(await db().select().from(schema.users).where(eq(schema.users.phone, PHONE))).toHaveLength(0);
  });
});

describe("erasure reaches the gateway", () => {
  it("STOP deletes OpenWA's copy of the chat", async () => {
    await makeUser(PHONE, "male");
    await (await import("@/lib/safety")).eraseUser(PHONE);
    expect(seen.find((s) => s.method === "DELETE")!.url).toBe("/api/sessions/s-1/chats/8801711000700%40c.us/messages");
  });
  it("an outage does not block erasing our data; it retries later and then clears", async () => {
    await makeUser(PHONE, "male");
    handler = (q) => (q.method === "DELETE" ? { status: 503 } : undefined);
    const safety = await import("@/lib/safety");
    await safety.eraseUser(PHONE);
    expect(await db().select().from(schema.users).where(eq(schema.users.phone, PHONE))).toHaveLength(0);
    const { getSetting } = await import("@/lib/settings");
    expect(await getSetting("gateway_erase_queue")).toEqual([PHONE]);
    expect(await safety.drainGatewayEraseQueue()).toBe(0);
    expect(await getSetting("gateway_erase_queue")).toEqual([PHONE]);
    handler = () => undefined;
    expect(await safety.drainGatewayEraseQueue()).toBe(1);
    expect(await getSetting("gateway_erase_queue")).toEqual([]);
  });
  it("a chat the gateway never held counts as erased", async () => {
    handler = (q) => (q.method === "DELETE" ? { status: 404 } : undefined);
    await expect((await adapter()).eraseConversation(PHONE)).resolves.toBeUndefined();
  });
});

describe("safety on a live channel", () => {
  it("refuses the mock LLM with real people", async () => {
    vi.stubEnv("LLM_PROVIDER", "mock");
    const { getLLM } = await import("@/lib/ai");
    expect(() => getLLM()).toThrow(/real people/);
  });
  it("session setup is idempotent: creates once, registers the webhook with its secret, updates it after", async () => {
    let sessions: object[] = [];
    let hooks: object[] = [];
    handler = (q, body) => {
      if (q.url === "/api/sessions" && q.method === "GET") return { json: sessions };
      if (q.url === "/api/sessions" && q.method === "POST") { sessions = [{ id: "s-9", name: "biyeshadi", status: "created" }]; return { status: 201, json: sessions[0] }; }
      if (q.url?.endsWith("/webhooks") && q.method === "GET") return { json: hooks };
      if (q.url?.endsWith("/webhooks") && q.method === "POST") { hooks = [{ id: "h1", url: JSON.parse(body).url }]; return { status: 201, json: hooks[0] }; }
      return { json: {} };
    };
    const { connectSession } = await import("@/lib/channel/openwa-session");
    await connectSession();
    await connectSession();
    expect(seen.filter((s) => s.url === "/api/sessions" && s.method === "POST")).toHaveLength(1);
    expect(seen.filter((s) => s.url.endsWith("/webhooks") && s.method === "POST")).toHaveLength(1);
    expect(seen.filter((s) => s.url.endsWith("/webhooks/h1") && s.method === "PUT")).toHaveLength(1);
    const reg = JSON.parse(seen.find((s) => s.url.endsWith("/webhooks") && s.method === "POST")!.body);
    expect(reg.secret).toBe(SECRET);
    expect(reg.events).toContain("message.received");
    expect(reg.events).not.toContain("*");
    expect(seen.filter((s) => s.url.endsWith("/start"))).toHaveLength(2);
  });
});

