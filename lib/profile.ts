import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { normalizeDistrict, normalizeLocation } from "@/lib/matching/districts";
import { toAsciiDigits } from "@/lib/text";

export type Question = typeof schema.questions.$inferSelect;
export type Answer = typeof schema.profileAnswers.$inferSelect;
type Option = { value: string; label: string };

export const CONFIDENT = 0.8;

/** A key counts as answered when confident, or when a low-confidence answer has already been confirmed once. */
export const isSettled = (a: Pick<Answer, "confidence" | "confirmAskedAt"> | undefined) =>
  !!a && (a.confidence >= CONFIDENT || a.confirmAskedAt != null);

type Rule = { field: string; op?: "eq" | "neq" | "in" | "exists"; value?: unknown };
type Condition = Rule | { all: Rule[] } | { any: Rule[] } | null | undefined;

/** Evaluates a question's ask_condition, e.g. {"field":"gender","op":"eq","value":"female"}. */
export function conditionMet(condition: unknown, answers: Record<string, unknown>): boolean {
  const c = condition as Condition;
  if (!c) return true;
  if ("all" in c) return c.all.every((r) => conditionMet(r, answers));
  if ("any" in c) return c.any.some((r) => conditionMet(r, answers));
  const have = answers[c.field];
  switch (c.op ?? "eq") {
    case "exists": return have != null;
    case "neq": return have != null && have !== c.value;
    case "in": return Array.isArray(c.value) && c.value.includes(have);
    default: return have === c.value;
  }
}

export const loadQuestions = () =>
  db().select().from(schema.questions).where(eq(schema.questions.active, true)).orderBy(asc(schema.questions.order));

export const loadAnswers = (phone: string) =>
  db().select().from(schema.profileAnswers).where(eq(schema.profileAnswers.phone, phone));

export const answersToValues = (rows: Pick<Answer, "questionKey" | "value">[]) =>
  Object.fromEntries(rows.map((r) => [r.questionKey, r.value]));

/** Pure selection logic: unanswered active questions whose condition holds, in priority order. */
export function pendingQuestions(questions: Question[], answers: Answer[]): Question[] {
  const byKey = new Map(answers.map((a) => [a.questionKey, a]));
  const values = answersToValues(answers);
  return questions.filter((q) => q.active && !isSettled(byKey.get(q.key)) && conditionMet(q.askCondition, values));
}

export async function getNextQuestion(phone: string): Promise<Question | null> {
  const [questions, answers] = await Promise.all([loadQuestions(), loadAnswers(phone)]);
  return pendingQuestions(questions, answers)[0] ?? null;
}

export function isProfileComplete(questions: Question[], answers: Answer[]): boolean {
  return pendingQuestions(questions, answers).every((q) => !q.required);
}

function matchOption(options: Option[], input: unknown): string | null {
  const v = String(input).trim().toLowerCase();
  return options.find((o) => o.value.toLowerCase() === v || o.label.toLowerCase() === v)?.value ?? null;
}

function parseHeightCm(input: unknown): number | null {
  const s = toAsciiDigits(String(input));
  const m = s.match(/(\d)\s*(?:ফুট|feet|ft|'|’)\s*(\d{1,2})?/i);
  if (m) return Math.round(Number(m[1]) * 30.48 + Number(m[2] ?? 0) * 2.54);
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseRange(input: unknown): { min: number; max: number } | null {
  let nums: number[] = [];
  if (Array.isArray(input)) nums = input.map(Number);
  else if (input && typeof input === "object") {
    const o = input as { min?: unknown; max?: unknown };
    nums = [Number(o.min), Number(o.max)];
  } else nums = (toAsciiDigits(String(input)).match(/\d+/g) ?? []).map(Number);
  if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) return null;
  const [a, b] = nums as [number, number];
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

export type Validated = { ok: true; value: unknown } | { ok: false; error: string };

/** Normalizes an answer to its canonical form. Whatever the LLM sends, this decides what gets stored. */
export function validateAnswer(q: Pick<Question, "key" | "fieldType" | "options">, input: unknown): Validated {
  const fail = (error: string): Validated => ({ ok: false, error });
  switch (q.fieldType) {
    case "text": {
      const v = String(input ?? "").trim();
      return v && v.length <= 500 ? { ok: true, value: v } : fail("text must be 1-500 characters");
    }
    case "number": {
      const o = (q.options ?? {}) as { min?: number; max?: number; unit?: string };
      const n = o.unit === "cm" ? parseHeightCm(input) : Number(toAsciiDigits(String(input)).replace(/[^\d.]/g, ""));
      if (n == null || !Number.isFinite(n) || String(input ?? "").trim() === "") return fail("not a number");
      if ((o.min != null && n < o.min) || (o.max != null && n > o.max)) return fail(`must be between ${o.min} and ${o.max}`);
      return { ok: true, value: n };
    }
    case "select": {
      const v = matchOption((q.options ?? []) as Option[], input);
      return v ? { ok: true, value: v } : fail(`must be one of: ${((q.options ?? []) as Option[]).map((o) => o.value).join(", ")}`);
    }
    case "multiselect": {
      const list = (Array.isArray(input) ? input : [input]).map((i) => matchOption((q.options ?? []) as Option[], i));
      if (!list.length || list.some((v) => !v)) return fail(`each value must be one of: ${((q.options ?? []) as Option[]).map((o) => o.value).join(", ")}`);
      return { ok: true, value: [...new Set(list)] };
    }
    case "range": {
      const r = parseRange(input);
      return r ? { ok: true, value: r } : fail("must be a {min,max} range");
    }
    case "district": {
      const v = normalizeDistrict(String(input));
      return v ? { ok: true, value: v } : fail("unknown Bangladesh district");
    }
    case "location_list": {
      const list = (Array.isArray(input) ? input : [input]).map((i) => normalizeLocation(String(i)));
      if (!list.length || list.some((v) => !v)) return fail("must be district names, divisions (div:dhaka) or any");
      return { ok: true, value: [...new Set(list)] };
    }
    default:
      return fail(`unsupported field type ${q.fieldType}`);
  }
}

export type SaveResult =
  | { ok: true; stored: boolean; profileChanged: boolean; profileCompleted: boolean; profileComplete: boolean }
  | { ok: false; error: string };

export async function saveAnswer(args: {
  phone: string; questionKey: string; value: unknown; source: "asked" | "volunteered" | "inferred"; confidence: number; messageId?: string;
}): Promise<SaveResult> {
  const d = db();
  const [question] = await d.select().from(schema.questions)
    .where(and(eq(schema.questions.key, args.questionKey), eq(schema.questions.active, true)));
  if (!question) return { ok: false, error: `unknown question_key ${args.questionKey}` };
  const parsed = validateAnswer(question, args.value);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const [existing] = await d.select().from(schema.profileAnswers)
    .where(and(eq(schema.profileAnswers.phone, args.phone), eq(schema.profileAnswers.questionKey, args.questionKey)));
  // An inference never overwrites something the user said with more certainty.
  if (existing && args.source === "inferred" && existing.source !== "inferred" && existing.confidence >= args.confidence) {
    return { ok: true, stored: false, profileChanged: false, profileCompleted: false, profileComplete: false };
  }
  const changed = !existing || JSON.stringify(existing.value) !== JSON.stringify(parsed.value);

  await d.insert(schema.profileAnswers).values({
    phone: args.phone, questionKey: args.questionKey, value: parsed.value, source: args.source,
    confidence: args.confidence, messageId: args.messageId,
  }).onConflictDoUpdate({
    target: [schema.profileAnswers.phone, schema.profileAnswers.questionKey],
    set: {
      value: parsed.value, source: args.source, confidence: args.confidence, messageId: args.messageId,
      updatedAt: new Date(), confirmAskedAt: changed ? null : sql`${schema.profileAnswers.confirmAskedAt}`,
    },
  });

  const mirror: Partial<typeof schema.users.$inferInsert> = {};
  if (args.questionKey === "name") mirror.name = parsed.value as string;
  if (args.questionKey === "gender") mirror.gender = parsed.value as string;
  if (args.questionKey === "created_by_relation") mirror.createdByRelation = parsed.value as string;
  if (Object.keys(mirror).length) await d.update(schema.users).set(mirror).where(eq(schema.users.phone, args.phone));

  const completion = await refreshCompletion(args.phone);
  return { ok: true, stored: true, profileChanged: changed, ...completion };
}

/** Re-evaluates completion. `profileCompleted` is true only on the transition to complete. */
export async function refreshCompletion(phone: string) {
  const d = db();
  const [questions, answers, [user]] = await Promise.all([
    loadQuestions(), loadAnswers(phone), d.select().from(schema.users).where(eq(schema.users.phone, phone)),
  ]);
  const profileComplete = isProfileComplete(questions, answers);
  if (profileComplete === user?.profileComplete) return { profileComplete, profileCompleted: false };
  await d.update(schema.users)
    .set({ profileComplete, profileCompletedAt: profileComplete ? new Date() : null, updatedAt: new Date() })
    .where(eq(schema.users.phone, phone));
  return { profileComplete, profileCompleted: profileComplete };
}

export const PREFERENCE_FIELDS = ["age", "education", "job_type", "religion", "marital_status", "district", "height_cm", "income_range"];

export async function savePreference(args: { phone: string; field: string; operator: string; value: unknown; isDealbreaker: boolean }) {
  if (!PREFERENCE_FIELDS.includes(args.field)) return { ok: false as const, error: `field must be one of ${PREFERENCE_FIELDS.join(", ")}` };
  const d = db();
  const [question] = await d.select().from(schema.questions).where(eq(schema.questions.key, args.field));
  if (!question) return { ok: false as const, error: `unknown field ${args.field}` };

  const numericOp = ["gte", "lte", "between"].includes(args.operator);
  if (numericOp !== (question.fieldType === "number")) {
    return { ok: false as const, error: `operator ${args.operator} does not fit field ${args.field}` };
  }
  let value: unknown;
  if (args.operator === "between") {
    const r = parseRange(args.value);
    if (!r) return { ok: false as const, error: "between needs [min, max]" };
    value = [r.min, r.max];
  } else if (numericOp) {
    const n = Number(toAsciiDigits(String(args.value)));
    if (!Number.isFinite(n)) return { ok: false as const, error: "value must be a number" };
    value = n;
  } else {
    const list = Array.isArray(args.value) ? args.value : [args.value];
    const normalized: unknown[] = [];
    for (const item of list) {
      const parsed = validateAnswer(question, item);
      if (!parsed.ok) return { ok: false as const, error: parsed.error };
      normalized.push(parsed.value);
    }
    value = args.operator === "eq" || args.operator === "neq" ? normalized[0] : normalized;
  }
  await d.insert(schema.preferences).values({ phone: args.phone, field: args.field, operator: args.operator, value, isDealbreaker: args.isDealbreaker })
    .onConflictDoUpdate({
      target: [schema.preferences.phone, schema.preferences.field],
      set: { operator: args.operator, value, isDealbreaker: args.isDealbreaker, updatedAt: new Date() },
    });
  return { ok: true as const };
}
