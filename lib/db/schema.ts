import { sql } from "drizzle-orm";
import {
  bigint, boolean, customType, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const vector384 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(384)",
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => JSON.parse(v) as number[],
});

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();
const phoneFk = (name: string) => text(name).notNull().references(() => users.phone, { onDelete: "cascade", onUpdate: "cascade" });

export const users = pgTable("users", {
  // The channel's identity for this person: E.164 on WhatsApp and the simulator, "fb:<PSID>" on Messenger.
  // Never shown to other users. The number released after payment is contact_phone.
  phone: text("phone").primaryKey(),
  name: text("name"),
  gender: text("gender"),
  // new → awaiting_age → awaiting_consent → active; ended_underage, consent_declined, deleted are terminal.
  // awaiting_phone is legacy: the contact number is now asked after the profile questions.
  status: text("status").notNull().default("new"),
  createdByRelation: text("created_by_relation"),
  ageConfirmedAt: ts("age_confirmed_at"),
  consentAt: ts("consent_at"),
  blocked: boolean("blocked").notNull().default(false),
  profileComplete: boolean("profile_complete").notNull().default(false),
  profileCompletedAt: ts("profile_completed_at"),
  lastInboundAt: ts("last_inbound_at"),
  // E.164 number released to a paid match. Channel-provided numbers are verified; typed ones need an admin.
  contactPhone: text("contact_phone"),
  contactPhoneVerified: boolean("contact_phone_verified").notNull().default(false),
  contactPhoneSource: text("contact_phone_source"), // channel | messenger_profile | typed
  // Asked right after the contact number; null until answered.
  contactHasWhatsapp: boolean("contact_has_whatsapp"),
  // The last onboarding step, after WhatsApp: send photos, and say whether a proposal may see them without being asked each time.
  photoStepDone: boolean("photo_step_done").notNull().default(false),
  photoShareConsent: boolean("photo_share_consent"), // null until answered
  // Set when a number is released to this person (they are talking to someone); cleared when they ask for more matches.
  matchingPaused: boolean("matching_paused").notNull().default(false),
  // A person replied from the Page inbox: BS stays quiet for this user until then.
  humanUntil: ts("human_until"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("users_match_pool_idx").on(t.gender, t.status, t.profileComplete, t.blocked),
]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: phoneFk("phone"),
  direction: text("direction").notNull(), // inbound | outbound
  type: text("type").notNull(), // text | voice | image | template | notification | optin_request | other
  rawText: text("raw_text"),
  transcript: text("transcript"),
  mediaKey: text("media_key"),
  mediaId: text("media_id"),
  // Set only from the channel's phone-sharing control, never parsed from typed text.
  sharedPhone: text("shared_phone"),
  mediaMime: text("media_mime"),
  waMessageId: text("wa_message_id").unique(),
  dedupeKey: text("dedupe_key").unique(),
  // outbound: queued → sent → delivered → read | failed | skipped_window. inbound: received
  status: text("status").notNull().default("received"),
  statusAt: ts("status_at"),
  processedAt: ts("processed_at"),
  usageSeconds: doublePrecision("usage_seconds"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  cachedTokens: integer("cached_tokens"),
  createdAt: createdAt(),
}, (t) => [index("messages_phone_created_idx").on(t.phone, t.createdAt)]);

export const messageEmbeddings = pgTable("message_embeddings", {
  messageId: uuid("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  phone: phoneFk("phone"),
  embedding: vector384("embedding").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("message_embeddings_phone_idx").on(t.phone),
  index("message_embeddings_hnsw_idx").using("hnsw", sql`${t.embedding} vector_cosine_ops`),
]);

export const questions = pgTable("questions", {
  key: text("key").primaryKey(),
  bengaliText: text("bengali_text").notNull(),
  fieldType: text("field_type").notNull(), // text | number | select | multiselect | range | district | location_list
  options: jsonb("options").$type<unknown>(),
  order: integer("order").notNull().default(0),
  required: boolean("required").notNull().default(true),
  active: boolean("active").notNull().default(true),
  askCondition: jsonb("ask_condition").$type<unknown>(),
});

export const profileAnswers = pgTable("profile_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: phoneFk("phone"),
  questionKey: text("question_key").notNull(),
  value: jsonb("value").$type<unknown>().notNull(),
  source: text("source").notNull(), // asked | volunteered | inferred
  confidence: doublePrecision("confidence").notNull(),
  confirmAskedAt: ts("confirm_asked_at"),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("profile_answers_phone_key_idx").on(t.phone, t.questionKey),
  index("profile_answers_key_idx").on(t.questionKey),
]);

export const preferences = pgTable("preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: phoneFk("phone"),
  field: text("field").notNull(),
  operator: text("operator").notNull(), // eq | neq | in | not_in | gte | lte | between
  value: jsonb("value").$type<unknown>().notNull(),
  isDealbreaker: boolean("is_dealbreaker").notNull().default(false),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("preferences_phone_field_idx").on(t.phone, t.field),
  index("preferences_dealbreaker_idx").on(t.phone).where(sql`${t.isDealbreaker}`),
]);

export const photos = pgTable("photos", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: phoneFk("phone"),
  r2Key: text("r2_key").notNull(),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
  ownerConfirmedAt: ts("owner_confirmed_at"),
  approvedByAdmin: boolean("approved_by_admin"), // null = not reviewed (shareable), false = removed by an admin
  reviewedBy: text("reviewed_by"),
  reviewedAt: ts("reviewed_at"),
  createdAt: createdAt(),
}, (t) => [index("photos_phone_idx").on(t.phone)]);

export const matches = pgTable("matches", {
  id: uuid("id").primaryKey().defaultRandom(),
  userA: phoneFk("user_a"),
  userB: phoneFk("user_b"),
  score: doublePrecision("score").notNull(),
  breakdown: jsonb("breakdown").$type<unknown>().notNull(),
  state: text("state").notNull().default("proposed"),
  stateTimestamps: jsonb("state_timestamps").$type<Record<string, string>>().notNull().default({}),
  closeReason: text("close_reason"),
  // Who asked for the other's number. Payment details go to them once both sides are interested.
  numberRequestedBy: text("number_requested_by").array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("matches_pair_idx").on(sql`LEAST(${t.userA}, ${t.userB})`, sql`GREATEST(${t.userA}, ${t.userB})`),
  index("matches_state_idx").on(t.state, t.score),
  index("matches_user_a_idx").on(t.userA, t.createdAt),
  index("matches_user_b_idx").on(t.userB, t.createdAt),
]);

export const photoRequests = pgTable("photo_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  requester: phoneFk("requester"),
  owner: phoneFk("owner"),
  status: text("status").notNull().default("pending"), // pending | approved | denied | no_photo
  respondedAt: ts("responded_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("photo_requests_match_requester_idx").on(t.matchId, t.requester)]);

/** Questions one side asks the other through BS. Delivered once the other side can see the match. */
export const matchQuestions = pgTable("match_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  asker: phoneFk("asker"),
  question: text("question").notNull(),
  answer: text("answer"),
  status: text("status").notNull().default("pending"), // pending | delivered | answered
  deliveredAt: ts("delivered_at"),
  answeredAt: ts("answered_at"),
  createdAt: createdAt(),
}, (t) => [index("match_questions_match_idx").on(t.matchId, t.status)]);

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  payerPhone: phoneFk("payer_phone"),
  method: text("method").notNull().default("bkash"),
  // Only the last 4 digits: Meta's policy forbids asking for financial account numbers in messages.
  senderWalletNumber: text("sender_wallet_number"),
  // Null when the payer had no Transaction ID and gave the last 4 digits and time instead.
  trxId: text("trx_id").unique(),
  // What the payer said about the payment (time, amount) when there was no Transaction ID. For the admin only.
  claimDetails: text("claim_details"),
  amount: integer("amount").notNull(),
  status: text("status").notNull().default("pending"), // pending | verified | rejected
  note: text("note"),
  verifiedBy: text("verified_by"),
  verifiedAt: ts("verified_at"),
  createdAt: createdAt(),
}, (t) => [
  index("payments_status_idx").on(t.status, t.createdAt),
  index("payments_match_idx").on(t.matchId),
  uniqueIndex("payments_one_open_per_payer_idx").on(t.matchId, t.payerPhone).where(sql`${t.status} <> 'rejected'`),
]);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(), // owner | verifier
  createdAt: createdAt(),
});

export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity"),
  entityId: text("entity_id"),
  details: jsonb("details").$type<unknown>(),
  createdAt: createdAt(),
}, (t) => [index("audit_log_created_idx").on(t.createdAt)]);

export const escalations = pgTable("escalations", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: phoneFk("phone"),
  kind: text("kind").notNull(), // human | report | refund | injection
  reason: text("reason").notNull(),
  matchId: uuid("match_id").references(() => matches.id, { onDelete: "set null" }),
  status: text("status").notNull().default("open"), // open | resolved
  resolvedBy: text("resolved_by"),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
}, (t) => [index("escalations_status_idx").on(t.status, t.createdAt)]);

/** Messenger One-Time Notification tokens: each allows one message outside the 24-hour window on its topic. */
export const notificationTokens = pgTable("notification_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: phoneFk("phone"),
  topic: text("topic").notNull(), // new_proposal | proposal_update
  token: text("token").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
}, (t) => [
  // A newer opt-in replaces the unused token rather than stacking up.
  uniqueIndex("notification_tokens_one_unused_idx").on(t.phone, t.topic).where(sql`${t.usedAt} IS NULL`),
]);
