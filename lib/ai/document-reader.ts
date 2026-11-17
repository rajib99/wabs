import OpenAI from "openai";
import { env } from "@/lib/env";
import { toAsciiDigits } from "@/lib/text";
import type { DocumentReader, DocumentReading } from "./types";

const MAX_TEXT = 6000;
/** Below this a PDF has no text layer (a scan), and there is nothing to read without OCR. */
const MIN_PDF_TEXT = 40;

const isPdf = (file: { bytes: Uint8Array; mime: string }) =>
  file.mime.includes("pdf") || Buffer.from(file.bytes.subarray(0, 5)).toString("latin1") === "%PDF-";

/**
 * Numbers in a biodata are not taken as the person's contact number (that is asked, and verified, at the end),
 * so they never reach the model at all.
 */
export function redactPhones(text: string): string {
  return toAsciiDigits(text).replace(/(?:\+?\s*88[\s-]*)?0?[\s-]*1[3-9](?:[\s-]*\d){8}/g, "[নম্বর]");
}

const finish = (kind: DocumentReading["kind"], text = ""): DocumentReading =>
  ({ kind, text: kind === "biodata" ? redactPhones(text.trim()).slice(0, MAX_TEXT) : "" });

/** Plain text extraction, no AI: a PDF made from Word or a biodata site carries its text. */
async function readPdf(bytes: Uint8Array): Promise<DocumentReading> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.replace(/\s+\n/g, "\n").trim().length >= MIN_PDF_TEXT ? finish("biodata", text) : finish("unreadable");
  } catch {
    return finish("unreadable");
  }
}

const VISION_PROMPT = `You read files sent to a Bangladeshi matrimonial (marriage) service.
Decide what this image is:
- "biodata": a marriage biodata / profile document or a screenshot of one (text with details such as name, age, education, job, family, religion, address, partner expectations).
- "photo": a photograph of a person.
- "other": anything else.
Reply with JSON only: {"kind": "biodata" | "photo" | "other", "text": "..."}.
For "biodata", put every piece of text in "text" exactly as written (keep Bengali in Bengali script), one "label: value" per line. For the other kinds, "text" is "".`;

export class VisionDocumentReader implements DocumentReader {
  private client?: OpenAI;
  private model?: string;

  private conn() {
    if (!this.client) {
      const cfg = env.vision();
      // A person is waiting for a reply: a slow reader must give up quickly so the photo path takes over.
      this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 20_000, maxRetries: 1 });
      this.model = cfg.model;
    }
    return { client: this.client, model: this.model! };
  }

  async read(file: { bytes: Uint8Array; mime: string }): Promise<DocumentReading> {
    if (isPdf(file)) return readPdf(file.bytes);
    if (!file.mime.startsWith("image/")) return finish("unreadable");
    const { client, model } = this.conn();
    const res = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT },
          { type: "image_url", image_url: { url: `data:${file.mime};base64,${Buffer.from(file.bytes).toString("base64")}` } },
        ],
      }],
    });
    return parseVisionReply(res.choices[0]?.message?.content ?? "");
  }
}

export function parseVisionReply(content: string): DocumentReading {
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return finish("other");
  try {
    const parsed = JSON.parse(json) as { kind?: string; text?: string };
    const kind = parsed.kind === "biodata" || parsed.kind === "photo" ? parsed.kind : "other";
    // A "biodata" with no text is useless; fall back to the photo handling.
    if (kind === "biodata" && (parsed.text ?? "").trim().length < 20) return finish("other");
    return finish(kind, parsed.text ?? "");
  } catch {
    return finish("other");
  }
}

/** Development stand-in: PDFs are read for real (no AI involved); images are treated as photos. */
export class MockDocumentReader implements DocumentReader {
  async read(file: { bytes: Uint8Array; mime: string }): Promise<DocumentReading> {
    if (isPdf(file)) return readPdf(file.bytes);
    return finish(file.mime.startsWith("image/") ? "photo" : "unreadable");
  }
}
