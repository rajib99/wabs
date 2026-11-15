"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn, signOut } from "@/auth";
import { requireRole } from "@/lib/admin-auth";
import { inngest } from "@/inngest/client";
import { audit } from "@/lib/audit";
import { attempt, type ActionResult } from "@/lib/action-result";
import { applyMessengerProfile } from "@/lib/channel/messenger";
import { env } from "@/lib/env";
import { connectSession, disconnectSession } from "@/lib/channel/openwa-session";
import { resumeHeldMessages } from "@/lib/conversation/ingest";
import { db, schema } from "@/lib/db";
import { rejectPayment, verifyPayment } from "@/lib/payments";
import { eraseUser } from "@/lib/safety";
import { getSetting, setSetting } from "@/lib/settings";
import { DEFAULT_MESSAGES } from "@/lib/settings-defaults";
import { getStorage } from "@/lib/storage";
import { toAsciiDigits } from "@/lib/text";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => {
  const n = Number(f.get(k));
  if (!Number.isFinite(n)) throw new Error(`${k}: একটি সংখ্যা দিন`);
  return n;
};

export async function loginAction(_prev: string | null, form: FormData): Promise<string | null> {
  try {
    await signIn("credentials", { email: str(form, "email"), password: String(form.get("password") ?? ""), redirectTo: "/admin" });
    return null;
  } catch (err) {
    if (err instanceof AuthError) return "ইমেইল বা পাসওয়ার্ড ঠিক নেই।";
    throw err; // includes the redirect Next.js uses on success
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: "/admin/login" });
}

// ---- Payments (owner, verifier) ----
export async function verifyPaymentAction(form: FormData): Promise<ActionResult> {
  return attempt("পেমেন্ট যাচাই করা হয়েছে", async () => {
    const { email } = await requireRole("owner", "verifier");
    await verifyPayment(z.string().uuid().parse(str(form, "id")), email);
    revalidatePath("/admin/payments");
  });
}

export async function rejectPaymentAction(form: FormData): Promise<ActionResult> {
  return attempt("পেমেন্ট বাতিল করা হয়েছে", async () => {
    const { email } = await requireRole("owner", "verifier");
    const reason = str(form, "note") || "তথ্য মেলেনি";
    await rejectPayment(z.string().uuid().parse(str(form, "id")), email, reason);
    revalidatePath("/admin/payments");
  });
}

// ---- Photos (owner, verifier) ----
export async function reviewPhotoAction(form: FormData): Promise<ActionResult> {
  return attempt("ছবির সিদ্ধান্ত সংরক্ষিত হয়েছে", async () => {
    const { email } = await requireRole("owner", "verifier");
    const id = z.string().uuid().parse(str(form, "id"));
    // Rejecting deletes the file, so an unexpected value must fail rather than fall through to reject.
    const approve = z.enum(["approve", "reject"]).parse(str(form, "decision")) === "approve";
    const [row] = await db().update(schema.photos)
      .set({ approvedByAdmin: approve, reviewedBy: email, reviewedAt: new Date() })
      .where(eq(schema.photos.id, id)).returning();
    if (row) {
      if (!approve) await getStorage().delete(row.r2Key);
      await audit(email, approve ? "photo.approved" : "photo.rejected", "photo", id);
    }
    revalidatePath("/admin/photos");
    revalidatePath("/admin/users/[phone]", "page");
  });
}

// ---- Inbox (owner, verifier) ----
export async function resolveEscalationAction(form: FormData): Promise<ActionResult> {
  return attempt("সমাধান হিসেবে চিহ্নিত হয়েছে", async () => {
    const { email } = await requireRole("owner", "verifier");
    const id = z.string().uuid().parse(str(form, "id"));
    await db().update(schema.escalations).set({ status: "resolved", resolvedBy: email, resolvedAt: new Date() }).where(eq(schema.escalations.id, id));
    await audit(email, "escalation.resolved", "escalation", id);
    revalidatePath("/admin/inbox");
  });
}

// ---- Users (owner) ----
export async function setBlockedAction(form: FormData): Promise<ActionResult> {
  return attempt("ব্লক অবস্থা পরিবর্তন হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const phone = str(form, "phone");
    const blocked = str(form, "blocked") === "true";
    await db().update(schema.users).set({ blocked, updatedAt: new Date() }).where(eq(schema.users.phone, phone));
    await audit(email, blocked ? "user.blocked" : "user.unblocked", "user", phone);
    revalidatePath(`/admin/users/${encodeURIComponent(phone)}`);
  });
}

export async function eraseUserAction(form: FormData): Promise<ActionResult> {
  return attempt("ব্যবহারকারী মুছে ফেলা হয়েছে", async () => {
    const { email } = await requireRole("owner");
    if (str(form, "confirm") !== "ERASE") throw new Error('নিশ্চিত করতে ঘরে ERASE লিখুন');
    await eraseUser(str(form, "phone"), email);
    revalidatePath("/admin/users"); // the form sends the admin back to the list
  });
}

// ---- WhatsApp connection (owner) ----
export async function connectWhatsAppAction(): Promise<ActionResult> {
  return attempt("সংযোগ শুরু হয়েছে", async () => {
    const { email } = await requireRole("owner");
    await connectSession();
    await audit(email, "whatsapp.connect");
    revalidatePath("/admin/channel");
  });
}

export async function disconnectWhatsAppAction(form: FormData): Promise<ActionResult> {
  return attempt("আনলিংক করা হয়েছে", async () => {
    const { email } = await requireRole("owner");
    if (str(form, "confirm") !== "UNLINK") throw new Error('নিশ্চিত করতে ঘরে UNLINK লিখুন');
    await disconnectSession();
    await audit(email, "whatsapp.disconnect");
    revalidatePath("/admin/channel");
  });
}

export async function saveAllowlistAction(form: FormData): Promise<ActionResult> {
  return attempt("অনুমোদিত তালিকা সংরক্ষিত হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const phones = [...new Set(str(form, "allowlist").split(/[\s,]+/).filter(Boolean).map((p) => {
      const digits = toAsciiDigits(p).replace(/\D/g, "");
      const phone = `+${digits.startsWith("01") ? `88${digits}` : digits}`;
      if (!/^\+\d{8,15}$/.test(phone)) throw new Error(`সঠিক ফোন নম্বর নয়: ${p}`);
      return phone;
    }))];
    const enabled = form.get("enabled") === "on";
    await setSetting("live_allowlist", phones);
    await setSetting("live_allowlist_enabled", enabled);
    await audit(email, "whatsapp.allowlist_updated", "settings", "live_allowlist", { count: phones.length, enabled });
    revalidatePath("/admin/channel");
  });
}

export async function setBotPausedAction(form: FormData): Promise<ActionResult> {
  return attempt("BS-এর অবস্থা পরিবর্তন হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const paused = z.enum(["true", "false"]).parse(str(form, "paused")) === "true";
    await setSetting("bot_paused", paused);
    await audit(email, paused ? "bot.paused" : "bot.resumed");
    if (!paused) await resumeHeldMessages();
    revalidatePath("/admin/channel");
  });
}

// ---- Messenger (owner) ----
export async function applyMessengerSetupAction(): Promise<ActionResult> {
  return attempt("Messenger সেটআপ প্রয়োগ হয়েছে", async () => {
    const { email } = await requireRole("owner");
    await applyMessengerProfile(env.publicUrl());
    await audit(email, "messenger.profile_applied");
    revalidatePath("/admin/channel");
  });
}

export async function saveTakeoverHoursAction(form: FormData): Promise<ActionResult> {
  return attempt("সংরক্ষিত হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const hours = z.number().min(1).max(168).parse(num(form, "human_takeover_hours"));
    await setSetting("human_takeover_hours", hours);
    await audit(email, "settings.takeover_updated", "settings", "human_takeover_hours", { hours });
    revalidatePath("/admin/channel");
  });
}

// ---- Contact numbers and takeover (owner; verifier for the inbox check) ----
/** After phoning the number. Matching starts for this person from here. */
export async function verifyContactPhoneAction(form: FormData): Promise<ActionResult> {
  return attempt("নম্বর যাচাই হয়েছে", async () => {
    const { email } = await requireRole("owner", "verifier");
    const id = z.string().uuid().parse(str(form, "id"));
    const [esc] = await db().select().from(schema.escalations).where(eq(schema.escalations.id, id));
    if (!esc || esc.kind !== "verify_phone") throw new Error("not a phone verification item");
    await db().update(schema.users).set({ contactPhoneVerified: true, updatedAt: new Date() }).where(eq(schema.users.phone, esc.phone));
    await db().update(schema.escalations).set({ status: "resolved", resolvedBy: email, resolvedAt: new Date() }).where(eq(schema.escalations.id, id));
    await audit(email, "contact_phone.verified", "user", esc.phone);
    await inngest.send({ name: "profile/updated", data: { phone: esc.phone } });
    revalidatePath("/admin/inbox");
  });
}

export async function setContactVerifiedAction(form: FormData): Promise<ActionResult> {
  return attempt("নম্বরের যাচাই অবস্থা পরিবর্তন হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const phone = str(form, "phone");
    const verified = z.enum(["true", "false"]).parse(str(form, "verified")) === "true";
    await db().update(schema.users).set({ contactPhoneVerified: verified, updatedAt: new Date() }).where(eq(schema.users.phone, phone));
    await audit(email, verified ? "contact_phone.verified" : "contact_phone.unverified", "user", phone);
    if (verified) await inngest.send({ name: "profile/updated", data: { phone } });
    revalidatePath(`/admin/users/${encodeURIComponent(phone)}`);
  });
}

export async function endTakeoverAction(form: FormData): Promise<ActionResult> {
  return attempt("BS আবার দায়িত্বে", async () => {
    const { email } = await requireRole("owner");
    const phone = str(form, "phone");
    // In the past rather than null, so BS announces it is back on the next message.
    await db().update(schema.users).set({ humanUntil: new Date(Date.now() - 1000) }).where(eq(schema.users.phone, phone));
    await audit(email, "conversation.takeover_ended", "user", phone);
    revalidatePath(`/admin/users/${encodeURIComponent(phone)}`);
  });
}

// ---- Question bank (owner) ----
function parseJson(text: string, label: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: JSON সঠিক নয়`);
  }
}

const FIELD_TYPES = ["text", "number", "select", "multiselect", "range", "district", "location_list"] as const;

function questionFields(form: FormData) {
  return {
    bengaliText: z.string().min(1).parse(str(form, "bengali_text")),
    fieldType: z.enum(FIELD_TYPES).parse(str(form, "field_type")),
    options: parseJson(str(form, "options"), "options"),
    askCondition: parseJson(str(form, "ask_condition"), "ask condition"),
    required: form.get("required") === "on",
    active: form.get("active") === "on",
  };
}

export async function createQuestionAction(form: FormData): Promise<ActionResult> {
  return attempt("প্রশ্ন যোগ হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const key = z.string().regex(/^[a-z][a-z0-9_]*$/).parse(str(form, "key"));
    const [{ max }] = (await db().select({ max: sql<number>`coalesce(max("order"), 0)::int` }).from(schema.questions)) as [{ max: number }];
    await db().insert(schema.questions).values({ key, order: max + 10, ...questionFields(form) });
    await audit(email, "question.created", "question", key);
    revalidatePath("/admin/questions");
  });
}

export async function updateQuestionAction(form: FormData): Promise<ActionResult> {
  return attempt("প্রশ্ন সংরক্ষিত হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const key = str(form, "key");
    const fields = questionFields(form);
    await db().update(schema.questions).set(fields).where(eq(schema.questions.key, key));
    await audit(email, "question.updated", "question", key, fields);
    revalidatePath("/admin/questions");
  });
}

export async function deleteQuestionAction(form: FormData): Promise<ActionResult> {
  return attempt("প্রশ্ন মুছে ফেলা হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const key = str(form, "key");
    await db().delete(schema.questions).where(eq(schema.questions.key, key));
    await audit(email, "question.deleted", "question", key);
    revalidatePath("/admin/questions");
  });
}

export async function moveQuestionAction(form: FormData): Promise<ActionResult> {
  return attempt("ক্রম পরিবর্তন হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const key = str(form, "key");
    const direction = z.enum(["up", "down"]).parse(str(form, "direction"));
    const all = await db().select().from(schema.questions).orderBy(schema.questions.order);
    const i = all.findIndex((q) => q.key === key);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= all.length) return;
    const a = all[i]!;
    const b = all[j]!;
    await db().transaction(async (tx) => {
      await tx.update(schema.questions).set({ order: b.order }).where(eq(schema.questions.key, a.key));
      await tx.update(schema.questions).set({ order: a.order }).where(eq(schema.questions.key, b.key));
    });
    await audit(email, "question.reordered", "question", key, { direction });
    revalidatePath("/admin/questions");
  });
}

// ---- Matching settings (owner) ----
export async function saveMatchingSettingsAction(form: FormData): Promise<ActionResult> {
  return attempt("ম্যাচিং সেটিংস সংরক্ষিত হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const weights = await getSetting<{ field: string; weight: number }[]>("match_weights");
    const next = {
      match_threshold: z.number().min(0).max(100).parse(num(form, "match_threshold")),
      daily_intro_limit: z.number().int().min(0).max(100).parse(num(form, "daily_intro_limit")),
      match_response_timeout_seconds: Math.round(z.number().positive().parse(num(form, "match_response_hours")) * 3600),
      first_payment_timeout_seconds: Math.round(z.number().positive().parse(num(form, "first_payment_hours")) * 3600),
      second_payment_timeout_seconds: Math.round(z.number().positive().parse(num(form, "second_payment_hours")) * 3600),
      min_match_age: {
        male: z.number().int().min(18).parse(num(form, "min_age_male")),
        female: z.number().int().min(18).parse(num(form, "min_age_female")),
      },
      match_weights: weights.map((w) => ({ ...w, weight: z.number().min(0).parse(num(form, `weight_${w.field}`)) })),
    };
    for (const [key, value] of Object.entries(next)) await setSetting(key, value);
    await audit(email, "settings.matching_updated", "settings", "matching", next);
    revalidatePath("/admin/settings");
  });
}

// ---- Templates, prices, messages (owner) ----
export async function savePricingAction(form: FormData): Promise<ActionResult> {
  return attempt("মূল্য ও টেমপ্লেট সংরক্ষিত হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const bkash = str(form, "bkash_number");
    if (bkash && !/^01[3-9]\d{8}$/.test(bkash)) throw new Error("bKash নম্বর 01XXXXXXXXX ধরনের হতে হবে");
    const pattern = str(form, "trx_id_pattern");
    try {
      new RegExp(pattern);
    } catch {
      throw new Error("TrxID প্যাটার্ন সঠিক regex নয়");
    }
    const next = {
      price_bdt: z.number().int().positive().parse(num(form, "price_bdt")),
      bkash_number: bkash,
      trx_id_pattern: pattern,
      rate_limit_per_minute: z.number().int().positive().parse(num(form, "rate_limit_per_minute")),
      rate_limit_per_day: z.number().int().positive().parse(num(form, "rate_limit_per_day")),
      template_language: str(form, "template_language") || "bn",
      templates: Object.fromEntries(["match_intro", "match_update", "payment_reminder", "contact_release"].map((k) => [k, str(form, `template_${k}`)])),
      messenger_templates: Object.fromEntries(["match_update", "payment_reminder", "contact_release"].map((k) => [k, str(form, `mtemplate_${k}`)])),
    };
    for (const [key, value] of Object.entries(next)) await setSetting(key, value);
    await audit(email, "settings.pricing_updated", "settings", "pricing", next);
    revalidatePath("/admin/templates");
  });
}

export async function saveMessagesAction(form: FormData): Promise<ActionResult> {
  return attempt("বার্তা সংরক্ষিত হয়েছে", async () => {
    const { email } = await requireRole("owner");
    const messages = Object.fromEntries(Object.keys(DEFAULT_MESSAGES).map((k) => [k, String(form.get(`msg_${k}`) ?? "").trim() || DEFAULT_MESSAGES[k as keyof typeof DEFAULT_MESSAGES]]));
    await setSetting("messages", messages);
    await setSetting("system_prompt", str(form, "system_prompt"));
    await setSetting("gate_interpret_prompt", str(form, "gate_interpret_prompt"));
    await audit(email, "settings.messages_updated", "settings", "messages");
    revalidatePath("/admin/templates");
  });
}

