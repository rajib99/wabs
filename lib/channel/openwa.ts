import { createHmac, timingSafeEqual } from "node:crypto";
import { RetryAfterError } from "inngest";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSetting } from "@/lib/settings";
import {
  type ChannelAdapter, type InboundMessage, type MediaFile, MediaTooLargeError, type ReceivedPayload, type SendResult, type StatusUpdate,
} from "./types";

/** Validates X-OpenWA-Signature: `sha256=<hex>` over the exact request body. */
export function verifyOpenWASignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type OpenWAMessage = {
  id: string; from?: string; chatId?: string; body?: string; type?: string; timestamp?: number;
  fromMe?: boolean; isGroup?: boolean; kind?: string; senderPhone?: string | null;
};
type OpenWAEnvelope = { event?: string; data?: Record<string, unknown> };

export type SessionEvent = { event: string; status?: string; reason?: string; active?: boolean; kind?: string };
export type UnresolvedSender = { chatId: string };
export type ParsedEvent = ReceivedPayload & { session: SessionEvent | null; unresolved: UnresolvedSender[] };

const E164 = /^\+\d{8,15}$/;
const PERSONAL_CHAT = /@(c\.us|s\.whatsapp\.net|lid)$/;

const mediaIdOf = (chatId: string, messageId: string) => `${chatId}::${messageId}`;

/** The chat id for a verified phone number. OpenWA's engines switch to the contact's LID themselves when needed. */
export const chatIdFor = (phone: string) => `${phone.replace(/\D/g, "")}@c.us`;

/**
 * The phone number is our primary key and is released through the payment flow, so it must come from
 * WhatsApp, never from text a user typed. Null means this sender could not be verified.
 */
export function senderPhoneOf(m: Pick<OpenWAMessage, "from" | "senderPhone">): string | null {
  const from = (m.from ?? "").replace(/:\d+(?=@)/, "");
  const raw = from.endsWith("@lid") ? (m.senderPhone ?? "") : from.split("@")[0]!;
  const phone = `+${raw.replace(/\D/g, "")}`;
  return E164.test(phone) ? phone : null;
}

/** Only direct messages from other people reach the agent: never groups, status, channels or our own sends. */
function isDirectMessage(m: OpenWAMessage): boolean {
  if (m.fromMe || m.isGroup) return false;
  if (m.kind && m.kind !== "individual") return false;
  return PERSONAL_CHAT.test(m.from ?? "");
}

function toInbound(m: OpenWAMessage, phone: string): InboundMessage {
  const base = { waMessageId: m.id, phone, timestamp: new Date((m.timestamp ?? Date.now() / 1000) * 1000) };
  const chatId = m.chatId ?? m.from!;
  switch (m.type) {
    case "text": return { ...base, type: "text", text: m.body ?? "" };
    case "voice":
    case "audio": return { ...base, type: "voice", mediaId: mediaIdOf(chatId, m.id) };
    case "image": return { ...base, type: "image", text: m.body, mediaId: mediaIdOf(chatId, m.id) };
    default: return { ...base, type: "other" };
  }
}

/** Normalizes one OpenWA webhook delivery. Does no I/O. */
export function parseOpenWAEvent(payload: unknown): ParsedEvent {
  const { event = "", data = {} } = (payload ?? {}) as OpenWAEnvelope;
  const out: ParsedEvent = { messages: [], statuses: [], session: null, unresolved: [] };
  if (event === "message.received") {
    const m = data as unknown as OpenWAMessage;
    if (!m.id || !isDirectMessage(m)) return out;
    const phone = senderPhoneOf(m);
    if (phone) out.messages.push(toInbound(m, phone));
    else out.unresolved.push({ chatId: m.chatId ?? m.from! });
  } else if (event === "message.ack" || event === "message.failed") {
    const id = String(data.messageId ?? data.id ?? "");
    const status = String(data.status ?? "");
    if (id && (status === "sent" || status === "delivered" || status === "read" || status === "failed")) {
      const update: StatusUpdate = { waMessageId: id, status, timestamp: new Date() };
      out.statuses.push(update);
    }
  } else if (event.startsWith("session.")) {
    out.session = {
      event,
      status: data.status as string | undefined,
      reason: data.reason as string | undefined,
      active: data.active as boolean | undefined,
      kind: data.kind as string | undefined,
    };
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenWAAdapter implements ChannelAdapter {
  /** An unofficial session has no Meta service window and no approved templates. */
  readonly enforcesServiceWindow = false;

  receiveMessage(payload: unknown): ReceivedPayload {
    const { messages, statuses } = parseOpenWAEvent(payload);
    return { messages, statuses };
  }

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const cfg = env.openwa();
    return fetch(`${cfg.OPENWA_BASE_URL}${path}`, {
      method,
      headers: { "X-API-Key": cfg.OPENWA_API_KEY, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private sessionPath(sessionId: string, rest: string) {
    return `/api/sessions/${encodeURIComponent(sessionId)}${rest}`;
  }

  /** Our session name maps to OpenWA's generated id; looked up each time so a recreated session just works. */
  async sessionId(): Promise<string> {
    const name = env.openwa().OPENWA_SESSION;
    const res = await this.request("GET", "/api/sessions");
    if (!res.ok) throw new Error(`OpenWA session list failed: ${res.status}`);
    const sessions = (await res.json()) as { id: string; name: string }[];
    const session = sessions.find((s) => s.name === name);
    if (!session) throw new Error(`OpenWA session "${name}" does not exist: connect it in the admin WhatsApp page`);
    return session.id;
  }

  private async send(path: string, body: Record<string, unknown>): Promise<SendResult> {
    const id = await this.sessionId();
    const res = await this.request("POST", this.sessionPath(id, path), body);
    if (res.status === 429) {
      // OpenWA's send pacing refused it. Wait as asked; capped so the outbound queue can take over.
      const info = (await res.json().catch(() => ({}))) as { retryAfterSeconds?: number };
      throw new RetryAfterError("OpenWA send pacing limit", `${Math.min(info.retryAfterSeconds ?? 60, 300)}s`);
    }
    if (!res.ok) throw new Error(`OpenWA send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const { messageId } = (await res.json()) as { messageId?: string };
    if (!messageId) throw new Error("OpenWA send returned no message id");
    return { waMessageId: messageId };
  }

  /** Shows the user BS has seen the message and is writing. Purely cosmetic, so failures never block a send. */
  private async showTyping(to: string, text: string) {
    const { per_char_ms: perChar, max_ms: max } = await getSetting<{ per_char_ms: number; max_ms: number }>("typing_indicator");
    if (max <= 0) return;
    const chatId = chatIdFor(to);
    try {
      const id = await this.sessionId();
      await this.request("POST", this.sessionPath(id, "/chats/read"), { chatId });
      await this.request("POST", this.sessionPath(id, "/chats/typing"), { chatId, state: "typing" });
    } catch (err) {
      logger.warn({ err }, "typing indicator failed");
    }
    await sleep(Math.min(text.length * perChar, max));
  }

  async sendText(to: string, text: string) {
    await this.showTyping(to, text);
    return this.send("/messages/send-text", { chatId: chatIdFor(to), text, linkPreview: false });
  }

  sendImage(to: string, image: MediaFile, caption?: string) {
    return this.send("/messages/send-image", {
      chatId: chatIdFor(to), base64: Buffer.from(image.bytes).toString("base64"), mimetype: image.mime, caption,
    });
  }

  sendTemplate(): Promise<SendResult> {
    return Promise.reject(new Error("OpenWA has no templates: enforcesServiceWindow=false means this is never called"));
  }

  async downloadMedia(mediaId: string, maxBytes: number): Promise<MediaFile> {
    const separator = mediaId.indexOf("::");
    if (separator < 0) throw new Error("malformed OpenWA media id");
    const chatId = mediaId.slice(0, separator);
    const messageId = mediaId.slice(separator + 2);
    const id = await this.sessionId();
    const res = await this.request("GET", this.sessionPath(id, `/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`));
    if (!res.ok) throw new Error(`OpenWA media download failed: ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new MediaTooLargeError();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new MediaTooLargeError();
    return { bytes, mime: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim() };
  }

  /** Sends to a chat we could not map to a phone number. Used only for the apology on unverified senders. */
  async sendRaw(chatId: string, text: string) {
    await this.send("/messages/send-text", { chatId, text, linkPreview: false });
  }

  /** STOP/delete: OpenWA stores its own copy of the chat, including media. */
  async eraseConversation(phone: string) {
    const id = await this.sessionId();
    const res = await this.request("DELETE", this.sessionPath(id, `/chats/${encodeURIComponent(chatIdFor(phone))}/messages`));
    // 404: the gateway holds nothing for this chat, which is what erasure wants.
    if (!res.ok && res.status !== 404) throw new Error(`OpenWA chat erase failed: ${res.status}`);
  }
}
