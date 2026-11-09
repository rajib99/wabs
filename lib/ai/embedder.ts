import { createHash } from "node:crypto";
import type { Embedder } from "./types";

export const EMBEDDING_DIMENSIONS = 384;

/** multilingual-e5-small on CPU. The model loads once, on first use. */
export class E5Embedder implements Embedder {
  private extractor?: Promise<(text: string, opts: object) => Promise<{ data: Float32Array }>>;

  private load() {
    this.extractor ??= import("@huggingface/transformers").then(async ({ pipeline, env: hf }) => {
      if (process.env.HF_CACHE_DIR) hf.cacheDir = process.env.HF_CACHE_DIR;
      const pipe = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" });
      return pipe as unknown as (text: string, opts: object) => Promise<{ data: Float32Array }>;
    });
    return this.extractor;
  }

  async embed(text: string, kind: "query" | "passage"): Promise<number[]> {
    const extract = await this.load();
    const out = await extract(`${kind}: ${text}`, { pooling: "mean", normalize: true });
    return Array.from(out.data);
  }
}

/** Development embedder: deterministic hashed bag-of-words. No model download. */
export class MockEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const v: number[] = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const h = createHash("md5").update(word).digest();
      v[h.readUInt16LE(0) % EMBEDDING_DIMENSIONS]! += 1;
    }
    if (Math.hypot(...v) === 0) v[0] = 1; // empty text still needs a valid vector
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  }
}
