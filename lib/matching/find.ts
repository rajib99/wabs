import { and, eq, inArray, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
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

/** Step 1: every hard filter, evaluated in SQL. Dealbreakers of BOTH users must hold. */
export async function hardFilteredCandidates(phone: string, gender: string, limit = 500): Promise<{ phone: string; gender: string }[]> {
  const opposite = gender === "male" ? "female" : "male";
  const res = await db().execute(sql`
    SELECT c.phone, c.gender FROM users c
    WHERE c.phone <> ${phone}
      AND c.gender = ${opposite}
      AND c.status = 'active' AND c.profile_complete AND NOT c.blocked
      AND c.contact_phone IS NOT NULL AND c.contact_phone_verified
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

export type NewMatch = { id: string; score: number };

/** Creates proposed matches for one user. Returns the rows created so the caller can emit events. */
export async function findMatches(phone: string): Promise<NewMatch[]> {
  const d = db();
  const [me] = await d.select().from(users).where(eq(users.phone, phone));
  if (!me || me.blocked || me.status !== "active" || !me.profileComplete || !me.gender) return [];
  if (!me.contactPhone || !me.contactPhoneVerified) return []; // starts once an admin has checked a typed number

  const [rules, threshold, dailyLimit, minAges] = await Promise.all([
    getSetting<FieldRule[]>("match_weights"),
    getSetting<number>("match_threshold"),
    getSetting<number>("daily_intro_limit"),
    getSetting<MinAges>("min_match_age"),
  ]);

  const myAnswers = answersToValues(await loadAnswers(phone));
  if (!meetsMinimumAge(me.gender, myAnswers, minAges)) return [];

  let myRemaining = dailyLimit - (await introductionsToday(phone));
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
