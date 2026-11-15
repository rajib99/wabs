export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type LLMUsage = { promptTokens: number; completionTokens: number; cachedTokens: number };

export type LLMResult = {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: LLMUsage;
};

export interface LLMProvider {
  chat(req: { messages: ChatMessage[]; tools: ToolDefinition[] }): Promise<LLMResult>;
}

export type Transcription = { text: string; seconds: number };

export interface Transcriber {
  transcribe(audio: Uint8Array, mime: string): Promise<Transcription>;
}

/** biodata: a profile document, with its text. photo: a picture of a person. unreadable: a file we could not read. */
export type DocumentReading = { kind: "biodata" | "photo" | "other" | "unreadable"; text: string };

export interface DocumentReader {
  read(file: { bytes: Uint8Array; mime: string }): Promise<DocumentReading>;
}

export interface Embedder {
  /** Returns a normalized 384-dimension vector. */
  embed(text: string, kind: "query" | "passage"): Promise<number[]>;
}
