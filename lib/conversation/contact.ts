import { eq } from "drizzle-orm";
import { getChannel } from "@/lib/channel";
import { db, schema } from "@/lib/db";
import { meetsMinimumAge } from "@/lib/matching/find";
import { answersToValues, loadAnswers } from "@/lib/profile";
import { getSetting, msg } from "@/lib/settings";

export type ContactStep = "number" | "whatsapp" | "photo" | null;

type StepFields = { profileComplete: boolean; contactPhone: string | null; contactHasWhatsapp: boolean | null; photoStepDone: boolean };

/**
 * The last onboarding steps, after every profile question: the contact number, whether it has WhatsApp,
 * then photos and whether a proposal may see them. Derived from the user row, so there is no extra state to drift.
 */
export function pendingContactStep(u: StepFields | undefined): ContactStep {
  if (!u?.profileComplete) return null;
  if (!u.contactPhone) return "number";
  if (u.contactHasWhatsapp == null) return "whatsapp";
  return u.photoStepDone ? null : "photo";
}

/** +8801712345678 → 01712345678, the way people write their own number. */
export const localPhone = (e164: string) => (e164.startsWith("+880") ? e164.slice(3) : e164);

/** The question for a pending step. The number question goes out with the channel's share button. */
export async function contactQuestion(step: Exclude<ContactStep, null>, contactPhone: string | null) {
  if (step === "number") return msg("phone_request");
  if (step === "photo") return msg("photo_step_request");
  return msg("whatsapp_question", { phone: localPhone(contactPhone ?? "") });
}

/** Notes that belong to the end of onboarding: the 24-hour rule hint and the legal marriage age. */
export async function completionNotes(phone: string): Promise<string[]> {
  const notes: string[] = [];
  if (getChannel().enforcesServiceWindow) notes.push(await msg("check_in_hint"));
  const [user] = await db().select().from(schema.users).where(eq(schema.users.phone, phone));
  const answers = answersToValues(await loadAnswers(phone));
  if (!meetsMinimumAge(user?.gender ?? null, answers, await getSetting("min_match_age"))) notes.push(await msg("below_legal_age"));
  return notes;
}
