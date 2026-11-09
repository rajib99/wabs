/**
 * Extraction accuracy on 50 Bengali messages. Uses the provider selected by LLM_PROVIDER and the live
 * system prompt, so `LLM_PROVIDER=deepseek pnpm eval:extraction` measures what production will do.
 * Scores are only meaningful with a real LLM; the mock run just proves the harness works.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getLLM, type ChatMessage } from "@/lib/ai";
import { TOOL_DEFINITIONS } from "@/lib/conversation/tools";
import { closeDb } from "@/lib/db";
import { loadQuestions, validateAnswer } from "@/lib/profile";
import { getSetting } from "@/lib/settings";
import { EVAL_SET, type EvalCase } from "./eval-set";

const PASS_MARK = Number(process.env.EVAL_PASS_MARK ?? 0.85);

type Extracted = { answers: Map<string, unknown>; prefs: Map<string, { value: unknown; dealbreaker: boolean }> };
const same = (a: unknown, b: unknown) => {
  const norm = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].map(String).sort() : v);
  return norm(a) === norm(b);
};

const questions = await loadQuestions();
const byKey = new Map(questions.map((q) => [q.key, q]));
const system = await getSetting<string>("system_prompt");
const context = JSON.stringify({
  profile: {}, profile_complete: false, preferences: [], to_confirm: [], active_matches: [], pending_photo_requests: [], pending_photo_confirmations: 0,
  payments: [], payment_info: null, similar_past_messages: [],
  questions: questions.map((q) => ({ key: q.key, text: q.bengaliText, type: q.fieldType, options: q.options, answered: false })),
});

async function extract(text: string): Promise<Extracted> {
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "system", content: context }, { role: "user", content: text }];
  const out: Extracted = { answers: new Map(), prefs: new Map() };
  const llm = getLLM();
  for (let round = 0; round < 4; round++) {
    const res = await llm.chat({ messages, tools: TOOL_DEFINITIONS });
    if (!res.toolCalls.length) break;
    messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) });
    for (const call of res.toolCalls) {
      let result: unknown = { ok: true };
      try {
        const args = JSON.parse(call.arguments) as Record<string, unknown>;
        if (call.name === "save_answer") {
          const q = byKey.get(String(args.question_key));
          const parsed = q ? validateAnswer(q, args.value) : { ok: false as const, error: "unknown key" };
          if (parsed.ok) out.answers.set(String(args.question_key), parsed.value);
          result = parsed;
        } else if (call.name === "save_preference") {
          out.prefs.set(String(args.field), { value: args.value, dealbreaker: args.is_dealbreaker === true });
        } else if (call.name === "get_next_question") {
          result = { questions: [] };
        }
      } catch {
        result = { ok: false, error: "invalid JSON" };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return out;
}

function grade(c: EvalCase, got: Extracted) {
  const missed: string[] = [];
  const wrong: string[] = [];
  let correct = 0;
  let expected = 0;
  for (const [key, value] of Object.entries(c.answers ?? {})) {
    expected++;
    if (!got.answers.has(key)) missed.push(key);
    else if (!same(got.answers.get(key), value)) wrong.push(`${key}=${JSON.stringify(got.answers.get(key))}`);
    else correct++;
  }
  for (const [field, want] of Object.entries(c.prefs ?? {})) {
    expected++;
    const p = got.prefs.get(field);
    if (!p) missed.push(`pref:${field}`);
    else if (p.dealbreaker !== want.dealbreaker) wrong.push(`pref:${field} dealbreaker=${p.dealbreaker}`);
    else correct++;
  }
  // Facts nobody stated are a correctness problem too.
  const invented = [...got.answers.keys()].filter((k) => !(c.answers && k in c.answers) && !(c.allow ?? []).includes(k));
  const pass = !missed.length && !wrong.length && !invented.length;
  return { pass, correct, expected, missed, wrong, invented };
}

let passed = 0, correct = 0, expected = 0, invented = 0;
const rows: unknown[] = [];
for (const c of EVAL_SET) {
  try {
    const g = grade(c, await extract(c.text));
    passed += g.pass ? 1 : 0;
    correct += g.correct;
    expected += g.expected;
    invented += g.invented.length;
    rows.push({ text: c.text, ...g });
    if (!g.pass) console.log(`MISS "${c.text}"  missed=${g.missed.join(",")}  wrong=${g.wrong.join(",")}  invented=${g.invented.join(",")}`);
  } catch (err) {
    rows.push({ text: c.text, error: String(err) });
    console.log(`ERROR "${c.text}": ${String(err)}`);
  }
}
const messageAccuracy = passed / EVAL_SET.length;
const fieldRecall = expected ? correct / expected : 0;
console.log(`\nprovider=${process.env.LLM_PROVIDER}  messages=${EVAL_SET.length}`);
console.log(`message accuracy ${(messageAccuracy * 100).toFixed(1)}%  field recall ${(fieldRecall * 100).toFixed(1)}%  invented facts ${invented}`);
writeFileSync(process.env.EVAL_REPORT ?? ".data/eval-report.json", JSON.stringify({ messageAccuracy, fieldRecall, invented, rows }, null, 2));
await closeDb();
process.exit(messageAccuracy >= PASS_MARK ? 0 : 1);
