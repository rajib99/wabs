import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { getEmbedder } from "@/lib/ai";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { cardFields, matchCardText, matchesSentCount, otherParty, questionsFor, stepFor, visibleMatches } from "@/lib/matches";
import { PAYABLE_STATES, paymentInfo, pendingPaymentsForUser } from "@/lib/payments";
import { toBengaliDigits } from "@/lib/text";
import { CONFIDENT, isSettled, loadAnswers, loadQuestions } from "@/lib/profile";
import { type ContactStep, pendingContactStep } from "./contact";

const { messages, preferences, photos, photoRequests } = schema;

/** The model loading (or a busy CPU) must never hold up a reply; that turn simply goes without older memories. */
const QUERY_EMBED_BUDGET_MS = 2500;

export type AgentContext = {
  profile: Record<string, { value: unknown; confidence: number }>;
  profile_complete: boolean;
  /** Set once every question is answered and the system is waiting for the contact number or the WhatsApp answer. */
  contact_step: ContactStep;
  preferences: { field: string; operator: string; value: unknown; is_dealbreaker: boolean }[];
  questions: { key: string; text: string; type: string; options: unknown; answered: boolean }[];
  to_confirm: { question_key: string; value: unknown }[];
  /** step: offered (asked whether to see details; card is null until then), viewing, waiting_for_other_side, both_interested, number_shared. */
  active_matches: { match_id: string; step: string; match_percent: string; payment_open: boolean; number_requested: boolean; card: string | null }[];
  pending_questions_for_you: { question_id: string; match_id: string; question: string }[];
  /** How many proposals this user has been sent in all; get_past_matches lists them. */
  matches_sent: number;
  pending_photo_requests: { request_id: string; from_age: string; from_district: string }[];
  pending_photo_confirmations: number;
  payments: { match_id: string; status: string; amount: number; note: string | null }[];
  payment_info: { amount: number; bkash_number: string } | null;
  similar_past_messages: string[];
};

export type HistoryItem = { role: "user" | "assistant"; content: string };

export const historyText = (m: { rawText: string | null; transcript: string | null; dedupeKey: string | null; direction: string; type: string }) => {
  // The other party's number was delivered already; it never needs to go back to the LLM.
  if (m.dedupeKey?.startsWith("release-")) return "[অন্য পক্ষের ফোন নম্বর পাঠানো হয়েছে]";
  // Outside the window only a generic alert went out; the user has not seen this message yet.
  if (m.type === "template" || m.type === "notification") return `[Only a short alert reached the user; NOT yet shown to them: ${m.rawText ?? ""}]`;
  return m.transcript ?? m.rawText ?? (m.type === "image" ? "[ছবি]" : m.type === "document" ? "[ফাইল]" : null);
};

export async function loadHistory(phone: string, excludeId: string) {
  const rows = await db().select().from(messages)
    .where(and(eq(messages.phone, phone), sql`${messages.id} <> ${excludeId}`, sql`${messages.status} <> 'skipped_window'`))
    .orderBy(desc(messages.createdAt)).limit(20);
  const ids = rows.map((r) => r.id);
  const items = rows.reverse().flatMap((m): HistoryItem[] => {
    const content = historyText(m);
    return content ? [{ role: m.direction === "inbound" ? "user" : "assistant", content }] : [];
  });
  return { items, ids };
}

/** Top older messages from pgvector. The query embedding is best-effort: memory must never block a reply. */
async function similarMessages(phone: string, text: string, excludeIds: string[]): Promise<string[]> {
  try {
    const vector = await Promise.race([
      getEmbedder().embed(text, "query"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("query embedding over time budget")), QUERY_EMBED_BUDGET_MS)),
    ]);
    const rows = await db().select({ rawText: messages.rawText, transcript: messages.transcript })
      .from(schema.messageEmbeddings)
      .innerJoin(messages, eq(messages.id, schema.messageEmbeddings.messageId))
      .where(and(eq(schema.messageEmbeddings.phone, phone), excludeIds.length ? notInArray(schema.messageEmbeddings.messageId, excludeIds) : undefined))
      .orderBy(sql`${schema.messageEmbeddings.embedding} <=> ${`[${vector.join(",")}]`}::vector`)
      .limit(5);
    return rows.flatMap((r) => r.transcript ?? r.rawText ?? []);
  } catch (err) {
    logger.warn({ err }, "semantic memory unavailable for this turn");
    return [];
  }
}

export async function buildContext(phone: string, messageId: string, text: string) {
  const d = db();
  const [{ items, ids }, answers, questions, prefs, matches, payments] = await Promise.all([
    loadHistory(phone, messageId), loadAnswers(phone), loadQuestions(),
    d.select().from(preferences).where(eq(preferences.phone, phone)),
    visibleMatches(phone), pendingPaymentsForUser(phone),
  ]);
  const [questionsForMe, sentCount] = await Promise.all([questionsFor(phone), matchesSentCount(phone)]);
  const [user] = await d.select().from(schema.users).where(eq(schema.users.phone, phone));
  const byKey = new Map(answers.map((a) => [a.questionKey, a]));

  const requests = await d.select().from(photoRequests).where(and(eq(photoRequests.owner, phone), eq(photoRequests.status, "pending")));
  const [unconfirmed] = await d.select({ n: sql<number>`count(*)::int` }).from(photos).where(and(eq(photos.phone, phone), isNull(photos.ownerConfirmedAt)));

  const activeMatches = await Promise.all(matches.map(async (m) => {
    const step = stepFor(m, phone);
    return {
      match_id: m.id,
      step,
      match_percent: toBengaliDigits(Math.round(m.score)),
      // Open to this person until they have a payment that is pending or verified.
      payment_open: PAYABLE_STATES.includes(m.state) && !payments.some((p) => p.matchId === m.id && p.status !== "rejected"),
      number_requested: m.numberRequestedBy.includes(phone),
      // No details before they say they want to see them.
      card: step === "offered" ? null : await matchCardText(otherParty(m, phone), m.score),
    };
  }));

  const context: AgentContext = {
    profile: Object.fromEntries(answers.map((a) => [a.questionKey, { value: a.value, confidence: a.confidence }])),
    profile_complete: !!user?.profileComplete,
    contact_step: pendingContactStep(user),
    preferences: prefs.map((p) => ({ field: p.field, operator: p.operator, value: p.value, is_dealbreaker: p.isDealbreaker })),
    questions: questions.map((q) => ({ key: q.key, text: q.bengaliText, type: q.fieldType, options: q.options, answered: isSettled(byKey.get(q.key)) })),
    to_confirm: answers.filter((a) => a.confidence < CONFIDENT && !a.confirmAskedAt).map((a) => ({ question_key: a.questionKey, value: a.value })),
    active_matches: activeMatches,
    pending_questions_for_you: questionsForMe.map((q) => ({ question_id: q.id, match_id: q.matchId, question: q.question })),
    matches_sent: sentCount,
    pending_photo_requests: await Promise.all(requests.map(async (r) => {
      const f = await cardFields(r.requester);
      return { request_id: r.id, from_age: f.age, from_district: f.district };
    })),
    pending_photo_confirmations: unconfirmed?.n ?? 0,
    payments: payments.map((p) => ({ match_id: p.matchId, status: p.status, amount: p.amount, note: p.note })),
    payment_info: activeMatches.some((m) => m.payment_open) ? await paymentInfo() : null,
    similar_past_messages: await similarMessages(phone, text, ids),
  };
  return { context, history: items };
}

export async function markConfirmationsAsked(phone: string, keys: string[]) {
  if (!keys.length) return;
  await db().update(schema.profileAnswers).set({ confirmAskedAt: new Date() })
    .where(and(eq(schema.profileAnswers.phone, phone), inArray(schema.profileAnswers.questionKey, keys)));
}
