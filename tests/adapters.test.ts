import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "@/lib/ai/deepseek";
import { GroqTranscriber } from "@/lib/ai/transcriber";
import { MediaTooLargeError } from "@/lib/channel";
import { verifyWhatsAppSignature, WhatsAppCloudAdapter } from "@/lib/channel/whatsapp";
import { TOOL_DEFINITIONS } from "@/lib/conversation/tools";
import { env } from "@/lib/env";

type Handler = (req: IncomingMessage, body: Buffer) => { status?: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string> };
let server: Server;
let base: string;
let handler: Handler;
const seen: { url: string; auth?: string; body: Buffer }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      const out = handler(req, body);
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json", ...out.headers });
      res.end(out.bytes ?? JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { seen.length = 0; });

describe("lazy secrets", () => {
  it("names only the missing feature's variables, at first use", () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "");
    expect(() => env.whatsapp()).toThrow(/WhatsApp is not configured/);
    vi.unstubAllEnvs();
    vi.stubEnv("GROQ_API_KEY", "");
    expect(() => env.groq()).toThrow(/GROQ_API_KEY/);
    vi.unstubAllEnvs();
  });
});

describe("DeepSeekProvider", () => {
  it("sends model, temperature and tools, and reads tool calls and cache usage", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k"); vi.stubEnv("DEEPSEEK_BASE_URL", base);
    let sent: { model: string; temperature: number; tools: unknown[] } | undefined;
    handler = (_q, body) => {
      sent = JSON.parse(body.toString());
      return { json: {
        id: "1", object: "chat.completion", created: 1, model: "deepseek-chat",
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_next_question", arguments: "{}" } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 80 },
      } };
    };
    const res = await new DeepSeekProvider().chat({ messages: [{ role: "user", content: "হাই" }], tools: TOOL_DEFINITIONS });
    expect(sent).toMatchObject({ model: "deepseek-chat", temperature: 0.3 });
    expect(sent!.tools).toHaveLength(TOOL_DEFINITIONS.length);
    expect(res.toolCalls[0]).toEqual({ id: "c1", name: "get_next_question", arguments: "{}" });
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 5, cachedTokens: 80 });
    expect(seen[0]!.auth).toBe("Bearer k");
    vi.unstubAllEnvs();
  });
  it("tool definitions are valid object schemas", () => {
    for (const t of TOOL_DEFINITIONS) expect(t.function.parameters.type).toBe("object");
  });
});

describe("GroqTranscriber", () => {
  beforeEach(() => { vi.stubEnv("GROQ_API_KEY", "g"); vi.stubEnv("GROQ_BASE_URL", base); });
  it("posts whisper-large-v3 in Bengali, backing off on 429", async () => {
    let n = 0;
    handler = () => (++n < 3 ? { status: 429, json: { error: { message: "slow" } } } : { json: { text: " আমার নাম করিম ", duration: 4.5 } });
    const res = await new GroqTranscriber({ baseDelayMs: 1 }).transcribe(new Uint8Array([1, 2]), "audio/ogg");
    expect(res).toEqual({ text: "আমার নাম করিম", seconds: 4.5 });
    expect(n).toBe(3);
    const body = seen[2]!.body.toString();
    expect(body).toContain("whisper-large-v3");
    expect(body).toMatch(/name="language"\r\n\r\nbn/);
    vi.unstubAllEnvs();
  });
  it("gives up after max attempts and does not retry other errors", async () => {
    let n = 0;
    handler = () => { n++; return { status: 429, json: {} }; };
    await expect(new GroqTranscriber({ baseDelayMs: 1, maxAttempts: 2 }).transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toThrow();
    expect(n).toBe(2);
    n = 0;
    handler = () => { n++; return { status: 400, json: {} }; };
    await expect(new GroqTranscriber({ baseDelayMs: 1 }).transcribe(new Uint8Array([1]), "audio/ogg")).rejects.toThrow();
    expect(n).toBe(1);
    vi.unstubAllEnvs();
  });
});

describe("WhatsAppCloudAdapter", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries({ WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "pn", WHATSAPP_APP_SECRET: "s", WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_GRAPH_BASE_URL: base })) vi.stubEnv(k, v);
  });
  it("verifies signatures in constant-time shape", () => {
    const body = '{"a":1}';
    const good = `sha256=${createHmac("sha256", "s").update(body).digest("hex")}`;
    expect(verifyWhatsAppSignature(body, good, "s")).toBe(true);
    expect(verifyWhatsAppSignature(`${body} `, good, "s")).toBe(false);
    expect(verifyWhatsAppSignature(body, "sha256=abcd", "s")).toBe(false);
    expect(verifyWhatsAppSignature(body, null, "s")).toBe(false);
  });
  it("normalizes text, voice, image, button and status payloads", () => {
    const value = (v: object) => ({ entry: [{ changes: [{ value: v }] }] });
    const a = new WhatsAppCloudAdapter();
    const { messages, statuses } = a.receiveMessage(value({
      messages: [
        { id: "1", from: "8801711", timestamp: "1700000000", type: "text", text: { body: "হাই" } },
        { id: "2", from: "8801711", timestamp: "1700000000", type: "audio", audio: { id: "m2", mime_type: "audio/ogg" } },
        { id: "3", from: "8801711", timestamp: "1700000000", type: "image", image: { id: "m3", mime_type: "image/jpeg", caption: "আমি" } },
        { id: "4", from: "8801711", timestamp: "1700000000", type: "button", button: { text: "আগ্রহী" } },
        { id: "5", from: "8801711", timestamp: "1700000000", type: "sticker" },
      ],
      statuses: [{ id: "x", status: "read", timestamp: "1700000000" }, { id: "y", status: "weird", timestamp: "1" }],
    }));
    expect(messages.map((m) => m.type)).toEqual(["text", "voice", "image", "text", "other"]);
    expect(messages[0]!.phone).toBe("+8801711");
    expect(messages[3]!.text).toBe("আগ্রহী");
    expect(statuses).toHaveLength(1);
    expect(a.receiveMessage({}).messages).toEqual([]);
  });
  it("sends text and templates through the Graph API without a plus sign", async () => {
    let bodies: Record<string, unknown>[] = [];
    handler = (_q, b) => { bodies.push(JSON.parse(b.toString())); return { json: { messages: [{ id: "wamid.1" }] } }; };
    const a = new WhatsAppCloudAdapter();
    expect(await a.sendText("+8801711", "হাই")).toEqual({ waMessageId: "wamid.1" });
    await a.sendTemplate("+8801711", "bs_intro", "bn", ["৮০"]);
    expect(seen[0]!.url).toBe("/v23.0/pn/messages");
    expect(seen[0]!.auth).toBe("Bearer t");
    expect(bodies[0]).toMatchObject({ messaging_product: "whatsapp", to: "8801711", type: "text" });
    expect(bodies[1]).toMatchObject({ type: "template", template: { name: "bs_intro", language: { code: "bn" } } });
    bodies = [];
  });
  it("surfaces Graph errors so Inngest retries", async () => {
    handler = () => ({ status: 500, json: { error: "x" } });
    await expect(new WhatsAppCloudAdapter().sendText("+1", "x")).rejects.toThrow(/500/);
  });
  it("downloads media in two hops, refusing oversize before fetching", async () => {
    handler = (q) => q.url?.endsWith("/m1")
      ? { json: { url: `${base}/file`, mime_type: "audio/ogg", file_size: 3 } }
      : { bytes: Buffer.from([1, 2, 3]) };
    const f = await new WhatsAppCloudAdapter().downloadMedia("m1", 10);
    expect([...f.bytes]).toEqual([1, 2, 3]);
    seen.length = 0;
    await expect(new WhatsAppCloudAdapter().downloadMedia("m1", 2)).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(seen).toHaveLength(1);
  });
});

describe("webhook route", () => {
  const load = async () => {
    for (const [k, v] of Object.entries({ WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "pn", WHATSAPP_APP_SECRET: "s", WHATSAPP_VERIFY_TOKEN: "v" })) vi.stubEnv(k, v);
    vi.stubEnv("CHANNEL", "whatsapp");
    vi.resetModules();
    return import("@/app/api/whatsapp/webhook/route");
  };

  it("GET verifies the token and echoes the challenge", async () => {
    const { GET } = await load();
    const ok = await GET(new NextRequest("http://x/?hub.mode=subscribe&hub.verify_token=v&hub.challenge=abc"));
    expect(await ok.text()).toBe("abc");
    expect((await GET(new NextRequest("http://x/?hub.mode=subscribe&hub.verify_token=no&hub.challenge=abc"))).status).toBe(403);
  });
  it("POST rejects bad signatures and stores nothing; accepts good ones", async () => {
    const { POST } = await load();
    await (await import("@/lib/settings")).setSetting("live_allowlist_enabled", false);
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "web1", from: "8801711000999", timestamp: "1900000000", type: "text", text: { body: "হাই" } }] } }] }] });
    const bad = await POST(new NextRequest("http://x/", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=00" } }));
    expect(bad.status).toBe(401);
    const sig = `sha256=${createHmac("sha256", "s").update(body).digest("hex")}`;
    const good = await POST(new NextRequest("http://x/", { method: "POST", body, headers: { "x-hub-signature-256": sig } }));
    expect(good.status).toBe(200);
    const { db: db2, schema: s2 } = await import("@/lib/db");
    const rows = await db2().select().from(s2.messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phone).toBe("+8801711000999");
    vi.unstubAllEnvs();
  });
});
