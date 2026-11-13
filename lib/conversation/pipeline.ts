import { and, eq } from "drizzle-orm";
import { getEmbedder, getTranscriber } from "@/lib/ai";
import { getChannel, MediaTooLargeError } from "@/lib/channel";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getNextQuestion } from "@/lib/profile";
import { endUnderage, eraseUser, isRateLimited, isStopCommand, parseAgeGate, parseYesNo, scrubMessages, sendStopConfirmation } from "@/lib/safety";
import { getSetting, msg } from "@/lib/settings";
import { getStorage } from "@/lib/storage";
import { normalizeWalletNumber, toAsciiDigits } from "@/lib/text";
import { sendToUser } from "./outbound";

const { users, messages } = schema;

export type NextAction = "agent" | "voice" | "image" | "done";

export async function markProcessed(messageId: string) {
  await db().update(messages).set({ processedAt: new Date() }).where(eq(messages.id, messageId));
}

export const messageText = (m: { rawText: string | null; transcript: string | null }) => m.transcript ?? m.rawText ?? "";

/** Deterministic gate before any AI work: STOP, blocks, rate limits, 18+ check and consent. */
export async function preflight(messageId: string): Promise<NextAction> {
  const d = db();
  const [m] = await d.select().from(messages).where(eq(messages.id, messageId));
  if (!m || m.processedAt) return "done";
  const [user] = await d.select().from(users).where(eq(users.phone, m.phone));
  if (!user) return "done";
  const phone = m.phone;
  const text = m.type === "text" ? (m.rawText ?? "") : "";
  const gateKey = `gate-${messageId}`;
  const done = async (): Promise<NextAction> => { await markProcessed(messageId); return "done"; };

  if (text && isStopCommand(text)) {
    await eraseUser(phone);
    await sendStopConfirmation(phone);
    return "done"; // the message row itself is gone
  }
  if (user.status === "ended_underage") {
    await d.delete(messages).where(eq(messages.phone, phone));
    return "done";
  }
  if (user.blocked) return done();
  // Left unprocessed on purpose: resuming the bot answers it. Pre-consent text is scrubbed when that happens.
  if (await getSetting<boolean>("bot_paused")) return "done";

  if (text === "__STOP_INFO__") {
    await sendToUser(phone, await msg("stop_info"), { dedupeKey: gateKey, deferOnFailure: true });
    return done();
  }

  // A person from the Page inbox has this conversation. When their time is up, BS says it is back (disclosure rule).
  if (user.humanUntil) {
    if (user.humanUntil.getTime() > Date.now()) return done();
    await d.update(users).set({ humanUntil: null }).where(eq(users.phone, phone));
    await sendToUser(phone, await msg("bot_resumed"), { dedupeKey: `botback-${messageId}`, deferOnFailure: true });
  }

  if (await isRateLimited(phone)) {
    const bucket = Math.floor(Date.now() / 60_000);
    await sendToUser(phone, await msg("rate_limited"), { dedupeKey: `ratelimit-${phone}-${bucket}` });
    return done();
  }

  if (user.status !== "active") {
    // Nothing the user sends is kept until they have agreed to the privacy terms.
    if (!user.consentAt) await scrubMessages(phone);
    if (user.status === "new" || user.status === "consent_declined") {
      await d.update(users).set({ status: "awaiting_age" }).where(eq(users.phone, phone));
      await sendToUser(phone, await msg("welcome_age_gate"), { dedupeKey: gateKey, deferOnFailure: true });
      return done();
    }
    if (user.status === "awaiting_phone") return contactPhoneStep(m, gateKey, done);
    if (!text) {
      await sendToUser(phone, await msg("voice_before_consent"), { dedupeKey: gateKey, deferOnFailure: true });
      return done();
    }
    if (user.status === "awaiting_age") {
      const verdict = parseAgeGate(text, await getSetting<number>("min_age_gate"));
      if (verdict === "minor") {
        const goodbye = await msg("underage_end");
        await endUnderage(phone);
        await getChannel().sendText(phone, goodbye); // deliberately not logged: the conversation has been removed
        return "done";
      }
      if (verdict === "unclear") {
        await sendToUser(phone, await msg("age_gate_retry"), { dedupeKey: gateKey, deferOnFailure: true });
        return done();
      }
      await d.update(users).set({ status: "awaiting_consent", ageConfirmedAt: new Date() }).where(eq(users.phone, phone));
      await sendToUser(phone, await msg("consent_request"), { dedupeKey: gateKey, deferOnFailure: true });
      return done();
    }
    if (user.status === "awaiting_consent") {
      const answer = parseYesNo(text);
      if (answer === "unclear") {
        await sendToUser(phone, await msg("consent_retry"), { dedupeKey: gateKey, deferOnFailure: true });
        return done();
      }
      if (answer === "no") {
        await d.update(users).set({ status: "consent_declined" }).where(eq(users.phone, phone));
        await sendToUser(phone, await msg("consent_declined"), { dedupeKey: gateKey, deferOnFailure: true });
        return done();
      }
      if (!user.contactPhone) {
        // Messenger never tells us a number, and the number is what a paid match receives.
        await d.update(users).set({ status: "awaiting_phone", consentAt: new Date() }).where(eq(users.phone, phone));
        await sendToUser(phone, await msg("phone_request"), { dedupeKey: gateKey, deferOnFailure: true, requestPhone: true });
        return done();
      }
      await d.update(users).set({ status: "active", consentAt: new Date() }).where(eq(users.phone, phone));
      const next = await getNextQuestion(phone);
      await sendToUser(phone, await msg("consent_accepted", { question: next?.bengaliText ?? "" }), { dedupeKey: gateKey, deferOnFailure: true });
      return done();
    }
    return done();
  }

  if (m.type === "voice") return "voice";
  if (m.type === "image") return "image";
  if (m.type === "text" && text.trim()) return "agent";
  await sendToUser(phone, await msg("unsupported_type"), { dedupeKey: gateKey, deferOnFailure: true });
  return done();
}

const extFor = (mime: string) => (mime.includes("jpeg") ? "jpg" : mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("mpeg") ? "mp3" : "ogg");

/** Downloads from the channel and stores privately. Returns false when the file was refused. */
export async function storeMedia(messageId: string, folder: "voice" | "photos"): Promise<boolean> {
  const d = db();
  const [m] = await d.select().from(messages).where(eq(messages.id, messageId));
  if (!m?.mediaId) return false;
  if (m.mediaKey) return true;
  try {
    const file = await getChannel().downloadMedia(m.mediaId, await getSetting<number>("max_media_bytes"));
    const key = `${folder}/${m.phone.replace(/\D/g, "")}/${m.id}.${extFor(file.mime)}`;
    await getStorage().put(key, file.bytes, file.mime);
    await d.update(messages).set({ mediaKey: key, mediaMime: file.mime }).where(eq(messages.id, messageId));
    return true;
  } catch (err) {
    if (!(err instanceof MediaTooLargeError)) throw err;
    await sendToUser(m.phone, await msg("file_too_large"), { dedupeKey: `toolarge-${messageId}` });
    await markProcessed(messageId);
    return false;
  }
}

/** Returns true when there is usable text to continue with. */
export async function transcribeMessage(messageId: string): Promise<boolean> {
  const d = db();
  const [m] = await d.select().from(messages).where(eq(messages.id, messageId));
  if (!m?.mediaKey) return false;
  if (m.transcript) return true;
  const file = await getStorage().get(m.mediaKey);
  const result = await getTranscriber().transcribe(file.bytes, file.mime);
  logger.info({ messageId, groqSeconds: result.seconds }, "voice note transcribed");
  const minChars = await getSetting<number>("min_transcript_chars");
  const usable = result.text.trim().length >= minChars;
  await d.update(messages).set({ transcript: usable ? result.text.trim() : null, usageSeconds: result.seconds }).where(eq(messages.id, messageId));
  return usable;
}

export async function askToRetype(messageId: string) {
  const [m] = await db().select().from(messages).where(eq(messages.id, messageId));
  if (!m) return;
  await sendToUser(m.phone, await msg("voice_unclear"), { dedupeKey: `voiceretry-${messageId}` });
  await markProcessed(messageId);
}

export async function handleImage(messageId: string) {
  const d = db();
  const [m] = await d.select().from(messages).where(eq(messages.id, messageId));
  if (!m?.mediaKey) return;
  const [existing] = await d.select().from(schema.photos).where(and(eq(schema.photos.messageId, messageId)));
  if (!existing) await d.insert(schema.photos).values({ phone: m.phone, r2Key: m.mediaKey, messageId });
  await sendToUser(m.phone, await msg("photo_received"), { dedupeKey: `photoack-${messageId}` });
  await markProcessed(messageId);
}

export async function embedMessage(messageId: string) {
  const d = db();
  const [m] = await d.select().from(messages).where(eq(messages.id, messageId));
  if (!m) return false;
  const text = messageText(m);
  if (!text.trim()) return false;
  const embedding = await getEmbedder().embed(text, "passage");
  await d.insert(schema.messageEmbeddings).values({ messageId, phone: m.phone, embedding }).onConflictDoNothing();
  return true;
}

/** Accepts a typed Bangladeshi or international number. Returns E.164 or null. */
export function parseTypedPhone(text: string): string | null {
  const bd = normalizeWalletNumber(text);
  if (bd) return `+88${bd}`;
  const compact = toAsciiDigits(text).replace(/[\s-]/g, "");
  return /^\+\d{8,15}$/.test(compact) ? compact : null;
}

/**
 * The contact number step. A number shared through the channel's own control is taken as verified; a typed
 * one could be anyone's, so it waits for an admin check before the person can be matched or released.
 */
async function contactPhoneStep(m: typeof messages.$inferSelect, gateKey: string, done: () => Promise<NextAction>): Promise<NextAction> {
  const d = db();
  const phone = m.phone;
  const shared = m.sharedPhone;
  const typed = shared ? null : parseTypedPhone(m.rawText ?? "");
  if (!shared && !typed) {
    await sendToUser(phone, await msg("phone_retry"), { dedupeKey: gateKey, deferOnFailure: true, requestPhone: true });
    return done();
  }
  const contactPhone = (shared ?? typed)!;
  await d.update(users).set({
    status: "active", contactPhone, contactPhoneVerified: !!shared, contactPhoneSource: shared ? "messenger_profile" : "typed", updatedAt: new Date(),
  }).where(eq(users.phone, phone));
  if (!shared) {
    await d.insert(schema.escalations).values({ phone, kind: "verify_phone", reason: `যোগাযোগ নম্বর যাচাই করুন (ফোন করে নিশ্চিত হন): ${contactPhone}` });
  }
  const next = await getNextQuestion(phone);
  await sendToUser(phone, await msg(shared ? "phone_saved_verified" : "phone_saved_unverified", { question: next?.bengaliText ?? "" }), {
    dedupeKey: gateKey, deferOnFailure: true,
  });
  return done();
}
