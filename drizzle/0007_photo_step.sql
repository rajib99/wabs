-- Photo step at the end of onboarding: send photos, and say whether a proposal may see them without asking each time.
ALTER TABLE "users" ADD COLUMN "photo_step_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "photo_share_consent" boolean;--> statement-breakpoint
-- People who already finished onboarding are not stopped by the new step; their photo consent stays per request.
UPDATE "users" SET "photo_step_done" = true WHERE "profile_complete" AND "contact_phone" IS NOT NULL AND "contact_has_whatsapp" IS NOT NULL;
--> statement-breakpoint
-- Adds the photo step to rule 11 of the stored prompt, only where it still holds the default text.
UPDATE "settings" SET "value" = to_jsonb(replace("value" #>> '{}', '"whatsapp" হলে নম্বরটিতে WhatsApp আছে কিনা "হ্যাঁ" বা "না" লিখে জানাতে বলো।', '"whatsapp" হলে নম্বরটিতে WhatsApp আছে কিনা "হ্যাঁ" বা "না" লিখে জানাতে বলো। If contact_step is "photo", answer what they said in short, then ask them to send one or more photos here and to reply "হ্যাঁ" or "না": may a suitable proposal see their photo when asked. You never record that answer; the system does.')) WHERE "key" = 'system_prompt' AND position('"whatsapp" হলে নম্বরটিতে WhatsApp আছে কিনা "হ্যাঁ" বা "না" লিখে জানাতে বলো।' in "value" #>> '{}') > 0 AND position('contact_step is "photo"' in "value" #>> '{}') = 0;
