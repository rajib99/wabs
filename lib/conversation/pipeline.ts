import { and, eq } from "drizzle-orm";
import { inngest } from "@/inngest/client";
import { getDocumentReader, getEmbedder, getTranscriber } from "@/lib/ai";
import { getChannel, MediaTooLargeError } from "@/lib/channel";
import { isConfigError } from "@/lib/env";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { endUnderage, eraseUser, isRateLimited, isStopCommand, parseAgeGate, parseYesNo, scrubMessages, sendStopConfirmation } from "@/lib/safety";
import { getSetting, msg } from "@/lib/settings";
import { isExplicitYes } from "@/lib/photos";
import { optimizeImage } from "@/lib/image";
import { getStorage } from "@/lib/storage";
import { normalizeWalletNumber, toAsciiDigits } from "@/lib/text";
import { completionNotes, contactQuestion, pendingContactStep } from "./contact";
import { interpretGateReply } from "./interpret";
import { askForNotifications } from "./notify";
import { sendToUser } from "./outbound";

const { users, messages } = schema;

export type NextAction = "agent" | "voice" | "image" | "document" | "done";

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
    if (!text) {
      await sendToUser(phone, await msg("voice_before_consent"), { dedupeKey: gateKey, deferOnFailure: true });
      return done();
    }
    if (user.status === "awaiting_age") {
      let verdict = parseAgeGate(text, await getSetting<number>("min_age_gate"));
      if (verdict === "unclear") {
        const read = await interpretGateReply("age", await msg("welcome_age_gate"), text);
        verdict = read === "yes" ? "adult" : read === "no" ? "minor" : "unclear";
      }
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
      let answer = parseYesNo(text);
      if (answer === "unclear") answer = await interpretGateReply("consent", await msg("consent_request"), text);
      if (answer === "unclear") {
        await sendToUser(phone, await msg("consent_retry"), { dedupeKey: gateKey, deferOnFailure: true });
        return done();
      }
      if (answer === "no") {
        await d.update(users).set({ status: "consent_declined" }).where(eq(users.phone, phone));
        await sendToUser(phone, await msg("consent_declined"), { dedupeKey: gateKey, deferOnFailure: true });
        return done();
      }
      // The first question: is there a ready-made biodata? The contact number comes last, after the profile.
      await d.update(users).set({ status: "active", consentAt: new Date() }).where(eq(users.phone, phone));
      await sendToUser(phone, await msg("biodata_offer"), { dedupeKey: gateKey, deferOnFailure: true });
      return done();
    }
    return done();
  }

  const contactStep = pendingContactStep(user);
  if (contactStep) {
    const handled = await contactStepReply(m, user, contactStep, gateKey);
    if (handled) return done();
  }

  if (m.type === "voice") return "voice";
  if (m.type === "image") return "image";
  if (m.type === "document") return "document";
  if (m.type === "text" && text.trim()) return "agent";
  await sendToUser(phone, await msg("unsupported_type"), { dedupeKey: gateKey, deferOnFailure: true });
  return done();
}

const extFor = (mime: string) =>
  mime.includes("pdf") ? "pdf" : mime.includes("jpeg") ? "jpg" : mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("mpeg") ? "mp3"
  : mime.startsWith("audio/") ? "ogg" : "bin";

/** Downloads from the channel and stores privately. Returns false when the file was refused. */
export async function storeMedia(messageId: string, folder: "voice" | "photos" | "documents"): Promise<boolean> {
  const d = db();
  const [m] = await d.select().from(messages).where(eq(messages.id, messageId));
  if (!m?.mediaId) return false;
  if (m.mediaKey) return true;
  let stage = "download";
  try {
    const downloaded = await getChannel().downloadMedia(m.mediaId, await getSetting<number>("max_media_bytes"));
    stage = "optimize";
    // Photos are shrunk to the size limit and stripped of metadata (GPS) before anything keeps or sends them.
    const file = folder === "photos" ? await optimizeImage(downloaded, await getSetting<number>("max_photo_bytes")) : downloaded;
    stage = "store";
    const key = `${folder}/${m.phone.replace(/\D/g, "")}/${m.id}.${extFor(file.mime)}`;
    await getStorage().put(key, file.bytes, file.mime);
    await d.update(messages).set({ mediaKey: key, mediaMime: file.mime }).where(eq(messages.id, messageId));
    return true;
  } catch (err) {
    if (!(err instanceof MediaTooLargeError)) {
      // The cause must be visible: without it a failed photo only shows as a late "try again" to the user.
      logger.error({ err, messageId, stage, folder }, "media could not be stored");
      throw err;
    }
    await sendToUser(m.phone, await msg("file_too_large"), { dedupeKey: `toolarge-${messageId}` });
    await markProcessed(messageId);
    return false;
  }
}

/** Errors that a retry cannot fix: missing settings, or a download the channel refused. Retrying them only delays the reply. */
export const isPermanentMediaError = (err: unknown) => isConfigError(err) || (err instanceof Error && err.name === "PermanentMediaError");

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
  // At the photo step we have just asked for their photos, so a picture sent now is one, and shareable at once.
  const [user] = await d.select().from(users).where(eq(users.phone, m.phone));
  const atPhotoStep = pendingContactStep(user) === "photo";
  const [existing] = await d.select().from(schema.photos).where(and(eq(schema.photos.messageId, messageId)));
  if (!existing) await d.insert(schema.photos).values({ phone: m.phone, r2Key: m.mediaKey, messageId, ownerConfirmedAt: atPhotoStep ? new Date() : null });
  await sendToUser(m.phone, await msg(atPhotoStep ? "photo_step_received" : "photo_received"), { dedupeKey: `photoack-${messageId}` });
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

/** Marks the start of text read from a biodata file, for the agent and the history. */
export const BIODATA_PREFIX = "[বায়োডাটা]";

/**
 * Reads an image or file the user sent. A biodata becomes this message's text (like a voice transcript)
 * and goes to the agent; a photo goes to the profile photo flow. Returns only the kind, never the text.
 */
export async function readDocument(messageId: string): Promise<"biodata" | "photo" | "unreadable"> {
  const d = db();
  const [m] = await d.select().from(messages).where(eq(messages.id, messageId));
  if (!m?.mediaKey) return "unreadable";
  if (m.transcript?.startsWith(BIODATA_PREFIX)) return "biodata"; // a retried step
  let reading: Awaited<ReturnType<ReturnType<typeof getDocumentReader>["read"]>>;
  try {
    reading = await getDocumentReader().read(await getStorage().get(m.mediaKey));
  } catch (err) {
    logger.error({ err, messageId }, "document reader failed; treating the file as a photo or unreadable");
    throw err;
  }
  if (reading.kind === "biodata") {
    const caption = m.rawText?.trim() ? `${m.rawText.trim()}\n` : "";
    await d.update(messages).set({ transcript: `${BIODATA_PREFIX}\n${caption}${reading.text}` }).where(eq(messages.id, messageId));
    return "biodata";
  }
  // Any other picture keeps the old behaviour: ask whether it is the profile photo.
  return m.type === "image" || reading.kind === "photo" ? "photo" : "unreadable";
}

export async function documentUnreadable(messageId: string) {
  const [m] = await db().select().from(messages).where(eq(messages.id, messageId));
  if (!m) return;
  await sendToUser(m.phone, await msg("document_unreadable"), { dedupeKey: `docunread-${messageId}` });
  await markProcessed(messageId);
}

/** Accepts a typed Bangladeshi or international number, alone or inside a sentence. Returns E.164 or null. */
export function parseTypedPhone(text: string): string | null {
  const bd = normalizeWalletNumber(text);
  if (bd) return `+88${bd}`;
  const ascii = toAsciiDigits(text);
  const inside = ascii.match(/(?:\+?88[\s-]*)?0[\s-]*1[3-9](?:[\s-]*\d){8}/)?.[0];
  if (inside) return parseTypedPhone(inside.replace(/[\s-]/g, ""));
  const compact = ascii.replace(/[\s-]/g, "");
  return /^\+\d{8,15}$/.test(compact) ? compact : null;
}

const hasManyDigits = (text: string) => (toAsciiDigits(text).match(/\d/g) ?? []).length >= 6;

/**
 * The last onboarding steps, after every profile question: the contact number, whether it has WhatsApp, then
 * photos and whether a proposal may see them without being asked each time. A number shared through the channel's own control is taken as verified; a typed one could be anyone's, so it
 * waits for an admin check before the person can be matched or released. Returns false when the message is
 * something else (a question, say): the agent answers it and reminds them.
 */
async function contactStepReply(
  m: typeof messages.$inferSelect, user: typeof users.$inferSelect, step: "number" | "whatsapp" | "photo", gateKey: string,
): Promise<boolean> {
  const d = db();
  const phone = m.phone;
  if (m.type !== "text") return false; // a photo, a biodata or a voice note takes its usual path
  const text = m.rawText ?? "";

  if (step === "number") {
    const shared = m.sharedPhone;
    const typed = shared ? null : parseTypedPhone(text);
    if (!shared && !typed) {
      if (!hasManyDigits(text)) return false;
      await sendToUser(phone, await msg("phone_retry"), { dedupeKey: gateKey, deferOnFailure: true, requestPhone: true });
      return true;
    }
    const contactPhone = (shared ?? typed)!;
    await d.update(users).set({
      contactPhone, contactPhoneVerified: !!shared, contactPhoneSource: shared ? "messenger_profile" : "typed", contactHasWhatsapp: null, updatedAt: new Date(),
    }).where(eq(users.phone, phone));
    if (!shared) {
      await d.insert(schema.escalations).values({ phone, kind: "verify_phone", reason: `যোগাযোগ নম্বর যাচাই করুন (ফোন করে নিশ্চিত হন): ${contactPhone}` });
    }
    await sendToUser(phone, await contactQuestion("whatsapp", contactPhone), { dedupeKey: gateKey, deferOnFailure: true });
    return true;
  }

  if (step === "photo") return photoStepReply(m, user, gateKey);

  let answer = parseYesNo(text);
  if (answer === "unclear" && !text.includes("?")) {
    answer = await interpretGateReply("whatsapp", await contactQuestion("whatsapp", user.contactPhone), text);
  }
  if (answer === "unclear") {
    if (text.trim().split(/\s+/).length > 3) return false; // a sentence: let the agent answer and ask again
    await sendToUser(phone, await msg("whatsapp_retry"), { dedupeKey: gateKey, deferOnFailure: true });
    return true;
  }
  await d.update(users).set({ contactHasWhatsapp: answer === "yes", updatedAt: new Date() }).where(eq(users.phone, phone));
  await sendToUser(phone, await contactQuestion("photo", null), { dedupeKey: gateKey, deferOnFailure: true });
  // Matching skipped this person while the number was missing; start it now. Photos are not needed for it.
  if (user.contactPhoneVerified) await inngest.send({ id: `contact-${m.id}`, name: "profile/updated", data: { phone } });
  return true;
}

/**
 * The photo step: may a proposal that asks see their photo without asking them each time? A yes must be explicit
 * (as for any photo release); no LLM reading counts. "No" keeps the per-request question. Photos themselves arrive
 * as images and are handled by handleImage.
 */
async function photoStepReply(m: typeof messages.$inferSelect, user: typeof users.$inferSelect, gateKey: string): Promise<boolean> {
  const phone = m.phone;
  const text = m.rawText ?? "";
  const yesNo = parseYesNo(text);
  const answer = yesNo === "no" ? "no" : yesNo === "yes" || isExplicitYes(text) ? "yes" : "unclear";
  if (answer === "unclear") {
    if (text.trim().split(/\s+/).length > 3 || text.includes("?")) return false; // a sentence or a question: the agent answers and asks again
    await sendToUser(phone, await msg("photo_step_retry"), { dedupeKey: gateKey, deferOnFailure: true });
    return true;
  }
  await db().update(users).set({ photoStepDone: true, photoShareConsent: answer === "yes", updatedAt: new Date() }).where(eq(users.phone, phone));
  const done = await msg(user.contactPhoneVerified ? "contact_done" : "contact_done_unverified");
  await sendToUser(phone, [done, ...(await completionNotes(phone))].join("\n\n"), { dedupeKey: gateKey, deferOnFailure: true });
  await askForNotifications(phone); // onboarding is done: the natural moment to ask about new-proposal alerts
  return true;
}
