import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { inngest } from "@/inngest/client";
import { audit } from "@/lib/audit";
import { sendToUser } from "@/lib/conversation/outbound";
import { db, schema } from "@/lib/db";
import { districtLabel } from "@/lib/matching/districts";
import { answersToValues, loadAnswers, loadQuestions, type Question } from "@/lib/profile";
import { msg } from "@/lib/settings";
import { redactContactInfo, toBengaliDigits } from "@/lib/text";

export type Match = typeof schema.matches.$inferSelect;

export const MATCH_STATES = [
  "proposed", "shown_to_a", "a_interested", "shown_to_b", "b_interested", "both_interested", "payment_pending", "contact_released", "declined", "expired",
] as const;
export type MatchState = (typeof MATCH_STATES)[number];

/** The state machine. Anything not listed here cannot happen. */
export const TRANSITIONS: Record<MatchState, MatchState[]> = {
  proposed: ["shown_to_a", "declined", "expired"],
  shown_to_a: ["a_interested", "declined", "expired"],
  a_interested: ["shown_to_b", "declined", "expired"],
  shown_to_b: ["b_interested", "declined", "expired"],
  b_interested: ["both_interested", "declined", "expired"],
  both_interested: ["payment_pending", "declined", "expired"],
  payment_pending: ["contact_released", "declined", "expired"],
  contact_released: [],
  declined: [],
  expired: [],
};

export const isClosed = (state: string) => state === "declined" || state === "expired" || state === "contact_released";

/** b must not learn a match exists until it is shown to them. */
const B_VISIBLE = new Set<string>(["shown_to_b", "b_interested", "both_interested", "payment_pending", "contact_released", "declined", "expired"]);

export function isVisibleTo(match: Pick<Match, "userA" | "userB" | "state" | "stateTimestamps">, phone: string): boolean {
  if (match.userA === phone) return match.state !== "proposed";
  if (match.userB === phone) return B_VISIBLE.has(match.state) && "shown_to_b" in match.stateTimestamps;
  return false;
}

export const otherParty = (m: Pick<Match, "userA" | "userB">, phone: string) => (m.userA === phone ? m.userB : m.userA);

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
  return msg("match_card", { ...(await cardFields(viewedPhone)), match_percent: toBengaliDigits(Math.round(score)) });
}

/** Sends the profile card of the counterparty to `viewer`, using a template outside the 24-hour window. */
export async function showCard(match: Match, viewer: string) {
  const text = await matchCardText(otherParty(match, viewer), match.score);
  await sendToUser(viewer, text, {
    dedupeKey: `card-${match.id}-${viewer}`, template: "match_intro", templateParams: [toBengaliDigits(Math.round(match.score))],
  });
}

/** Closes a match. Declined and expired read identically so nobody can tell who declined. */
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
    .where(and(eq(schema.payments.matchId, matchId), eq(schema.payments.status, "verified")));
  for (const p of paid) {
    await db().insert(schema.escalations).values({
      phone: p.payerPhone, kind: "refund", matchId, reason: `Verified payment ${p.trxId} on a match closed as ${to} (${reason}). Decide refund.`,
    });
  }
  return true;
}

export type RespondResult = { ok: true; state: string; note: string } | { ok: false; error: string };

export async function respondToMatch(phone: string, matchId: string, action: "interested" | "decline", actor = "agent"): Promise<RespondResult> {
  const match = await getMatch(matchId);
  if (!match || !isVisibleTo(match, phone)) return { ok: false, error: "match not found" };
  if (isClosed(match.state)) return { ok: false, error: "match is already closed" };

  if (action === "decline") {
    await closeMatch(matchId, "declined", actor, "party_declined", phone);
    return { ok: true, state: "declined", note: "Closed. Thank the user politely." };
  }
  const isA = match.userA === phone;
  if (isA && match.state === "shown_to_a") {
    await transition(matchId, "a_interested", actor);
    return { ok: true, state: "a_interested", note: "Recorded. Tell the user we will ask the other party and let them know." };
  }
  if (!isA && match.state === "shown_to_b") {
    await transition(matchId, "b_interested", actor);
    return { ok: true, state: "b_interested", note: "Recorded. Both sides are interested; payment details follow from the system." };
  }
  return { ok: true, state: match.state, note: "No change needed: the user's interest is already recorded." };
}

/** Advances a match after a state change. Called from the match-advance Inngest function. */
export async function advanceMatch(matchId: string, state: string) {
  const match = await getMatch(matchId);
  if (!match) return;
  // A retry can find its own transition already done: carry on so the card still goes out (sends are deduped).
  const resumed = (state === "proposed" && match.state === "shown_to_a") || (state === "a_interested" && match.state === "shown_to_b");
  if (match.state !== state && !resumed) return; // a later change superseded this event
  if (state === "proposed") {
    await transition(matchId, "shown_to_a", "system");
    await showCard(match, match.userA);
  } else if (state === "a_interested") {
    await transition(matchId, "shown_to_b", "system");
    await showCard(match, match.userB);
  } else if (state === "b_interested") {
    await transition(matchId, "both_interested", "system");
  } else if (state === "both_interested") {
    await inngest.send({ id: `both-${matchId}`, name: "match/both_interested", data: { matchId } });
  }
}

/** Reads the matches the agent may discuss with this user. */
export async function visibleMatches(phone: string): Promise<Match[]> {
  const rows = await db().select().from(schema.matches)
    .where(or(eq(schema.matches.userA, phone), eq(schema.matches.userB, phone)))
    .orderBy(desc(schema.matches.createdAt)).limit(20);
  // After a one-sided release the other party can still pay to receive the number, so it stays in view.
  return rows.filter((m) => isVisibleTo(m, phone) && (!isClosed(m.state) || m.closeReason === "one_sided_timeout"));
}
