import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { inngest } from "@/inngest/client";
import { audit } from "@/lib/audit";
import { sendToUser } from "@/lib/conversation/outbound";
import { db, schema } from "@/lib/db";
import { districtLabel } from "@/lib/matching/districts";
import { answersToValues, loadAnswers, loadQuestions, type Question } from "@/lib/profile";
import { sendNumberPaymentInstructions } from "@/lib/payments";
import { msg } from "@/lib/settings";
import { redactContactInfo, toBengaliDigits } from "@/lib/text";

export type Match = typeof schema.matches.$inferSelect;

export const MATCH_STATES = [
  "proposed", "offered_to_a", "shown_to_a", "a_interested", "offered_to_b", "shown_to_b", "both_interested", "contact_released", "declined", "expired",
] as const;
export type MatchState = (typeof MATCH_STATES)[number];

/**
 * The state machine. Anything not listed here cannot happen.
 * a is asked whether to see the details (offered), sees them (shown), and likes it, asks a question or asks for the
 * number (a_interested). Only then is b asked the same way. Once b is interested, either side may pay for the
 * other's number; each payment releases one direction (contact_released stays open for the other side).
 */
export const TRANSITIONS: Record<MatchState, MatchState[]> = {
  proposed: ["offered_to_a", "declined", "expired"],
  offered_to_a: ["shown_to_a", "declined", "expired"],
  shown_to_a: ["a_interested", "declined", "expired"],
  a_interested: ["offered_to_b", "declined", "expired"],
  offered_to_b: ["shown_to_b", "declined", "expired"],
  shown_to_b: ["both_interested", "declined", "expired"],
  both_interested: ["contact_released", "declined", "expired"],
  contact_released: [],
  declined: [],
  expired: [],
};

export const isClosed = (state: string) => state === "declined" || state === "expired";

/** Still in progress for matching purposes: a person has at most max_open_matches of these at once. */
export const OPEN_FOR_A = ["proposed", "offered_to_a", "shown_to_a", "a_interested", "offered_to_b", "shown_to_b", "both_interested"] as const;
export const OPEN_FOR_B = ["offered_to_b", "shown_to_b", "both_interested"] as const;

/** b must not learn a match exists until it is offered to them. */
const B_VISIBLE = new Set<string>(["offered_to_b", "shown_to_b", "both_interested", "contact_released", "declined", "expired"]);

export function isVisibleTo(match: Pick<Match, "userA" | "userB" | "state" | "stateTimestamps">, phone: string): boolean {
  if (match.userA === phone) return match.state !== "proposed";
  if (match.userB === phone) return B_VISIBLE.has(match.state) && ("offered_to_b" in match.stateTimestamps || "shown_to_b" in match.stateTimestamps);
  return false;
}

export const otherParty = (m: Pick<Match, "userA" | "userB">, phone: string) => (m.userA === phone ? m.userB : m.userA);

/** Where the match stands for one person, in the words the agent works with. */
export type MatchStep = "offered" | "viewing" | "waiting_for_other_side" | "both_interested" | "number_shared" | "closed";
export function stepFor(match: Pick<Match, "userA" | "state">, phone: string): MatchStep {
  const isA = match.userA === phone;
  switch (match.state) {
    case "proposed": case "offered_to_a": return isA ? "offered" : "closed";
    case "shown_to_a": return isA ? "viewing" : "closed";
    case "a_interested": return isA ? "waiting_for_other_side" : "closed";
    case "offered_to_b": return isA ? "waiting_for_other_side" : "offered";
    case "shown_to_b": return isA ? "waiting_for_other_side" : "viewing";
    case "both_interested": return "both_interested";
    case "contact_released": return "number_shared";
    default: return "closed";
  }
}

/**
 * Atomic compare-and-set on state. A retried step that finds the target state already reached
 * re-sends the event, which Inngest dedupes by id, so a crash between the two cannot lose it.
 */
export async function transition(matchId: string, to: MatchState, actor: string, opts: { closeReason?: string; onlyFrom?: MatchState } = {}): Promise<boolean> {
  const { onlyFrom, ...extra } = opts;
  const allowedFrom = onlyFrom ? [onlyFrom] : MATCH_STATES.filter((s) => TRANSITIONS[s].includes(to));
  const now = new Date();
  const updated = await db().update(schema.matches).set({
    state: to,
    stateTimestamps: sql`${schema.matches.stateTimestamps} || ${JSON.stringify({ [to]: now.toISOString() })}::jsonb`,
    updatedAt: now,
    ...extra,
  }).where(and(eq(schema.matches.id, matchId), inArray(schema.matches.state, allowedFrom))).returning({ id: schema.matches.id });

  if (updated.length) await audit(actor, "match.transition", "match", matchId, { to, ...extra });
  else {
    const [current] = await db().select({ state: schema.matches.state }).from(schema.matches).where(eq(schema.matches.id, matchId));
    if (current?.state !== to) return false;
  }
  await inngest.send({ id: `match-${matchId}-${to}`, name: "match/state.changed", data: { matchId, state: to } });
  return true;
}

export async function getMatch(id: string): Promise<Match | undefined> {
  const [m] = await db().select().from(schema.matches).where(eq(schema.matches.id, id));
  return m;
}

const label = (q: Question | undefined, value: unknown): string => {
  if (value == null) return "জানানো হয়নি";
  const options = Array.isArray(q?.options) ? (q.options as { value: string; label: string }[]) : [];
  return options.find((o) => o.value === value)?.label ?? String(value);
};

/** Card fields only. No name, phone or photo; user-typed text is scrubbed of contact details. */
export async function cardFields(phone: string) {
  const [questions, rows] = await Promise.all([loadQuestions(), loadAnswers(phone)]);
  const a = answersToValues(rows);
  const q = new Map(questions.map((x) => [x.key, x]));
  const free = (v: unknown) => (v == null ? "জানানো হয়নি" : redactContactInfo(String(v)).slice(0, 160));
  return {
    age: a.age == null ? "জানানো হয়নি" : toBengaliDigits(String(a.age)),
    education: label(q.get("education"), a.education),
    profession: free(a.profession),
    job_type: label(q.get("job_type"), a.job_type),
    district: a.district == null ? "জানানো হয়নি" : districtLabel(String(a.district)),
    family: free(a.family_details),
  };
}

export async function matchCardText(viewedPhone: string, score: number): Promise<string> {
  return msg("match_details", { ...(await cardFields(viewedPhone)), match_percent: toBengaliDigits(Math.round(score)) });
}

/**
 * Asks `viewer` whether they want to see the details of a match. Outside the 24-hour window the match_intro
 * template goes instead: a generic alert with no placeholders. The question is asked again once they reply.
 */
async function offerMatch(match: Match, viewer: string) {
  const key = viewer === match.userA ? "match_offer" : "match_offer_b";
  const text = await msg(key, { match_percent: toBengaliDigits(Math.round(match.score)) });
  await sendToUser(viewer, text, { dedupeKey: `offer-${match.id}-${viewer}`, template: "match_intro" });
}

/** Sends the counterparty's details (never a name, number or photo) after the viewer said they want to see them. */
export async function showCard(match: Match, viewer: string) {
  const text = await matchCardText(otherParty(match, viewer), match.score);
  await sendToUser(viewer, text, { dedupeKey: `card-${match.id}-${viewer}`, template: "match_update" });
}

/** Asks the matching engine for someone's next proposal. Inngest debounces per person. */
async function findNextMatch(phone: string) {
  await inngest.send({ name: "matching/run", data: { phone } });
}

/** Closes a match. Declined and expired read identically so nobody can tell who declined. Both sides then get their next proposal. */
export async function closeMatch(matchId: string, to: "declined" | "expired", actor: string, reason: string, skipNotify?: string, onlyFrom?: MatchState) {
  const match = await getMatch(matchId);
  if (!match) return false;
  if (!(await transition(matchId, to, actor, { closeReason: reason, onlyFrom }))) return false;
  const closed = (await getMatch(matchId))!;
  const text = await msg("match_closed");
  for (const phone of [match.userA, match.userB]) {
    if (phone === skipNotify || !isVisibleTo(closed, phone)) continue;
    await sendToUser(phone, text, { dedupeKey: `closed-${matchId}-${phone}`, template: "match_update", deferOnFailure: true });
  }
  // Someone who already paid is owed a decision by a human.
  const paid = await db().select().from(schema.payments)
    .where(and(eq(schema.payments.matchId, matchId), inArray(schema.payments.status, ["pending", "verified"])));
  for (const p of paid) {
    await db().insert(schema.escalations).values({
      phone: p.payerPhone, kind: "refund", matchId, reason: `Payment ${p.trxId ?? "(no TrxID)"} (${p.status}) on a match closed as ${to} (${reason}). Decide refund.`,
    });
  }
  if (reason !== "reported") for (const phone of [match.userA, match.userB]) await findNextMatch(phone);
  return true;
}

export type RespondResult = { ok: true; state: string; note: string } | { ok: false; error: string };

export async function respondToMatch(phone: string, matchId: string, action: "see_details" | "interested" | "decline", actor = "agent"): Promise<RespondResult> {
  const match = await getMatch(matchId);
  if (!match || !isVisibleTo(match, phone)) return { ok: false, error: "match not found" };
  if (isClosed(match.state)) return { ok: false, error: "match is already closed" };
  const step = stepFor(match, phone);
  const isA = match.userA === phone;

  if (action === "decline") {
    if (step === "number_shared") return { ok: false, error: "the number was already shared; use report_match for a complaint" };
    await closeMatch(matchId, "declined", actor, "party_declined", phone);
    return { ok: true, state: "declined", note: "Closed. Thank the user politely; the system will look for another proposal." };
  }
  if (action === "see_details") {
    if (step !== "offered") return { ok: true, state: match.state, note: "The details were already shown; see card in active_matches." };
    await transition(matchId, isA ? "shown_to_a" : "shown_to_b", actor);
    await showCard(match, phone);
    if (!isA) await deliverPendingQuestions(match, phone);
    return { ok: true, state: isA ? "shown_to_a" : "shown_to_b", note: "The system has just sent the details. Do not repeat them; reply in one short line." };
  }
  // interested
  if (step === "offered") return { ok: false, error: "they have not seen the details yet: call see_details first" };
  if (isA && match.state === "shown_to_a") {
    await transition(matchId, "a_interested", actor);
    return { ok: true, state: "a_interested", note: "Recorded. Tell the user we will ask the other side and let them know." };
  }
  if (!isA && match.state === "shown_to_b") {
    await transition(matchId, "both_interested", actor);
    return { ok: true, state: "both_interested", note: "Both sides are interested. Tell the user they can ask for the other side's number." };
  }
  return { ok: true, state: match.state, note: "No change needed: the user's interest is already recorded." };
}

/** Advances a match after a state change. Called from the match-advance Inngest function. */
export async function advanceMatch(matchId: string, state: string) {
  const match = await getMatch(matchId);
  if (!match) return;
  // A retry can find its own transition already done: carry on so the offer still goes out (sends are deduped).
  const resumed = (state === "proposed" && match.state === "offered_to_a") || (state === "a_interested" && match.state === "offered_to_b");
  if (match.state !== state && !resumed) return; // a later change superseded this event
  if (state === "proposed") {
    await transition(matchId, "offered_to_a", "system");
    await offerMatch(match, match.userA);
  } else if (state === "a_interested") {
    await transition(matchId, "offered_to_b", "system");
    await offerMatch(match, match.userB);
  } else if (state === "both_interested") {
    await sendToUser(match.userA, await msg("match_accepted"), { dedupeKey: `accepted-${matchId}`, template: "match_update", deferOnFailure: true });
    // Whoever already asked for the number gets the payment details now.
    for (const phone of match.numberRequestedBy) await sendNumberPaymentInstructions(matchId, phone);
  }
}

/** Reads the matches the agent may discuss with this user: everything in progress, and numbers already shared. */
export async function visibleMatches(phone: string): Promise<Match[]> {
  const rows = await db().select().from(schema.matches)
    .where(or(eq(schema.matches.userA, phone), eq(schema.matches.userB, phone)))
    .orderBy(desc(schema.matches.createdAt)).limit(20);
  return rows.filter((m) => isVisibleTo(m, phone) && !isClosed(m.state));
}

/**
 * The person wants the other side's number. Payment opens only once both sides are interested, so the other side
 * always agrees before anyone pays. Asking for the number is itself interest.
 */
export async function requestNumber(phone: string, matchId: string): Promise<RespondResult> {
  const match = await getMatch(matchId);
  if (!match || !isVisibleTo(match, phone)) return { ok: false, error: "match not found" };
  if (isClosed(match.state)) return { ok: false, error: "match is already closed" };
  const step = stepFor(match, phone);
  if (step === "offered") return { ok: false, error: "they have not seen the details yet: ask whether they want to see them first" };

  await db().update(schema.matches)
    .set({ numberRequestedBy: sql`array_append(${schema.matches.numberRequestedBy}, ${phone})` })
    .where(and(eq(schema.matches.id, matchId), sql`NOT (${phone} = ANY(${schema.matches.numberRequestedBy}))`));
  await audit(phone === match.userA ? "user_a" : "user_b", "match.number_requested", "match", matchId);

  if (step === "both_interested" || step === "number_shared") {
    const sent = await sendNumberPaymentInstructions(matchId, phone);
    return { ok: true, state: match.state, note: sent };
  }
  if (step === "viewing" && match.userA === phone) {
    await transition(matchId, "a_interested", "agent");
    return { ok: true, state: "a_interested", note: "Recorded. Tell the user we will first ask the other side; if they agree, the payment details for the number follow." };
  }
  if (step === "viewing") {
    await transition(matchId, "both_interested", "agent"); // b asking for a's number: a is already interested
    return { ok: true, state: "both_interested", note: "Both sides are interested. The system is sending the payment details for the number now; do not repeat them." };
  }
  return { ok: true, state: match.state, note: "Waiting for the other side to agree. Tell the user the payment details for the number follow once they agree." };
}

/** Delivers questions that waited until `to` could see the match. */
export async function deliverPendingQuestions(match: Match, to: string) {
  const asker = otherParty(match, to);
  const pending = await db().select().from(schema.matchQuestions)
    .where(and(eq(schema.matchQuestions.matchId, match.id), eq(schema.matchQuestions.asker, asker), eq(schema.matchQuestions.status, "pending")));
  for (const q of pending) {
    // Marked first: a fast reply must find the question waiting. A failed send stays queued and is retried.
    await db().update(schema.matchQuestions).set({ status: "delivered", deliveredAt: new Date() }).where(eq(schema.matchQuestions.id, q.id));
    await sendToUser(to, await msg("match_question_to_owner", { question: q.question }), { dedupeKey: `question-${q.id}`, template: "match_update", deferOnFailure: true });
  }
}

/** Can `phone` already see the details of this match (and so be asked a question about it)? */
const hasSeenDetails = (match: Match, phone: string) => isVisibleTo(match, phone) && !["offered", "closed"].includes(stepFor(match, phone));

/** A question for the other side, passed on by BS. Contact details are stripped: numbers only move through payment. */
export async function askOtherParty(phone: string, matchId: string, question: string): Promise<RespondResult> {
  const match = await getMatch(matchId);
  if (!match || !isVisibleTo(match, phone)) return { ok: false, error: "match not found" };
  if (isClosed(match.state)) return { ok: false, error: "match is already closed" };
  if (stepFor(match, phone) === "offered") return { ok: false, error: "they have not seen the details yet" };
  const clean = redactContactInfo(question.trim()).slice(0, 300);
  if (!clean) return { ok: false, error: "empty question" };

  await db().insert(schema.matchQuestions).values({ matchId, asker: phone, question: clean });
  await audit(phone === match.userA ? "user_a" : "user_b", "match.question_asked", "match", matchId);
  const other = otherParty(match, phone);
  if (hasSeenDetails(match, other)) {
    await deliverPendingQuestions(match, other);
    return { ok: true, state: match.state, note: "Sent to the other side. Tell the user we will pass on the answer when it comes." };
  }
  // a's question can only reach b once b is asked about the match: a question is interest.
  const moved = match.state === "shown_to_a" && (await transition(matchId, "a_interested", "agent"));
  return { ok: true, state: moved ? "a_interested" : match.state, note: "Saved. The other side will first be asked whether they want to see the user's details; the question goes with it and we will pass on the answer." };
}

export async function answerQuestion(phone: string, questionId: string, answer: string): Promise<RespondResult> {
  const [q] = await db().select().from(schema.matchQuestions).where(eq(schema.matchQuestions.id, questionId));
  if (!q) return { ok: false, error: "question not found" };
  const match = await getMatch(q.matchId);
  if (!match || q.asker === phone || otherParty(match, q.asker) !== phone || !isVisibleTo(match, phone)) return { ok: false, error: "question not found" };
  if (q.status === "answered") return { ok: true, state: match.state, note: "Already answered and passed on." };
  const clean = redactContactInfo(answer.trim()).slice(0, 500);
  if (!clean) return { ok: false, error: "empty answer" };
  await db().update(schema.matchQuestions).set({ status: "answered", answer: clean, answeredAt: new Date() }).where(eq(schema.matchQuestions.id, q.id));
  await sendToUser(q.asker, await msg("match_answer_to_asker", { question: q.question, answer: clean }), {
    dedupeKey: `answer-${q.id}`, template: "match_update", deferOnFailure: true,
  });
  return { ok: true, state: match.state, note: "Passed on to the other side. Thank the user in one short line." };
}

/** Questions the other side asked this person that are waiting for an answer. */
export async function questionsFor(phone: string) {
  const matches = await visibleMatches(phone);
  if (!matches.length) return [];
  const rows = await db().select().from(schema.matchQuestions)
    .where(and(inArray(schema.matchQuestions.matchId, matches.map((m) => m.id)), eq(schema.matchQuestions.status, "delivered")));
  return rows.filter((r) => r.asker !== phone);
}

const STATUS_LABEL: Record<MatchStep, string> = {
  offered: "not opened yet", viewing: "details seen", waiting_for_other_side: "waiting for the other side",
  both_interested: "both interested", number_shared: "number shared", closed: "closed",
};

/** Every proposal this person was sent, numbered from the first, so they can look at an earlier one again. */
export async function pastMatches(phone: string) {
  const rows = await db().select().from(schema.matches)
    .where(or(eq(schema.matches.userA, phone), eq(schema.matches.userB, phone)))
    .orderBy(asc(schema.matches.createdAt));
  const seen = rows.filter((m) => isVisibleTo(m, phone));
  const list = await Promise.all(seen.map(async (m, i) => {
    // Details only for proposals they chose to open; one never opened may still be open to them.
    const opened = `shown_to_${m.userA === phone ? "a" : "b"}` in m.stateTimestamps;
    return {
      number: i + 1,
      match_id: m.id,
      sent_on: m.createdAt.toISOString().slice(0, 10),
      status: isClosed(m.state) ? "closed" : STATUS_LABEL[stepFor(m, phone)],
      card: opened ? await matchCardText(otherParty(m, phone), m.score) : null,
    };
  }));
  return { total_sent: list.length, matches: list };
}

/** Proposals sent to this person so far (the ones they could see). */
export async function matchesSentCount(phone: string): Promise<number> {
  return (await pastMatches(phone)).total_sent;
}

/** The person is ready for more proposals, for example after the call follow-up. */
export async function requestMoreMatches(phone: string) {
  await db().update(schema.users).set({ matchingPaused: false, updatedAt: new Date() }).where(eq(schema.users.phone, phone));
  await findNextMatch(phone);
  return { ok: true as const, note: "Matching resumed. Tell the user we will send a suitable proposal when we find one; promise nothing about when." };
}
