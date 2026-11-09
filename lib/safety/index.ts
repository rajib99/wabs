import { randomUUID } from "node:crypto";
import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { getChannel } from "@/lib/channel";
import { db, schema } from "@/lib/db";
import { closeMatch, getMatch, isClosed, isVisibleTo } from "@/lib/matches";
import { logger } from "@/lib/logger";
import { getSetting, msg, setSetting } from "@/lib/settings";
import { getStorage } from "@/lib/storage";
import { findPhoneLike, normalizeDigits, toAsciiDigits } from "@/lib/text";

const { users, messages } = schema;

/**
 * Erases the channel's own copy of a conversation. The channel being down must not block erasing our data,
 * so a failure goes on a retry queue, which the outbound-queue job drains.
 */
export async function eraseFromChannel(phone: string) {
  const erase = getChannel().eraseConversation?.bind(getChannel());
  if (!erase) return;
  try {
    await erase(phone);
  } catch (err) {
    logger.warn({ err }, "gateway erase failed: queued for retry");
    const queue = await getSetting<string[]>("gateway_erase_queue");
    if (!queue.includes(phone)) await setSetting("gateway_erase_queue", [...queue, phone]);
  }
}

export async function drainGatewayEraseQueue() {
  const queue = await getSetting<string[]>("gateway_erase_queue");
  if (!queue.length) return 0;
  const erase = getChannel().eraseConversation?.bind(getChannel());
  if (!erase) {
    await setSetting("gateway_erase_queue", []);
    return 0;
  }
  const remaining: string[] = [];
  for (const phone of queue) {
    try {
      await erase(phone);
    } catch {
      remaining.push(phone);
    }
  }
  await setSetting("gateway_erase_queue", remaining);
  return queue.length - remaining.length;
}

/** The whole message must be the command, so a sentence that merely contains "বন্ধ" cannot erase a profile. */
export function isStopCommand(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[।.!\s]+$/, "");
  return ["stop", "delete", "unsubscribe", "বন্ধ", "বন্ধ করুন", "স্টপ", "ডিলিট", "ডিলিট করুন", "মুছে ফেলুন", "আমার তথ্য মুছে ফেলুন", "আমার প্রোফাইল ডিলিট করুন"].includes(t);
}

export type YesNo = "yes" | "no" | "unclear";

export function parseYesNo(text: string): YesNo {
  const t = text.trim().toLowerCase();
  if (/^(না|নাহ|জি না|জ্বি না|no|nope|রাজি না|রাজি নই)([\s।.!]|$)/.test(t)) return "no";
  if (/^(হ্যাঁ|হ্যা|হা|জি|জ্বি|yes|ok|okay|ঠিক আছে|রাজি|আছে)([\s।.!]|$)/.test(t)) return "yes";
  return "unclear";
}

/** Understands "হ্যাঁ", "না", or a stated age such as "২৫" or "আমার বয়স ১৬". */
export function parseAgeGate(text: string, minAge: number): "adult" | "minor" | "unclear" {
  const nums = (toAsciiDigits(text).match(/\d{1,3}/g) ?? []).map(Number).filter((n) => n > 0 && n < 120);
  if (nums.length === 1) return nums[0]! >= minAge ? "adult" : "minor";
  const yn = parseYesNo(text);
  return yn === "yes" ? "adult" : yn === "no" ? "minor" : "unclear";
}

const INJECTION_RE = /(ignore (all |your |previous )|system prompt|you are now|jailbreak|developer mode|আগের নির্দেশ|নিয়ম ভুলে|নির্দেশনা ভুলে|আমি অ্যাডমিন|i am (the )?admin|verified করে দাও|ভেরিফাই করে দাও|ফোন নম্বর দাও|নম্বরটা দাও|তার নম্বর)/i;

export const looksLikeInjection = (text: string) => INJECTION_RE.test(text);

/** Last line of defence on LLM output: no phone numbers except the user's own and the bKash number. */
export function guardReply(reply: string, allowed: string[]): string {
  const allowedDigits = allowed.map((p) => normalizeDigits(p).slice(-10)).filter(Boolean);
  let out = reply;
  for (const found of findPhoneLike(reply)) {
    if (!allowedDigits.includes(normalizeDigits(found).slice(-10))) out = out.replace(found, "[গোপন]");
  }
  return limitQuestions(out).trim();
}

/** At most two questions per reply: anything after the second question mark is dropped. */
export function limitQuestions(text: string, max = 2): string {
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "?" && ++seen === max) return text.slice(0, i + 1);
  }
  return text;
}

export async function isRateLimited(phone: string): Promise<boolean> {
  const [perMinute, perDay] = await Promise.all([getSetting<number>("rate_limit_per_minute"), getSetting<number>("rate_limit_per_day")]);
  const count = async (since: Date) => {
    const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(messages)
      .where(and(eq(messages.phone, phone), eq(messages.direction, "inbound"), gte(messages.createdAt, since)));
    return row?.n ?? 0;
  };
  const now = Date.now();
  return (await count(new Date(now - 60_000))) > perMinute || (await count(new Date(now - 86_400_000))) > perDay;
}

/** Blanks message text and removes the row's media reference: used for anything received before consent. */
export async function scrubMessages(phone: string) {
  await db().update(messages).set({ rawText: null, transcript: null }).where(and(eq(messages.phone, phone), eq(messages.direction, "inbound")));
}

export async function reportMatch(phone: string, matchId: string, reason: string) {
  const match = await getMatch(matchId);
  if (!match || !isVisibleTo(match, phone)) return { ok: false as const, error: "match not found" };
  await db().insert(schema.escalations).values({ phone, kind: "report", matchId, reason: reason.slice(0, 1000) });
  if (!isClosed(match.state)) await closeMatch(matchId, "declined", "user_report", "reported", phone);
  await audit("user", "match.reported", "match", matchId);
  return { ok: true as const, note: await msg("report_received") };
}

export async function escalate(phone: string, reason: string) {
  await db().insert(schema.escalations).values({ phone, kind: "human", reason: reason.slice(0, 1000) });
  return { ok: true as const, note: await msg("escalated") };
}

/**
 * STOP/delete. Removes profile, media, messages and preferences. Open matches close without revealing why.
 * The user row and closed matches are kept under a random tombstone id (ON UPDATE CASCADE) so other users'
 * match history and financial records stay consistent while nothing links them to this number.
 * Safe to retry: every stage tolerates its work being already done.
 */
export async function eraseUser(phone: string, actor = "user") {
  const d = db();
  const [user] = await d.select().from(users).where(eq(users.phone, phone));
  if (!user) return;

  const openMatches = await d.select().from(schema.matches)
    .where(or(eq(schema.matches.userA, phone), eq(schema.matches.userB, phone)));
  for (const m of openMatches) {
    if (!isClosed(m.state)) await closeMatch(m.id, "declined", "system", "party_erased", phone);
  }

  const storage = getStorage();
  const media = await d.select({ key: messages.mediaKey }).from(messages)
    .where(and(eq(messages.phone, phone), eq(messages.direction, "inbound"), isNotNull(messages.mediaKey)));
  const photoRows = await d.select({ key: schema.photos.r2Key }).from(schema.photos).where(eq(schema.photos.phone, phone));
  for (const key of new Set([...media.map((m) => m.key!), ...photoRows.map((p) => p.key)])) await storage.delete(key);

  await eraseFromChannel(phone);

  const tombstone = `deleted:${randomUUID()}`;
  await d.transaction(async (tx) => {
    await tx.delete(schema.messages).where(eq(messages.phone, phone));
    await tx.delete(schema.profileAnswers).where(eq(schema.profileAnswers.phone, phone));
    await tx.delete(schema.preferences).where(eq(schema.preferences.phone, phone));
    await tx.delete(schema.photos).where(eq(schema.photos.phone, phone));
    await tx.delete(schema.photoRequests).where(or(eq(schema.photoRequests.requester, phone), eq(schema.photoRequests.owner, phone)));
    await tx.update(schema.payments).set({ status: "rejected", note: "user erased" })
      .where(and(eq(schema.payments.payerPhone, phone), eq(schema.payments.status, "pending")));
    await tx.update(schema.payments).set({ senderWalletNumber: null }).where(eq(schema.payments.payerPhone, phone));
    await tx.update(schema.escalations).set({ reason: "[erased]" }).where(eq(schema.escalations.phone, phone));
    await tx.update(schema.auditLog).set({ entityId: tombstone }).where(eq(schema.auditLog.entityId, phone));
    await tx.update(users).set({
      phone: tombstone, name: null, gender: null, createdByRelation: null, status: "deleted", consentAt: null,
      ageConfirmedAt: null, profileComplete: false, profileCompletedAt: null, lastInboundAt: null, updatedAt: new Date(),
    }).where(eq(users.phone, phone));
  });
  await audit(actor, "user.erased", "user", tombstone);
}

/** Sent straight through the channel: nothing about this user may be written back to the database. */
export async function sendStopConfirmation(phone: string) {
  await getChannel().sendText(phone, await msg("stop_confirmed"));
}

/** Under the minimum age: stop, remove what was said, and keep only a blocked marker for this number. */
export async function endUnderage(phone: string) {
  const d = db();
  const open = await d.select().from(schema.matches).where(or(eq(schema.matches.userA, phone), eq(schema.matches.userB, phone)));
  for (const m of open) if (!isClosed(m.state)) await closeMatch(m.id, "declined", "system", "underage", phone);
  await d.delete(schema.profileAnswers).where(eq(schema.profileAnswers.phone, phone));
  await d.delete(schema.preferences).where(eq(schema.preferences.phone, phone));
  await d.delete(messages).where(eq(messages.phone, phone));
  await eraseFromChannel(phone);
  await d.update(users).set({ status: "ended_underage", blocked: true, name: null, gender: null, profileComplete: false, updatedAt: new Date() }).where(eq(users.phone, phone));
  await audit("system", "user.underage_ended", "user", phone);
}
