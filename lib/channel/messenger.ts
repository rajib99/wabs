import { createHmac } from "node:crypto";
import { RetryAfterError } from "inngest";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSetting } from "@/lib/settings";
import { normalizeDigits } from "@/lib/text";
import {
  type ChannelAdapter, type InboundMessage, type MediaFile, MediaTooLargeError, PermanentSendError, type ReceivedPayload, type SendResult, type StatusUpdate,
} from "./types";

export { verifyWhatsAppSignature as verifyMessengerSignature } from "./whatsapp"; // same X-Hub-Signature-256 scheme

/** Our user key for a Messenger person. Page-scoped, so it means nothing outside this Page. */
export const messengerKey = (psid: string) => `fb:${psid}`;
export const psidOf = (key: string) => {
  if (!key.startsWith("fb:")) throw new PermanentSendError(`not a Messenger user: ${key.slice(0, 4)}…`);
  return key.slice(3);
};

/** Messenger's text limit is 2,000 characters; longer replies are split at line or sentence breaks. */
export function splitForMessenger(text: string, max = 2000): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("। "), window.lastIndexOf(". "), window.lastIndexOf(" "));
    const at = cut > max / 2 ? cut + 1 : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Postback buttons we define, turned into the text the conversation engine already understands. */
const POSTBACK_TEXT: Record<string, string> = {
  GET_STARTED: "শুরু করতে চাই",
  HELP: "মানুষের সাথে কথা বলতে চাই",
  STOP_INFO: "__STOP_INFO__",
};

type Attachment = { type: string; payload?: { url?: string; sticker_id?: number } };
type MessagingEvent = {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: { mid: string; text?: string; is_echo?: boolean; app_id?: number; quick_reply?: { payload: string }; attachments?: Attachment[] };
  postback?: { title?: string; payload?: string; mid?: string };
  delivery?: { mids?: string[]; watermark: number };
  read?: { watermark: number };
};
type Webhook = { object?: string; entry?: { id: string; messaging?: MessagingEvent[] }[] };

export type PageEcho = { userKey: string; mid: string; text: string | null; byHuman: boolean; timestamp: Date };
export type ParsedMessenger = ReceivedPayload & { reads: { userKey: string; watermark: Date }[]; echoes: PageEcho[] };

/** Strictly a number from the phone-sharing quick reply, never typed text. */
function sharedPhoneFrom(payload: string | undefined): string | undefined {
  if (!payload) return undefined;
  let digits = normalizeDigits(payload);
  if (digits.startsWith("01") && digits.length === 11) digits = `88${digits}`;
  const phone = `+${digits}`;
  return /^\+\d{8,15}$/.test(phone) ? phone : undefined;
}

/** Normalizes one Messenger webhook delivery. Does no I/O. */
export function parseMessengerEvent(payload: unknown, appId?: string): ParsedMessenger {
  const out: ParsedMessenger = { messages: [], statuses: [], reads: [], echoes: [] };
  const body = payload as Webhook;
  if (body.object !== "page") return out;
  for (const entry of body.entry ?? []) {
    for (const e of entry.messaging ?? []) {
      const when = new Date(e.timestamp);
      if (e.message?.is_echo) {
        // Sent from the Page: by our app (already stored) or by a person in the Page inbox.
        out.echoes.push({
          userKey: messengerKey(e.recipient.id), mid: e.message.mid, text: e.message.text ?? null,
          byHuman: !e.message.app_id || String(e.message.app_id) !== String(appId ?? ""), timestamp: when,
        });
        continue;
      }
      const userKey = messengerKey(e.sender.id);
      if (e.message) {
        const m = e.message;
        const base = { phone: userKey, timestamp: when };
        if (m.attachments?.length) {
          m.attachments.forEach((a, i) => {
            const waMessageId = m.attachments!.length > 1 ? `${m.mid}#${i}` : m.mid;
            const url = a.payload?.url;
            if (a.type === "audio" && url) out.messages.push({ ...base, waMessageId, type: "voice", mediaId: url });
            else if (a.type === "image" && url && !a.payload?.sticker_id) out.messages.push({ ...base, waMessageId, type: "image", mediaId: url, text: m.text });
            else out.messages.push({ ...base, waMessageId, type: "other" });
          });
        } else {
          const sharedPhone = sharedPhoneFrom(m.quick_reply?.payload);
          out.messages.push({ ...base, waMessageId: m.mid, type: "text", text: m.text ?? "", ...(sharedPhone ? { sharedPhone } : {}) });
        }
      } else if (e.postback) {
        const text = POSTBACK_TEXT[e.postback.payload ?? ""] ?? e.postback.title ?? "";
        out.messages.push({ phone: userKey, timestamp: when, waMessageId: e.postback.mid ?? `pb-${e.sender.id}-${e.timestamp}`, type: "text", text });
      } else if (e.delivery) {
        for (const mid of e.delivery.mids ?? []) {
          const s: StatusUpdate = { waMessageId: mid, status: "delivered", timestamp: when };
          out.statuses.push(s);
        }
      } else if (e.read) {
        out.reads.push({ userKey, watermark: new Date(e.read.watermark) });
      }
    }
  }
  return out;
}

/** Media is fetched only from Meta's CDNs, over HTTPS. Anything else in a payload is refused. */
export function isMessengerMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)(fbcdn\.net|fbsbx\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

type GraphError = { error?: { code?: number; error_subcode?: number; message?: string } };

/**
 * Turns Graph errors into the right retry behaviour. Policy refusals and unreachable users must never be
 * retried: hammering Meta with sends it already refused is how Pages get restricted.
 */
export function classifyGraphError(status: number, body: GraphError): Error {
  const code = body.error?.code;
  const sub = body.error?.error_subcode;
  const detail = `Messenger send failed: ${status} code=${code ?? "?"} subcode=${sub ?? "?"} ${body.error?.message ?? ""}`.trim();
  if (code === 4 || code === 32 || code === 613 || status === 429) return new RetryAfterError(detail, "60s");
  // 10/2018278: outside the messaging window. 551: person unavailable. 100: invalid request, e.g. a deprecated tag. 200: permission.
  if (code === 10 || code === 551 || code === 100 || code === 200 || sub === 2018278 || sub === 2018108 || sub === 1545041) {
    return new PermanentSendError(detail);
  }
  return new Error(detail);
}

export class MessengerAdapter implements ChannelAdapter {
  readonly enforcesServiceWindow = true;
  /** Logical template → approved utility template name (Messenger message tags were retired in April 2026). */
  readonly templateSettingKey = "messenger_templates";

  receiveMessage(payload: unknown): ReceivedPayload {
    const { messages, statuses } = parseMessengerEvent(payload, env.messenger().MESSENGER_APP_ID);
    return { messages, statuses };
  }

  private auth() {
    const cfg = env.messenger();
    const proof = createHmac("sha256", cfg.MESSENGER_APP_SECRET).update(cfg.MESSENGER_PAGE_ACCESS_TOKEN).digest("hex");
    return { cfg, query: `access_token=${encodeURIComponent(cfg.MESSENGER_PAGE_ACCESS_TOKEN)}&appsecret_proof=${proof}` };
  }

  /** Graph call with appsecret_proof, so a leaked Page token alone cannot be used. */
  async graph(method: string, path: string, body?: unknown, form?: FormData): Promise<Response> {
    const { cfg, query } = this.auth();
    const sep = path.includes("?") ? "&" : "?";
    return fetch(`${cfg.MESSENGER_GRAPH_BASE_URL}/${cfg.MESSENGER_GRAPH_VERSION}${path}${sep}${query}`, {
      method,
      headers: form ? undefined : body === undefined ? undefined : { "Content-Type": "application/json" },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  }

  private async sendMessage(payload: Record<string, unknown>, form?: FormData): Promise<SendResult> {
    const res = form ? await this.graph("POST", "/me/messages", undefined, form) : await this.graph("POST", "/me/messages", payload);
    const json = (await res.json().catch(() => ({}))) as GraphError & { message_id?: string };
    if (!res.ok) throw classifyGraphError(res.status, json);
    if (!json.message_id) throw new Error("Messenger send returned no message id");
    return { waMessageId: json.message_id };
  }

  private async senderAction(psid: string, action: "mark_seen" | "typing_on") {
    try {
      await this.graph("POST", "/me/messages", { recipient: { id: psid }, sender_action: action });
    } catch (err) {
      logger.warn({ err }, "sender action failed");
    }
  }

  /** Seen + typing while BS composes. Cosmetic, never blocks the send. */
  private async showTyping(psid: string, text: string) {
    const { per_char_ms: perChar, max_ms: max } = await getSetting<{ per_char_ms: number; max_ms: number }>("typing_indicator");
    if (max <= 0) return;
    await this.senderAction(psid, "mark_seen");
    await this.senderAction(psid, "typing_on");
    await new Promise((r) => setTimeout(r, Math.min(text.length * perChar, max)));
  }

  async sendText(to: string, text: string): Promise<SendResult> {
    const psid = psidOf(to);
    await this.showTyping(psid, text);
    let first: SendResult | undefined;
    for (const part of splitForMessenger(text)) {
      const r = await this.sendMessage({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: part } });
      first ??= r;
    }
    return first!;
  }

  /** Asks for the number on the person's Facebook profile. The button is not shown if the profile has none. */
  requestPhone(to: string, text: string): Promise<SendResult> {
    return this.sendMessage({
      recipient: { id: psidOf(to) }, messaging_type: "RESPONSE",
      message: { text, quick_replies: [{ content_type: "user_phone_number" }] },
    });
  }

  async sendImage(to: string, image: MediaFile, caption?: string): Promise<SendResult> {
    const psid = psidOf(to);
    const form = new FormData();
    form.set("recipient", JSON.stringify({ id: psid }));
    form.set("messaging_type", "RESPONSE");
    form.set("message", JSON.stringify({ attachment: { type: "image", payload: { is_reusable: false } } }));
    form.set("filedata", new Blob([Buffer.from(image.bytes)], { type: image.mime }), "photo");
    const sent = await this.sendMessage({}, form);
    if (caption) await this.sendMessage({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: caption } });
    return sent;
  }

  /** An approved utility template: the only way to message outside the 24-hour window. */
  sendTemplate(to: string, template: string, language: string, params: string[]): Promise<SendResult> {
    return this.sendMessage({
      recipient: { id: psidOf(to) },
      message: {
        template: {
          name: template,
          language: { code: language },
          components: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] : [],
        },
      },
    });
  }

  async downloadMedia(url: string, maxBytes: number): Promise<MediaFile> {
    if (!isMessengerMediaUrl(url)) throw new PermanentSendError("media URL is not on Meta's CDN");
    const res = await fetch(url, { redirect: "error" });
    if (!res.ok) throw new Error(`Messenger media download failed: ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new MediaTooLargeError();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new MediaTooLargeError();
    return { bytes, mime: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim() };
  }
}

/** Page setup: Get Started, greeting and the persistent menu, plus subscribing the app to the Page's events. */
export async function applyMessengerProfile(publicUrl: string) {
  const adapter = new MessengerAdapter();
  const greeting = await getSetting<string>("messenger_greeting");
  const profile = await adapter.graph("POST", "/me/messenger_profile", {
    get_started: { payload: "GET_STARTED" },
    greeting: [{ locale: "default", text: greeting.slice(0, 160) }],
    persistent_menu: [{
      locale: "default",
      composer_input_disabled: false,
      call_to_actions: [
        { type: "postback", title: "মানুষের সাহায্য", payload: "HELP" },
        { type: "postback", title: "আমার তথ্য মুছুন", payload: "STOP_INFO" },
        { type: "web_url", title: "গোপনীয়তা নীতি", url: `${publicUrl}/privacy` },
      ],
    }],
  });
  if (!profile.ok) throw new Error(`Messenger profile update failed: ${profile.status} ${(await profile.text()).slice(0, 300)}`);
  const pageId = env.messenger().MESSENGER_PAGE_ID;
  const fields = "messages,messaging_postbacks,message_deliveries,message_reads,message_echoes";
  const sub = await adapter.graph("POST", `/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=${fields}`);
  if (!sub.ok) throw new Error(`Page subscription failed: ${sub.status} ${(await sub.text()).slice(0, 300)}`);
}

/** Checks the Page token works, without exposing it. */
export async function messengerStatus(): Promise<{ ok: boolean; page?: string; error?: string }> {
  try {
    const res = await new MessengerAdapter().graph("GET", "/me?fields=id,name");
    const json = (await res.json()) as { name?: string } & GraphError;
    return res.ok ? { ok: true, page: json.name } : { ok: false, error: json.error?.message ?? String(res.status) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unreachable" };
  }
}
