import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import {
  type ChannelAdapter, type InboundMessage, type MediaFile, MediaTooLargeError, type ReceivedPayload, type SendResult, type StatusUpdate,
} from "./types";

/** Validates the X-Hub-Signature-256 header against the raw request body. */
export function verifyWhatsAppSignature(rawBody: string | Uint8Array, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type WaMessage = {
  id: string; from: string; timestamp: string; type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string };
  image?: { id: string; mime_type?: string; caption?: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
};
type WaStatus = { id: string; status: string; timestamp: string };
type WaWebhook = { entry?: { changes?: { value?: { messages?: WaMessage[]; statuses?: WaStatus[] } }[] }[] };

const when = (epoch: string) => new Date(Number(epoch) * 1000);

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly enforcesServiceWindow = true;

  receiveMessage(payload: unknown): ReceivedPayload {
    const messages: InboundMessage[] = [];
    const statuses: StatusUpdate[] = [];
    for (const entry of (payload as WaWebhook).entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          const base = { waMessageId: m.id, phone: `+${m.from}`, timestamp: when(m.timestamp) };
          if (m.type === "text") messages.push({ ...base, type: "text", text: m.text?.body ?? "" });
          else if (m.type === "button") messages.push({ ...base, type: "text", text: m.button?.text ?? "" });
          else if (m.type === "interactive") {
            messages.push({ ...base, type: "text", text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "" });
          } else if (m.type === "audio") messages.push({ ...base, type: "voice", mediaId: m.audio?.id, mediaMime: m.audio?.mime_type });
          else if (m.type === "image") messages.push({ ...base, type: "image", mediaId: m.image?.id, mediaMime: m.image?.mime_type, text: m.image?.caption });
          else messages.push({ ...base, type: "other" });
        }
        for (const s of change.value?.statuses ?? []) {
          if (s.status === "sent" || s.status === "delivered" || s.status === "read" || s.status === "failed") {
            statuses.push({ waMessageId: s.id, status: s.status, timestamp: when(s.timestamp) });
          }
        }
      }
    }
    return { messages, statuses };
  }

  private base() {
    const cfg = env.whatsapp();
    return { url: `${cfg.WHATSAPP_GRAPH_BASE_URL}/${cfg.WHATSAPP_GRAPH_VERSION}`, cfg, auth: { Authorization: `Bearer ${cfg.WHATSAPP_ACCESS_TOKEN}` } };
  }

  private async send(to: string, body: Record<string, unknown>): Promise<SendResult> {
    const { url, cfg, auth } = this.base();
    const res = await fetch(`${url}/${cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/^\+/, ""), ...body }),
    });
    if (!res.ok) throw new Error(`Graph API send failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { messages?: { id: string }[] };
    const id = json.messages?.[0]?.id;
    if (!id) throw new Error("Graph API send returned no message id");
    return { waMessageId: id };
  }

  sendText(to: string, text: string) {
    return this.send(to, { type: "text", text: { body: text, preview_url: false } });
  }

  async sendImage(to: string, image: MediaFile, caption?: string) {
    const { url, cfg, auth } = this.base();
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", image.mime);
    form.set("file", new Blob([Buffer.from(image.bytes)], { type: image.mime }), "photo");
    const res = await fetch(`${url}/${cfg.WHATSAPP_PHONE_NUMBER_ID}/media`, { method: "POST", headers: auth, body: form });
    if (!res.ok) throw new Error(`Graph API media upload failed: ${res.status} ${await res.text()}`);
    const { id } = (await res.json()) as { id: string };
    return this.send(to, { type: "image", image: { id, caption } });
  }

  sendTemplate(to: string, template: string, language: string, params: string[]) {
    return this.send(to, {
      type: "template",
      template: {
        name: template,
        language: { code: language },
        components: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] : [],
      },
    });
  }

  async downloadMedia(mediaId: string, maxBytes: number): Promise<MediaFile> {
    const { url, auth } = this.base();
    const metaRes = await fetch(`${url}/${mediaId}`, { headers: auth });
    if (!metaRes.ok) throw new Error(`Graph API media lookup failed: ${metaRes.status}`);
    const meta = (await metaRes.json()) as { url: string; mime_type: string; file_size?: number };
    if ((meta.file_size ?? 0) > maxBytes) throw new MediaTooLargeError();
    const file = await fetch(meta.url, { headers: auth });
    if (!file.ok) throw new Error(`Graph API media download failed: ${file.status}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new MediaTooLargeError();
    return { bytes, mime: meta.mime_type };
  }
}
