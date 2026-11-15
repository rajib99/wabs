import { env } from "@/lib/env";
import { DeepSeekProvider } from "./deepseek";
import { MockDocumentReader, VisionDocumentReader } from "./document-reader";
import { E5Embedder, MockEmbedder } from "./embedder";
import { MockLLMProvider } from "./mock-llm";
import { GroqTranscriber, MockTranscriber } from "./transcriber";
import type { DocumentReader, Embedder, LLMProvider, Transcriber } from "./types";

export * from "./types";

const cache = globalThis as unknown as { __bsAi?: { llm?: LLMProvider; transcriber?: Transcriber; embedder?: Embedder; docReader?: DocumentReader } };
const ai = (cache.__bsAi ??= {});

export function getLLM(): LLMProvider {
  if (env.llmProvider() === "mock" && env.channel() !== "mock") {
    throw new Error(`LLM_PROVIDER=mock cannot talk to real people on CHANNEL=${env.channel()}`);
  }
  return (ai.llm ??= env.llmProvider() === "deepseek" ? new DeepSeekProvider() : new MockLLMProvider());
}

export function getTranscriber(): Transcriber {
  return (ai.transcriber ??= env.transcriber() === "groq" ? new GroqTranscriber() : new MockTranscriber());
}

export function getDocumentReader(): DocumentReader {
  return (ai.docReader ??= env.docReader() === "vision" ? new VisionDocumentReader() : new MockDocumentReader());
}

export function getEmbedder(): Embedder {
  return (ai.embedder ??= env.embedder() === "e5" ? new E5Embedder() : new MockEmbedder());
}

/** Test hook for injecting failing or scripted providers. */
export function setAiForTests(overrides: Partial<NonNullable<typeof cache.__bsAi>>) {
  Object.assign(ai, overrides);
}
