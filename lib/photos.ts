import { and, desc, eq, isNull } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { sendToUser } from "@/lib/conversation/outbound";
import { db, schema } from "@/lib/db";
import { cardFields, getMatch, isClosed, isVisibleTo, otherParty } from "@/lib/matches";
import { msg } from "@/lib/settings";
import { getStorage } from "@/lib/storage";

const { photos, photoRequests } = schema;

/** Deterministic check: the LLM alone cannot release a photo, the user must have said yes in this message. */
export function isExplicitYes(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/(^|[\s,।])(না|নাহ|নয়|no|don'?t)([\s,।.!]|$)/.test(t)) return false;
  return /(হ্যাঁ|হ্যা|জি|জ্বি|অনুমতি দিলাম|পাঠান|পাঠিয়ে দিন|রাজি|ঠিক আছে|\byes\b|\bok\b|\bokay\b)/.test(t);
}

export const approvedPhoto = async (phone: string) => {
  const [p] = await db().select().from(photos)
    .where(and(eq(photos.phone, phone), eq(photos.approvedByAdmin, true)))
    .orderBy(desc(photos.createdAt)).limit(1);
  return p;
};

export async function confirmProfilePhoto(phone: string, isMine: boolean) {
  const d = db();
  const [photo] = await d.select().from(photos)
    .where(and(eq(photos.phone, phone), isNull(photos.ownerConfirmedAt)))
    .orderBy(desc(photos.createdAt)).limit(1);
  if (!photo) return { ok: false as const, error: "no photo awaiting confirmation" };
  if (isMine) {
    await d.update(photos).set({ ownerConfirmedAt: new Date() }).where(eq(photos.id, photo.id));
    return { ok: true as const, note: "Saved. The photo goes to admin review before it can be shared." };
  }
  await getStorage().delete(photo.r2Key);
  await d.delete(photos).where(eq(photos.id, photo.id));
  return { ok: true as const, note: "Photo discarded." };
}

export async function requestPhoto(requester: string, matchId: string) {
  const d = db();
  const match = await getMatch(matchId);
  if (!match || !isVisibleTo(match, requester)) return { ok: false as const, error: "match not found" };
  if (isClosed(match.state) && match.state !== "contact_released") return { ok: false as const, error: "match is closed" };

  const owner = otherParty(match, requester);
  const photo = await approvedPhoto(owner);
  const [row] = await d.insert(photoRequests)
    .values({ matchId, requester, owner, status: photo ? "pending" : "no_photo", respondedAt: photo ? null : new Date() })
    .onConflictDoNothing().returning();
  if (!row) return { ok: true as const, note: "A photo request for this match was already made." };
  await audit(requester === match.userA ? "user_a" : "user_b", "photo.requested", "match", matchId);
  if (!photo) return { ok: true as const, note: await msg("photo_none") };

  const fields = await cardFields(requester);
  await sendToUser(owner, await msg("photo_request_to_owner", { age: fields.age, district: fields.district }), {
    dedupeKey: `photoreq-${row.id}`, template: "match_update",
  });
  return { ok: true as const, note: await msg("photo_request_sent") };
}

export async function respondToPhotoRequest(owner: string, requestId: string, allow: boolean, userText: string) {
  const d = db();
  const [req] = await d.select().from(photoRequests).where(and(eq(photoRequests.id, requestId), eq(photoRequests.owner, owner)));
  if (!req) return { ok: false as const, error: "request not found" };
  if (req.status !== "pending") return { ok: true as const, note: `Already answered: ${req.status}` };
  if (allow && !isExplicitYes(userText)) return { ok: false as const, error: "explicit yes is required: ask the owner to answer yes or no" };

  const match = await getMatch(req.matchId);
  if (!match || (isClosed(match.state) && match.state !== "contact_released")) return { ok: false as const, error: "match is closed" };

  if (!allow) {
    await d.update(photoRequests).set({ status: "denied", respondedAt: new Date() }).where(eq(photoRequests.id, req.id));
    await sendToUser(req.requester, await msg("photo_denied"), { dedupeKey: `photodeny-${req.id}`, template: "match_update" });
    await audit("agent", "photo.denied", "photo_request", req.id);
    return { ok: true as const, note: "Recorded; the other party was told politely." };
  }
  const photo = await approvedPhoto(owner);
  if (!photo) {
    await d.update(photoRequests).set({ status: "no_photo", respondedAt: new Date() }).where(eq(photoRequests.id, req.id));
    return { ok: false as const, error: "owner has no approved photo" };
  }
  const file = await getStorage().get(photo.r2Key);
  await sendToUser(req.requester, await msg("photo_caption"), { image: file, mediaKey: photo.r2Key, dedupeKey: `photo-${req.id}` });
  await d.update(photoRequests).set({ status: "approved", respondedAt: new Date() }).where(eq(photoRequests.id, req.id));
  await audit("agent", "photo.shared", "photo_request", req.id);
  return { ok: true as const, note: "Photo sent to the other party." };
}
