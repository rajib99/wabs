import { sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { QUESTION_SEED } from "@/lib/questions-seed";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";

export const sentEvents = () => (globalThis as unknown as { __sentEvents: { name: string; id?: string; data: Record<string, unknown> }[] }).__sentEvents;

export async function resetDb() {
  await db().execute(sql`TRUNCATE users, messages, message_embeddings, questions, profile_answers, preferences, photos, matches, photo_requests, payments, settings, admin_users, audit_log, escalations CASCADE`);
  await db().insert(schema.questions).values(QUESTION_SEED);
  await db().insert(schema.settings).values(Object.entries({ ...DEFAULT_SETTINGS, bkash_number: "01700000000" }).map(([key, value]) => ({ key, value })));
}

const BASE: Record<string, unknown> = {
  name: "টেস্ট", created_by_relation: "self", religion: "muslim", marital_status: "never_married", district: "dhaka", current_location: "ঢাকা",
  education: "bachelor", profession: "প্রকৌশলী", job_type: "private", family_details: "ছোট পরিবার",
  preferred_age_range: { min: 18, max: 45 }, preferred_education: ["any"], preferred_job_type: ["any"], preferred_location: ["any"],
};

/** Creates an active user with a complete profile. */
export async function makeUser(phone: string, gender: "male" | "female", overrides: Record<string, unknown> = {}, userFields: Partial<typeof schema.users.$inferInsert> = {}) {
  const answers: Record<string, unknown> = { ...BASE, age: gender === "male" ? 28 : 24, gender, ...overrides };
  await db().insert(schema.users).values({
    phone, gender, status: "active", profileComplete: true, consentAt: new Date(), lastInboundAt: new Date(), profileCompletedAt: new Date(),
    contactPhone: phone.startsWith("+") ? phone : null, contactPhoneVerified: phone.startsWith("+"), contactPhoneSource: "channel", ...userFields,
  });
  await db().insert(schema.profileAnswers).values(Object.entries(answers).map(([questionKey, value]) => ({ phone, questionKey, value, source: "asked", confidence: 0.95 })));
}

export async function makeMatch(a: string, b: string, state: string, score = 90) {
  const stamps: Record<string, string> = {};
  const order = ["proposed", "shown_to_a", "a_interested", "shown_to_b", "b_interested", "both_interested", "payment_pending"];
  for (const s of order) { stamps[s] = new Date().toISOString(); if (s === state) break; }
  const [row] = await db().insert(schema.matches).values({ userA: a, userB: b, score, breakdown: [], state, stateTimestamps: stamps }).returning();
  return row!;
}

export async function outbound(phone: string) {
  const rows = await db().select().from(schema.messages).where(sql`${schema.messages.phone} = ${phone} AND ${schema.messages.direction} = 'outbound'`).orderBy(schema.messages.createdAt);
  return rows.map((r) => r.rawText ?? "");
}

export async function inbound(phone: string, text: string, type = "text", extra: Partial<typeof schema.messages.$inferInsert> = {}) {
  // Mirrors ingest: on phone-number channels the identity is a verified contact number.
  const contact = phone.startsWith("+") ? { contactPhone: phone, contactPhoneVerified: true, contactPhoneSource: "channel" } : {};
  await db().insert(schema.users).values({ phone, lastInboundAt: new Date(), ...contact }).onConflictDoUpdate({ target: schema.users.phone, set: { lastInboundAt: new Date() } });
  const [m] = await db().insert(schema.messages).values({ phone, direction: "inbound", type, rawText: text, waMessageId: `wa-${crypto.randomUUID()}`, ...extra }).returning();
  return m!;
}
