import { eq } from "drizzle-orm";
import { type ChatMessage, getLLM, type LLMUsage } from "@/lib/ai";
import { audit } from "@/lib/audit";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { meetsMinimumAge } from "@/lib/matching/find";
import { answersToValues, loadAnswers } from "@/lib/profile";
import { guardReply, looksLikeInjection } from "@/lib/safety";
import { getSetting, msg } from "@/lib/settings";
import { buildContext, markConfirmationsAsked } from "./context";
import { queueText } from "./outbound";
import { executeTool, TOOL_DEFINITIONS, TOOL_SCHEMAS, type ToolName, type TurnState } from "./tools";

const MAX_ROUNDS = 6;

export type TurnResult = { replyKey: string; profileChanged: boolean; profileCompleted: boolean };

export const replyKey = (messageId: string) => `reply-${messageId}`;

/** Runs the LLM/tool loop. Tools are idempotent, so a retried step converges on the same state. */
export async function runAgentTurn(phone: string, messageId: string, text: string): Promise<TurnResult> {
  const key = replyKey(messageId);
  if (looksLikeInjection(text)) await audit("user", "safety.injection_suspected", "message", messageId);

  const [systemPrompt, { context, history }] = await Promise.all([getSetting<string>("system_prompt"), buildContext(phone, messageId, text)]);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt }, // fixed prefix, so DeepSeek's context cache applies
    { role: "system", content: JSON.stringify(context) },
    ...history,
    { role: "user", content: text },
  ];

  const turn: TurnState = { phone, messageId, userText: text, profileChanged: false, profileCompleted: false, ended: null };
  const usage: LLMUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  const llm = getLLM();
  let invalidCalls = 0;
  let reply: string | null = null;

  rounds: for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await llm.chat({ messages, tools: TOOL_DEFINITIONS });
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    usage.cachedTokens += res.usage.cachedTokens;

    if (!res.toolCalls.length) {
      reply = res.content;
      break;
    }
    messages.push({
      role: "assistant",
      content: res.content,
      tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
    });
    for (const call of res.toolCalls) {
      const tool = TOOL_SCHEMAS[call.name as ToolName];
      let parsed: unknown;
      let error: string | null = tool ? null : `unknown tool ${call.name}`;
      if (tool) {
        try {
          parsed = tool.schema.parse(JSON.parse(call.arguments || "{}"));
        } catch (err) {
          error = `invalid arguments: ${err instanceof Error ? err.message : "bad JSON"}`;
        }
      }
      if (error) {
        // One correction attempt, then the safe reply.
        if (++invalidCalls > 1) break rounds;
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error }) });
        continue;
      }
      const result = await executeTool(call.name as ToolName, parsed, turn);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      if (turn.ended) break rounds;
    }
  }

  logger.info({ messageId, ...usage }, "agent reply tokens");

  if (turn.ended === "underage") {
    // The conversation is gone, so this reply is not stored or embedded.
    await queueText(phone, await msg("underage_end"), key, usage);
    return { replyKey: key, profileChanged: false, profileCompleted: false };
  }

  const bkash = context.payment_info?.bkash_number;
  let finalText = guardReply(reply?.trim() || (await msg("fallback")), [phone, ...(bkash ? [bkash] : [])]);

  if (turn.profileCompleted) {
    const [user] = await db().select().from(schema.users).where(eq(schema.users.phone, phone));
    const answers = answersToValues(await loadAnswers(phone));
    if (!meetsMinimumAge(user?.gender ?? null, answers, await getSetting("min_match_age"))) {
      finalText = `${finalText}\n\n${await msg("below_legal_age")}`;
    }
  }

  await markConfirmationsAsked(phone, context.to_confirm.map((c) => c.question_key));
  await queueText(phone, finalText, key, usage);
  return { replyKey: key, profileChanged: turn.profileChanged, profileCompleted: turn.profileCompleted };
}
