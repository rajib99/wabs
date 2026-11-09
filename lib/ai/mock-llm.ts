import type { AgentContext } from "@/lib/conversation/context";
import { allDistricts } from "@/lib/matching/districts";
import { toAsciiDigits } from "@/lib/text";
import type { ChatMessage, LLMProvider, LLMResult, ToolDefinition } from "./types";

/**
 * Deterministic, rule-based stand-in used for development and tests when no LLM key is set.
 * It speaks the real tool protocol, so everything around the LLM is exercised for real.
 * It is NOT a measure of extraction quality.
 */
type Call = { name: string; args: Record<string, unknown> };

const JOB_WORDS: [RegExp, string][] = [[/আধা[- ]?সরকারি/, "semi_govt"], [/বেসরকারি|প্রাইভেট/, "private"], [/সরকারি/, "govt"], [/ব্যবসা/, "business"]];
const EDU_WORDS: [RegExp, string][] = [[/পিএইচডি/, "phd"], [/স্নাতকোত্তর|মাস্টার্স/, "masters"], [/স্নাতক|অনার্স|বিএসসি|বিএ\b/, "bachelor"], [/ডিপ্লোমা/, "diploma"], [/এইচএসসি/, "hsc"], [/এসএসসি/, "ssc"]];
const RELIGION_WORDS: [RegExp, string][] = [[/মুসলিম|মুসলমান|ইসলাম/, "muslim"], [/হিন্দু/, "hindu"], [/খ্রিস্টান/, "christian"], [/বৌদ্ধ/, "buddhist"]];
const MARITAL_WORDS: [RegExp, string][] = [[/অবিবাহিত/, "never_married"], [/তালাক|ডিভোর্স/, "divorced"], [/বিধবা|বিপত্নীক/, "widowed"]];

const first = (t: string, words: [RegExp, string][]) => words.find(([re]) => re.test(t))?.[1];

function parseDirectAnswer(q: AgentContext["questions"][number], text: string): unknown {
  const t = toAsciiDigits(text).trim();
  const numbers = (t.match(/\d+/g) ?? []).map(Number);
  const options = (Array.isArray(q.options) ? q.options : []) as { value: string; label: string }[];
  const fromOptions = options.filter((o) => text.includes(o.label) || t.toLowerCase() === o.value);
  switch (q.type) {
    case "number": return q.key === "height_cm" ? t : numbers[0];
    case "range": return numbers.length >= 2 ? { min: numbers[0]!, max: numbers[1]! } : undefined;
    case "select":
      if (q.key === "gender") return /মহিলা|পাত্রী|মেয়ে|নারী/.test(t) ? "female" : /পুরুষ|পাত্র|ছেলে/.test(t) ? "male" : undefined;
      if (q.key === "job_type") return first(t, JOB_WORDS) ?? fromOptions[0]?.value;
      if (q.key === "education") return first(t, EDU_WORDS) ?? fromOptions[0]?.value;
      if (q.key === "religion") return first(t, RELIGION_WORDS) ?? fromOptions[0]?.value;
      if (q.key === "marital_status") return first(t, MARITAL_WORDS) ?? fromOptions[0]?.value;
      if (q.key === "created_by_relation") return /নিজের|আমার/.test(t) ? "self" : /সন্তান|ছেলের|মেয়ের/.test(t) ? "parent" : /ভাই|বোন/.test(t) ? "sibling" : "other";
      return fromOptions[0]?.value;
    case "multiselect": {
      if (/যেকোনো|যে কোনো/.test(t)) return ["any"];
      const words = q.key === "preferred_job_type" ? JOB_WORDS : EDU_WORDS;
      const hits = words.filter(([re]) => re.test(t)).map(([, v]) => v);
      return hits.length ? hits : undefined;
    }
    case "district": return allDistricts().find((d) => t.includes(d.bn))?.slug;
    case "location_list": {
      if (/যেকোনো|যে কোনো/.test(t)) return ["any"];
      const hits = allDistricts().filter((d) => t.includes(d.bn)).map((d) => d.slug);
      return hits.length ? hits : undefined;
    }
    default: return text.trim() || undefined;
  }
}

function extractVolunteered(text: string, ctx: AgentContext, skip: string | undefined): Call[] {
  const t = toAsciiDigits(text);
  const calls: Call[] = [];
  const save = (key: string, value: unknown) => {
    if (key === skip || ctx.profile[key]) return;
    calls.push({ name: "save_answer", args: { question_key: key, value, source: "volunteered", confidence: 0.9 } });
  };
  const age = t.match(/(\d{2})\s*বছর/) ?? t.match(/বয়স\s*(\d{2})/);
  if (age) save("age", Number(age[1]));
  if (/আমি (একজন )?(মেয়ে|মহিলা|নারী)|পাত্রীর প্রোফাইল/.test(t)) save("gender", "female");
  if (/আমি (একজন )?(ছেলে|পুরুষ)|পাত্রের প্রোফাইল/.test(t)) save("gender", "male");
  const name = t.match(/(?:আমার নাম|নাম)\s+([^\s,।]+)/);
  if (name) save("name", name[1]);
  const home = allDistricts().find((d) => t.includes(`${d.bn}য়`) || t.includes(`${d.bn}র`) || t.includes(`${d.bn}তে`) || t.includes(d.bn));
  const wantsOnly = /শুধু|অবশ্যই|ছাড়া/.test(t);
  if (home && !wantsOnly) save("district", home.slug);
  const religion = first(t, RELIGION_WORDS);
  if (religion && !wantsOnly) save("religion", religion);
  const job = first(t, JOB_WORDS);
  if (job && /চাকরি করি|আমি .*চাকরি|ব্যবসা করি/.test(t) && !wantsOnly) save("job_type", job);
  const edu = first(t, EDU_WORDS);
  if (edu && /পাস|পড়েছি|করেছি/.test(t) && !wantsOnly) save("education", edu);
  const marital = first(t, MARITAL_WORDS);
  if (marital) save("marital_status", marital);

  if (wantsOnly) {
    if (job) calls.push({ name: "save_preference", args: { field: "job_type", operator: "in", value: job === "govt" ? ["govt", "semi_govt"] : [job], is_dealbreaker: true } });
    if (religion) calls.push({ name: "save_preference", args: { field: "religion", operator: "eq", value: religion, is_dealbreaker: true } });
    if (home) calls.push({ name: "save_preference", args: { field: "district", operator: "in", value: [home.slug], is_dealbreaker: true } });
  }
  return calls;
}

function firstRound(text: string, ctx: AgentContext, lastAssistant: string): Call[] {
  const t = toAsciiDigits(text);
  const yes = /(^|\s)(হ্যাঁ|হ্যা|জি|রাজি|yes)/i.test(t) && !/(^|\s)না(\s|$|।)/.test(t);
  const no = /(^|\s)(না|নাহ|no)(\s|$|।)/i.test(t);

  if (ctx.pending_photo_confirmations > 0 && (yes || no)) return [{ name: "confirm_profile_photo", args: { is_profile_photo: yes } }];
  const photoReq = ctx.pending_photo_requests[0];
  if (photoReq && (yes || no)) return [{ name: "respond_to_photo_request", args: { request_id: photoReq.request_id, allow: yes } }];

  const payable = ctx.active_matches.find((m) => m.payment_open);
  const wallet = t.match(/01\d{9}/)?.[0];
  const trx = t.match(/\b(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,12}\b/)?.[0];
  if (payable && wallet && trx) return [{ name: "submit_payment", args: { match_id: payable.match_id, wallet_number: wallet, trx_id: trx } }];

  const turnMatch = ctx.active_matches.find((m) => m.your_turn) ?? ctx.active_matches[0];
  if (turnMatch && /রিপোর্ট|হয়রানি/.test(t)) return [{ name: "report_match", args: { match_id: turnMatch.match_id, reason: text } }];
  if (turnMatch && /ছবি/.test(t)) return [{ name: "request_photo", args: { match_id: turnMatch.match_id } }];
  if (turnMatch && /আগ্রহী নই|আগ্রহ নেই/.test(t)) return [{ name: "respond_to_match", args: { match_id: turnMatch.match_id, action: "decline" } }];
  if (turnMatch?.your_turn && /আগ্রহী/.test(t)) return [{ name: "respond_to_match", args: { match_id: turnMatch.match_id, action: "interested" } }];
  if (/সাহায্য|মানুষের সাথে/.test(t)) return [{ name: "escalate_to_human", args: { reason: text } }];

  const asked = ctx.questions.find((q) => !q.answered && lastAssistant.includes(q.text));
  const calls: Call[] = [];
  if (asked) {
    const value = parseDirectAnswer(asked, text);
    if (value !== undefined) calls.push({ name: "save_answer", args: { question_key: asked.key, value, source: "asked", confidence: 0.95 } });
  }
  calls.push(...extractVolunteered(text, ctx, asked?.key));
  if (!ctx.profile_complete) calls.push({ name: "get_next_question", args: {} });
  return calls;
}

function finalReply(results: { name: string; result: Record<string, unknown> }[]): string {
  const parts: string[] = [];
  for (const { name, result } of results) {
    if (result.ok === false) parts.push(`দুঃখিত, হয়নি: ${String(result.error)}`);
    else if (typeof result.note === "string") parts.push(name === "respond_to_match" ? "ধন্যবাদ, আপনার মতামত জানিয়েছি।" : /[ঀ-৿]/.test(result.note) ? result.note : "ধন্যবাদ।");
  }
  const next = results.find((r) => r.name === "get_next_question")?.result as { questions?: { text: string }[]; profile_complete?: boolean } | undefined;
  if (next?.questions?.length) parts.push(`ধন্যবাদ। ${next.questions[0]!.text}`);
  else if (next?.profile_complete) parts.push("আপনার প্রোফাইল সম্পূর্ণ হয়েছে, ধন্যবাদ! উপযুক্ত প্রস্তাব পেলে জানাব।");
  return parts.join(" ") || "ধন্যবাদ।";
}

export class MockLLMProvider implements LLMProvider {
  async chat({ messages }: { messages: ChatMessage[]; tools: ToolDefinition[] }): Promise<LLMResult> {
    const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    const ctx = JSON.parse((messages[1] as { content: string }).content) as AgentContext;
    let lastUser = messages.length - 1;
    while (lastUser >= 0 && messages[lastUser]!.role !== "user") lastUser--;
    const after = messages.slice(lastUser + 1);

    if (after.length === 0) {
      const text = (messages[lastUser] as { content: string }).content;
      const prior = [...messages.slice(0, lastUser)].reverse().find((m) => m.role === "assistant") as { content: string | null } | undefined;
      const calls = firstRound(text, ctx, prior?.content ?? "");
      if (!calls.length) return { content: "ধন্যবাদ।", toolCalls: [], usage };
      return { content: null, toolCalls: calls.map((c, i) => ({ id: `call_${i}`, name: c.name, arguments: JSON.stringify(c.args) })), usage };
    }

    const assistant = after[0] as Extract<ChatMessage, { role: "assistant" }>;
    const names = new Map((assistant.tool_calls ?? []).map((c) => [c.id, c.function.name]));
    const results = after.flatMap((m) => m.role === "tool" ? [{ name: names.get(m.tool_call_id) ?? "", result: JSON.parse(m.content) as Record<string, unknown> }] : []);
    return { content: finalReply(results), toolCalls: [], usage };
  }
}
