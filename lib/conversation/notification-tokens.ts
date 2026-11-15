import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { NotificationOptin } from "@/lib/channel";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getSetting } from "@/lib/settings";

const { notificationTokens: tokens } = schema;

export type TopicConfig = { enabled: boolean; title: string; message: string };

/**
 * Which one-time-notification topic can stand in for a template when the template is missing or refused.
 * Payment and contact templates have no stand-in: the generic notice cannot carry what they must say.
 */
export const TEMPLATE_TOPIC: Record<string, string> = { match_intro: "new_proposal", match_update: "proposal_update" };

export async function notificationTopics(): Promise<Record<string, TopicConfig>> {
  return getSetting<Record<string, TopicConfig>>("notification_topics");
}

/** Stores an opt-in, replacing any unused token on the same topic. Unknown topics and unknown people are ignored. */
export async function storeOptin(o: NotificationOptin): Promise<boolean> {
  const d = db();
  if (!(await notificationTopics())[o.topic]) {
    logger.warn({ topic: o.topic }, "opt-in for an unknown notification topic ignored");
    return false;
  }
  const [user] = await d.select({ phone: schema.users.phone }).from(schema.users).where(eq(schema.users.phone, o.phone));
  if (!user) return false;
  const days = await getSetting<number>("notification_token_ttl_days");
  const expiresAt = o.expiresAt ?? new Date(o.timestamp.getTime() + days * 86400_000);
  await d.insert(tokens).values({ phone: o.phone, topic: o.topic, token: o.token, expiresAt, createdAt: o.timestamp })
    .onConflictDoUpdate({
      target: [tokens.phone, tokens.topic], targetWhere: sql`${tokens.usedAt} IS NULL`,
      set: { token: o.token, expiresAt, createdAt: o.timestamp },
    });
  return true;
}

/**
 * Takes the person's live token on `topic` for one send, marking it used in the same statement. There is at most
 * one unused token per person and topic, so two concurrent sends cannot both get it.
 */
export async function claimToken(phone: string, topic: string): Promise<{ id: string; token: string } | undefined> {
  const [row] = await db().update(tokens).set({ usedAt: new Date() })
    .where(and(eq(tokens.phone, phone), eq(tokens.topic, topic), isNull(tokens.usedAt), gt(tokens.expiresAt, new Date())))
    .returning({ id: tokens.id, token: tokens.token });
  return row;
}

/** Gives a token back after a send that failed for a reason worth retrying. A newer opt-in, if any, wins. */
export async function releaseToken(id: string) {
  try {
    await db().update(tokens).set({ usedAt: null }).where(eq(tokens.id, id));
  } catch (err) {
    logger.warn({ err }, "token not released: a newer opt-in replaced it");
  }
}

/** All tokens the person ever gave on a topic, used or not. */
export async function tokenHistory(phone: string, topic: string) {
  return db().select().from(tokens).where(and(eq(tokens.phone, phone), eq(tokens.topic, topic)));
}
