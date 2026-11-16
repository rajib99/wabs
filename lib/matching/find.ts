import { and, eq, inArray, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { OPEN_FOR_A, OPEN_FOR_B } from "@/lib/matches";
import { db, schema } from "@/lib/db";
import { answersToValues, loadAnswers } from "@/lib/profile";
import { getSetting } from "@/lib/settings";
import { type Answers, type FieldRule, meetsThreshold, scorePair } from "./score";

const { users, profileAnswers } = schema;

type MinAges = { male: number; female: number };

/** Legal marriage age is a hard filter regardless of score. Missing age never passes. */
export function meetsMinimumAge(gender: string | null, answers: Answers, min: MinAges): boolean {
  const age = Number(answers.age);
  const required = gender === "male" ? min.male : min.female;
  return Number.isFinite(age) && age >= required;
}

/** Step 1: every hard filter, evaluated in SQL: opposite gender, same religion, and dealbreakers of BOTH users. */
export async function hardFilteredCandidates(phone: string, gender: string, limit = 500): Promise<{ phone: string; gender: string }[]> {
  const opposite = gender === "male" ? "female" : "male";
  const res = await db().execute(sql`
    SELECT c.phone, c.gender FROM users c
    WHERE c.phone <> ${phone}
      AND c.gender = ${opposite}
      AND c.status = 'active' AND c.profile_complete AND NOT c.blocked
      AND c.contact_phone IS NOT NULL AND c.contact_phone_verified
      AND NOT c.matching_paused
      -- Same religion only, always: nobody is asked for a religion preference. A missing religion never passes.
      AND EXISTS (
        SELECT 1 FROM profile_answers mine
        JOIN profile_answers theirs ON theirs.phone = c.phone AND theirs.question_key = 'religion'
        WHERE mine.phone = ${phone} AND mine.question_key = 'religion' AND mine.value = theirs.value
      )
      AND NOT EXISTS (
        SELECT 1 FROM matches m
        WHERE (m.user_a = ${phone} AND m.user_b = c.phone) OR (m.user_a = c.phone AND m.user_b = ${phone})
      )
      AND NOT EXISTS (
        SELECT 1 FROM preferences p
        LEFT JOIN profile_answers a ON a.phone = c.phone AND a.question_key = p.field
        WHERE p.phone = ${phone} AND p.is_dealbreaker AND NOT pref_satisfied(p.operator, p.value, a.value)
      )
      AND NOT EXISTS (
        SELECT 1 FROM preferences p
        LEFT JOIN profile_answers a ON a.phone = ${phone} AND a.question_key = p.field
        WHERE p.phone = c.phone AND p.is_dealbreaker AND NOT pref_satisfied(p.operator, p.value, a.value)
      )
    ORDER BY c.profile_completed_at DESC NULLS LAST
    LIMIT ${limit}
  `);
  return res.rows as { phone: string; gender: string }[];
}

/** New proposals counted against a user today, in Bangladesh time. */
async function introductionsToday(phone: string): Promise<number> {
  const res = await db().execute(sql`
    SELECT count(*)::int AS n FROM matches
    WHERE (user_a = ${phone} OR user_b = ${phone})
      AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka')
  `);
  return (res.rows[0] as { n: number }).n;
}

/** Proposals in progress for this person: as a, from the start; as b, once they have been asked. */
export async function openMatchCount(phone: string): Promise<number> {
  const res = await db().execute(sql`
    SELECT count(*)::int AS n FROM matches
    WHERE (user_a = ${phone} AND state IN (${sql.join(OPEN_FOR_A.map((st) => sql`${st}`), sql`, `)}))
       OR (user_b = ${phone} AND state IN (${sql.join(OPEN_FOR_B.map((st) => sql`${st}`), sql`, `)}))
  `);
  return (res.rows[0] as { n: number }).n;
}

export type NewMatch = { id: string; score: number };

/** Creates proposed matches for one user. Returns the rows created so the caller can emit events. */
export async function findMatches(phone: string): Promise<NewMatch[]> {
  const d = db();
  const [me] = await d.select().from(users).where(eq(users.phone, phone));
  if (!me || me.blocked || me.status !== "active" || !me.profileComplete || !me.gender) return [];
  if (!me.contactPhone || !me.contactPhoneVerified) return []; // starts once an admin has checked a typed number
  if (me.matchingPaused) return []; // talking to someone; resumes when they ask for more proposals

  const [rules, threshold, dailyLimit, minAges, maxOpen] = await Promise.all([
    getSetting<FieldRule[]>("match_weights"),
    getSetting<number>("match_threshold"),
    getSetting<number>("daily_intro_limit"),
    getSetting<MinAges>("min_match_age"),
    getSetting<number>("max_open_matches"),
  ]);

  const myAnswers = answersToValues(await loadAnswers(phone));
  if (!meetsMinimumAge(me.gender, myAnswers, minAges)) return [];

  // One proposal at a time by default: the next is sent when one closes or they ask for more.
  let myRemaining = Math.min(dailyLimit - (await introductionsToday(phone)), maxOpen - (await openMatchCount(phone)));
  if (myRemaining <= 0) return [];

  const candidates = await hardFilteredCandidates(phone, me.gender);
  if (!candidates.length) return [];

  const rows = await d.select({ phone: profileAnswers.phone, questionKey: profileAnswers.questionKey, value: profileAnswers.value })
    .from(profileAnswers).where(inArray(profileAnswers.phone, candidates.map((c) => c.phone)));
  const answersByPhone = new Map<string, Answers>();
  for (const r of rows) {
    const a = answersByPhone.get(r.phone) ?? {};
    a[r.questionKey] = r.value;
    answersByPhone.set(r.phone, a);
  }

  const ranked = candidates
    .map((c) => {
      const answers = answersByPhone.get(c.phone) ?? {};
      return { ...c, answers, ...scorePair(rules, myAnswers, answers) };
    })
    .filter((c) => meetsMinimumAge(c.gender, c.answers, minAges) && meetsThreshold(c.score, threshold))
    .sort((x, y) => y.score - x.score);

  const created: NewMatch[] = [];
  for (const c of ranked) {
    if (myRemaining <= 0) break;
    if ((await introductionsToday(c.phone)) >= dailyLimit) continue;
    if ((await openMatchCount(c.phone)) >= maxOpen) continue;
    const [row] = await d.insert(schema.matches).values({
      userA: phone, userB: c.phone, score: c.score, breakdown: c.breakdown, state: "proposed",
      stateTimestamps: { proposed: new Date().toISOString() },
    }).onConflictDoNothing().returning({ id: schema.matches.id });
    if (!row) continue; // the pair was created concurrently from the other side
    created.push({ id: row.id, score: c.score });
    myRemaining--;
    await audit("system", "match.proposed", "match", row.id, { score: c.score });
  }
  return created;
}

export async function activeUserPhones(): Promise<string[]> {
  const rows = await db().select({ phone: users.phone }).from(users)
    .where(and(eq(users.status, "active"), eq(users.profileComplete, true), eq(users.blocked, false), eq(users.contactPhoneVerified, true)));
  return rows.map((r) => r.phone);
}
