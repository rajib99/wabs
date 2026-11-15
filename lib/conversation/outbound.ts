import { and, asc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { getChannel, type MediaFile, PermanentSendError } from "@/lib/channel";
import { logger } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import { db, schema } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { claimToken, notificationTopics, releaseToken, TEMPLATE_TOPIC } from "./notification-tokens";

const WINDOW_MS = 24 * 3600 * 1000;

export function inServiceWindow(lastInboundAt: Date | null, now = new Date()): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

export type SendOptions = {
  /** Makes retries of an Inngest step safe: the same key is never delivered twice. */
  dedupeKey?: string;
  /** Logical template (a key of settings.templates) used when outside the 24-hour window. */
  template?: string;
  templateParams?: string[];
  /** Leave the message queued on a send failure instead of throwing. The outbound queue delivers it later. */
  deferOnFailure?: boolean;
  /** Attach the channel's phone-sharing control, where it has one. */
  requestPhone?: boolean;
  /** Send the text as the channel's one-time-notification opt-in card for this topic, where it has one. */
  notificationRequest?: string;
};

export type SendOutcome = "sent" | "duplicate" | "skipped_window" | "deferred" | "failed";

type Row = typeof schema.messages.$inferSelect;

async function markSent(row: Row, waMessageId: string, type?: string) {
  await db().update(schema.messages).set({ status: "sent", waMessageId, statusAt: new Date(), ...(type ? { type } : {}) }).where(eq(schema.messages.id, row.id));
}

async function markStatus(row: Row, status: string) {
  await db().update(schema.messages).set({ status, statusAt: new Date() }).where(eq(schema.messages.id, row.id));
}

/**
 * A transient failure: leave it queued (deferOnFailure) or rethrow for Inngest to retry. A dedupe key keeps the
 * row queued for that retry; without one it is marked failed.
 */
async function transientFailure(row: Row, err: unknown, opts: SendOptions): Promise<SendOutcome> {
  if (opts.deferOnFailure && opts.dedupeKey) {
    logger.warn({ err, messageId: row.id }, "send failed: left in the outbound queue");
    return "deferred";
  }
  if (!opts.dedupeKey) await markStatus(row, "failed");
  throw err; // Inngest retries the step
}

/**
 * Outside the service window, in order: the approved template; if it is missing or refused, a one-time
 * notification token on the matching topic; otherwise nothing is sent and the row is kept as skipped_window.
 * Neither the template nor the notification carries the message itself; the agent shows it once they reply.
 */
async function sendOutsideWindow(row: Row, phone: string, opts: SendOptions): Promise<SendOutcome> {
  const channel = getChannel();
  if (opts.template) {
    const name = (await getSetting<Record<string, string>>(channel.templateSettingKey ?? "templates"))[opts.template] ?? "";
    if (name) {
      try {
        const { waMessageId } = await channel.sendTemplate(phone, name, await getSetting<string>("template_language"), opts.templateParams ?? []);
        await markSent(row, waMessageId, "template");
        return "sent";
      } catch (err) {
        if (!(err instanceof PermanentSendError)) return transientFailure(row, err, opts);
        // Refused, paused or re-categorised by Meta: never resent. Try the token instead.
        logger.warn({ err, messageId: row.id, template: opts.template }, "template refused permanently");
      }
    }
  }

  const topic = opts.template ? TEMPLATE_TOPIC[opts.template] : undefined;
  const text = topic && channel.sendNotification ? (await notificationTopics())[topic]?.message?.trim() : undefined;
  const claimed = text ? await claimToken(phone, topic!) : undefined;
  if (claimed) {
    try {
      const { waMessageId } = await channel.sendNotification!(phone, claimed.token, text!);
      await markSent(row, waMessageId, "notification");
      return "sent";
    } catch (err) {
      if (!(err instanceof PermanentSendError)) {
        await releaseToken(claimed.id);
        return transientFailure(row, err, opts);
      }
      logger.warn({ err, messageId: row.id, topic }, "notification token refused permanently"); // spent or revoked: it stays used
    }
  }

  // Meta would reject free-form text here. It stays visible to the agent and the admin.
  await markStatus(row, "skipped_window");
  return "skipped_window";
}

/** All outbound user messages go through here: 24-hour window, dedupe, and logging. */
export async function sendToUser(phone: string, text: string, opts: SendOptions & { image?: MediaFile; mediaKey?: string } = {}): Promise<SendOutcome> {
  const d = db();
  const [user] = await d.select({ lastInboundAt: schema.users.lastInboundAt }).from(schema.users).where(eq(schema.users.phone, phone));
  const channel = getChannel();
  const inWindow = !channel.enforcesServiceWindow || inServiceWindow(user?.lastInboundAt ?? null);
  const optin = inWindow && opts.notificationRequest && channel.requestNotification ? opts.notificationRequest : undefined;
  const type = optin ? "optin_request" : opts.image ? "image" : "text";

  const values = { phone, direction: "outbound", type, rawText: text, mediaKey: opts.mediaKey, dedupeKey: opts.dedupeKey, status: "queued" };
  let [row] = await d.insert(schema.messages).values(values).onConflictDoNothing({ target: schema.messages.dedupeKey }).returning();
  if (!row) {
    [row] = await d.select().from(schema.messages).where(eq(schema.messages.dedupeKey, opts.dedupeKey!));
    if (!row || row.status !== "queued") return "duplicate"; // a previous attempt already finished
  }

  if (!inWindow) {
    if (opts.notificationRequest) { // an opt-in card is only allowed inside the window
      await markStatus(row, "skipped_window");
      return "skipped_window";
    }
    return sendOutsideWindow(row, phone, opts);
  }

  try {
    const { waMessageId } = optin
      ? await channel.requestNotification!(phone, optin, row.rawText ?? text)
      : opts.requestPhone && channel.requestPhone && !opts.image
      ? await channel.requestPhone(phone, row.rawText ?? text)
      : opts.image
        ? await channel.sendImage(phone, opts.image, row.rawText ?? text)
        : await channel.sendText(phone, row.rawText ?? text); // a retry sends what was first queued, never a recomputed text
    await markSent(row, waMessageId);
    return "sent";
  } catch (err) {
    if (err instanceof PermanentSendError) {
      // Retrying a refused send only adds to the Page's failure record.
      logger.warn({ err, messageId: row.id }, "send refused permanently");
      await markStatus(row, "failed");
      return "failed";
    }
    return transientFailure(row, err, opts);
  }
}

/**
 * Two-phase send used by the agent: the reply is written to the database in one step and delivered in the
 * next, so message text never lands in Inngest's step history and a failed send does not re-run the LLM.
 */
export async function queueText(phone: string, text: string, dedupeKey: string, usage?: { promptTokens: number; completionTokens: number; cachedTokens: number }) {
  await db().insert(schema.messages).values({ phone, direction: "outbound", type: "text", rawText: text, dedupeKey, status: "queued", ...usage })
    .onConflictDoNothing({ target: schema.messages.dedupeKey });
}

export async function sendQueued(dedupeKey: string, opts: Pick<SendOptions, "requestPhone"> = {}): Promise<SendOutcome | "missing"> {
  const [row] = await db().select().from(schema.messages).where(eq(schema.messages.dedupeKey, dedupeKey));
  if (!row) return "missing";
  if (row.status !== "queued") return "duplicate";
  return sendToUser(row.phone, row.rawText ?? "", { dedupeKey, ...opts });
}

const QUEUE_MIN_AGE_MS = 10 * 60 * 1000; // leaves room for Inngest's own step retries
const QUEUE_MAX_AGE_MS = 24 * 3600 * 1000; // past this the message is stale, and the agent still has it in context

/**
 * Delivers messages left behind when the channel was down (a dropped session, a pacing refusal).
 * Stops at the first failure: the channel is still down, and order must hold.
 */
export async function flushOutboundQueue(limit = 50): Promise<{ sent: number; expired: number }> {
  const d = db();
  const now = Date.now();
  const expired = await d.update(schema.messages).set({ status: "failed", statusAt: new Date() }).where(and(
    eq(schema.messages.direction, "outbound"), eq(schema.messages.status, "queued"), lt(schema.messages.createdAt, new Date(now - QUEUE_MAX_AGE_MS)),
  )).returning({ id: schema.messages.id });

  const rows = await d.select().from(schema.messages).where(and(
    eq(schema.messages.direction, "outbound"), eq(schema.messages.status, "queued"), isNotNull(schema.messages.dedupeKey),
    lt(schema.messages.createdAt, new Date(now - QUEUE_MIN_AGE_MS)), gte(schema.messages.createdAt, new Date(now - QUEUE_MAX_AGE_MS)),
  )).orderBy(asc(schema.messages.createdAt)).limit(limit);

  let sent = 0;
  for (const row of rows) {
    try {
      const image = row.type === "image" && row.mediaKey ? await getStorage().get(row.mediaKey) : undefined;
      if ((await sendToUser(row.phone, row.rawText ?? "", { dedupeKey: row.dedupeKey!, image, mediaKey: row.mediaKey ?? undefined })) === "sent") sent++;
    } catch (err) {
      logger.warn({ err, messageId: row.id }, "outbound queue paused: channel still failing");
      break;
    }
  }
  return { sent, expired: expired.length };
}
