import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { env } from "@/lib/env";
import type { Transcriber, Transcription } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GroqTranscriber implements Transcriber {
  private client?: OpenAI;
  constructor(private readonly opts: { maxAttempts?: number; baseDelayMs?: number } = {}) {}

  private conn() {
    if (!this.client) {
      const cfg = env.groq();
      // Retries are handled below so 429s use our own backoff.
      this.client = new OpenAI({ apiKey: cfg.GROQ_API_KEY, baseURL: cfg.GROQ_BASE_URL, maxRetries: 0 });
    }
    return this.client;
  }

  async transcribe(audio: Uint8Array, mime: string): Promise<Transcription> {
    const client = this.conn();
    const ext = mime.includes("mpeg") ? "mp3" : mime.includes("mp4") ? "m4a" : mime.includes("wav") ? "wav" : "ogg";
    const maxAttempts = this.opts.maxAttempts ?? 5;
    const baseDelayMs = this.opts.baseDelayMs ?? 1000;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = (await client.audio.transcriptions.create({
          file: await toFile(Buffer.from(audio), `voice.${ext}`, { type: mime }),
          model: "whisper-large-v3",
          language: "bn",
          response_format: "verbose_json",
        })) as unknown as { text: string; duration?: number };
        return { text: res.text.trim(), seconds: res.duration ?? 0 };
      } catch (err) {
        if (!(err instanceof OpenAI.APIError) || err.status !== 429 || attempt >= maxAttempts) throw err;
        const retryAfter = Number(err.headers?.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}

/** Development transcriber: looks the audio's SHA-256 up in samples/voice/manifest.json. */
export class MockTranscriber implements Transcriber {
  async transcribe(audio: Uint8Array): Promise<Transcription> {
    const raw = await readFile(path.resolve("samples/voice/manifest.json"), "utf8").catch(() => "{}");
    const manifest = JSON.parse(raw) as Record<string, Transcription>;
    const hash = createHash("sha256").update(audio).digest("hex");
    return manifest[hash] ?? { text: "", seconds: 1 };
  }
}
