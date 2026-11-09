import OpenAI from "openai";
import { env } from "@/lib/env";
import type { ChatMessage, LLMProvider, LLMResult, ToolDefinition } from "./types";

export class DeepSeekProvider implements LLMProvider {
  private client?: OpenAI;
  private model?: string;

  private conn() {
    if (!this.client) {
      const cfg = env.deepseek();
      this.client = new OpenAI({ apiKey: cfg.DEEPSEEK_API_KEY, baseURL: cfg.DEEPSEEK_BASE_URL });
      this.model = cfg.DEEPSEEK_MODEL;
    }
    return { client: this.client, model: this.model! };
  }

  async chat({ messages, tools }: { messages: ChatMessage[]; tools: ToolDefinition[] }): Promise<LLMResult> {
    const { client, model } = this.conn();
    const res = await client.chat.completions.create({ model, temperature: 0.3, messages, tools });
    const message = res.choices[0]?.message;
    if (!message) throw new Error("DeepSeek returned no choices");
    const usage = res.usage as (typeof res.usage & { prompt_cache_hit_tokens?: number }) | undefined;
    return {
      content: message.content,
      toolCalls: (message.tool_calls ?? []).flatMap((c) =>
        c.type === "function" ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : [],
      ),
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.prompt_cache_hit_tokens ?? 0,
      },
    };
  }
}
