import { and, asc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { getChannel, type MediaFile, PermanentSendError } from "@/lib/channel";
import { logger } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import { db, schema } from "@/lib/db";
import { getSetting } from "@/lib/settings";

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
};

export type SendOutcome = "sent" | "duplicate" | "skipped_window" | "deferred" | "failed";

/** All outbound user messages go through here: 24-hour window, dedupe, and logging. */
export async function sendToUser(phone: string, text: string, opts: SendOptions & { image?: MediaFile; mediaKey?: string } = {}): Promise<SendOutcome> {
  const d = db();
  const [user] = await d.select({ lastInboundAt: schema.users.lastInboundAt }).from(schema.users).where(eq(schema.users.phone, phone));
  const channel = getChannel();
  const inWindow = !channel.enforcesServiceWindow || inServiceWindow(user?.lastInboundAt ?? null);

  let templateName = "";
  if (!inWindow && opts.template) {
    templateName = (await getSetting<Record<string, string>>(channel.templateSettingKey ?? "templates"))[opts.template] ?? "";
  }
  const type = inWindow || !templateName ? (opts.image ? "image" : "text") : "template";

  const values = { phone, direction: "outbound", type, rawText: text, mediaKey: opts.mediaKey, dedupeKey: opts.dedupeKey, status: "queued" };
  let [row] = await d.insert(schema.messages).values(values).onConflictDoNothing({ target: schema.messages.dedupeKey }).returning();
  if (!row) {
    [row] = await d.select().from(schema.messages).where(eq(schema.messages.dedupeKey, opts.dedupeKey!));
    if (!row || row.status !== "queued") return "duplicate"; // a previous attempt already finished
  }

  if (!inWindow && !templateName) {
    // Meta would reject free-form text here. It stays visible to the agent and the admin.
    await d.update(schema.messages).set({ status: "skipped_window", statusAt: new Date() }).where(eq(schema.messages.id, row.id));
    return "skipped_window";
  }

  try {
    const { waMessageId } = opts.requestPhone && channel.requestPhone && type === "text"
      ? await channel.requestPhone(phone, row.rawText ?? text)
      : type === "template"
      ? await channel.sendTemplate(phone, templateName, await getSetting<string>("template_language"), opts.templateParams ?? [])
      : opts.image
        ? await channel.sendImage(phone, opts.image, row.rawText ?? text)
        : await channel.sendText(phone, row.rawText ?? text); // a retry sends what was first queued, never a recomputed text
    await d.update(schema.messages).set({ status: "sent", waMessageId, statusAt: new Date() }).where(eq(schema.messages.id, row.id));
    return "sent";
  } catch (err) {
    if (err instanceof PermanentSendError) {
      // Retrying a refused send only adds to the Page's failure record.
      logger.warn({ err, messageId: row.id }, "send refused permanently");
      await d.update(schema.messages).set({ status: "failed", statusAt: new Date() }).where(eq(schema.messages.id, row.id));
      return "failed";
    }
    if (opts.deferOnFailure && opts.dedupeKey) {
      logger.warn({ err, messageId: row.id }, "send failed: left in the outbound queue");
      return "deferred";
    }
    if (!opts.dedupeKey) await d.update(schema.messages).set({ status: "failed", statusAt: new Date() }).where(eq(schema.messages.id, row.id));
    throw err; // Inngest retries the step
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

export async function sendQueued(dedupeKey: string): Promise<SendOutcome | "missing"> {
  const [row] = await db().select().from(schema.messages).where(eq(schema.messages.dedupeKey, dedupeKey));
  if (!row) return "missing";
  if (row.status !== "queued") return "duplicate";
  return sendToUser(row.phone, row.rawText ?? "", { dedupeKey });
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
