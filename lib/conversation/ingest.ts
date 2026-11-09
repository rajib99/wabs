import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import { inngest } from "@/inngest/client";
import { audit } from "@/lib/audit";
import type { ReceivedPayload } from "@/lib/channel";
import type { OpenWAAdapter, UnresolvedSender } from "@/lib/channel/openwa";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSetting, msg } from "@/lib/settings";
import { db, schema } from "@/lib/db";

/** While testing on a live channel only listed numbers are served. Anyone else leaves no trace in our database. */
export async function isAllowedSender(phone: string): Promise<boolean> {
  if (env.channel() === "mock") return true;
  if (!(await getSetting<boolean>("live_allowlist_enabled"))) return true;
  return (await getSetting<string[]>("live_allowlist")).includes(phone);
}

const apologized = new Map<string, number>();
const APOLOGY_INTERVAL_MS = 3600_000;

/**
 * A sender whose real number WhatsApp will not tell us cannot be served: the phone number is our identity
 * and is what the payment flow releases. Ask them to retry, at most hourly, and leave a record for the owner.
 */
export async function handleUnresolvedSenders(adapter: Pick<OpenWAAdapter, "sendRaw">, senders: UnresolvedSender[]) {
  for (const { chatId } of senders) {
    await audit("openwa", "channel.unverified_sender", "chat", chatId);
    logger.warn("message from a sender whose phone number could not be resolved");
    if (await getSetting<boolean>("live_allowlist_enabled")) continue; // cannot tell if they are a tester
    if (Date.now() - (apologized.get(chatId) ?? 0) < APOLOGY_INTERVAL_MS) continue;
    apologized.set(chatId, Date.now());
    await adapter.sendRaw(chatId, await msg("unverified_sender"));
  }
}

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/**
 * The only work done in the webhook request: dedupe, persist, and enqueue.
 * Redelivery of an unprocessed message re-sends the event; Inngest dedupes it by event id.
 */
export async function ingestPayload({ messages, statuses }: ReceivedPayload) {
  const d = db();
  for (const m of messages) {
    if (!(await isAllowedSender(m.phone))) continue;
    await d.insert(schema.users)
      .values({ phone: m.phone, lastInboundAt: m.timestamp })
      .onConflictDoUpdate({
        target: schema.users.phone,
        set: { lastInboundAt: sql`GREATEST(${schema.users.lastInboundAt}, ${m.timestamp.toISOString()}::timestamptz)` },
      });

    const inserted = await d.insert(schema.messages).values({
      phone: m.phone,
      direction: "inbound",
      type: m.type,
      rawText: m.text,
      mediaId: m.mediaId,
      mediaMime: m.mediaMime,
      waMessageId: m.waMessageId,
      createdAt: m.timestamp,
    }).onConflictDoNothing({ target: schema.messages.waMessageId }).returning({ id: schema.messages.id });

    let id = inserted[0]?.id;
    if (!id) {
      const [existing] = await d.select({ id: schema.messages.id, processedAt: schema.messages.processedAt })
        .from(schema.messages).where(eq(schema.messages.waMessageId, m.waMessageId));
      if (!existing || existing.processedAt) continue;
      id = existing.id;
    }
    await inngest.send({ id: `wa-${m.waMessageId}`, name: "wa/message.received", data: { messageId: id, phone: m.phone } });
  }

  for (const s of statuses) {
    const [row] = await d.select({ id: schema.messages.id, status: schema.messages.status })
      .from(schema.messages).where(eq(schema.messages.waMessageId, s.waMessageId));
    if (!row) continue;
    // Webhook statuses can arrive out of order: never move backwards, except to failed.
    if (s.status !== "failed" && (STATUS_RANK[s.status] ?? 0) <= (STATUS_RANK[row.status] ?? 0)) continue;
    await d.update(schema.messages).set({ status: s.status, statusAt: s.timestamp }).where(eq(schema.messages.id, row.id));
  }
}

/** After a pause, answers what was held, oldest first. Fresh event ids because the originals were already consumed. */
export async function resumeHeldMessages(): Promise<number> {
  const rows = await db().select({ id: schema.messages.id, phone: schema.messages.phone }).from(schema.messages).where(and(
    eq(schema.messages.direction, "inbound"), isNull(schema.messages.processedAt), gte(schema.messages.createdAt, new Date(Date.now() - 24 * 3600 * 1000)),
  )).orderBy(asc(schema.messages.createdAt));
  const stamp = Date.now();
  for (const r of rows) {
    await inngest.send({ id: `resume-${r.id}-${stamp}`, name: "wa/message.received", data: { messageId: r.id, phone: r.phone } });
  }
  return rows.length;
}
