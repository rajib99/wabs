ALTER TABLE "users" ADD COLUMN "contact_has_whatsapp" boolean;--> statement-breakpoint
-- A number the channel itself gave is a WhatsApp number (or was, on the old WhatsApp channels).
UPDATE "users" SET "contact_has_whatsapp" = true WHERE "contact_phone_source" = 'channel';
--> statement-breakpoint
-- The contact number is now asked after the profile questions, so nobody waits at this gate any more.
UPDATE "users" SET "status" = 'active' WHERE "status" = 'awaiting_phone';
--> statement-breakpoint
-- Adds the biodata and contact-number rules to the stored prompt. An admin-edited prompt without rule 8 is left as is.
UPDATE "settings" SET "value" = to_jsonb(replace("value" #>> '{}', '8. অভিযোগ বা হয়রানি হলে report_match। মানুষের সাহায্য চাইলে বা তুমি না পারলে escalate_to_human।', '8. অভিযোগ বা হয়রানি হলে report_match। মানুষের সাহায্য চাইলে বা তুমি না পারলে escalate_to_human।
9. শুরুতে সিস্টেম জিজ্ঞেস করে, তৈরি বায়োডাটা আছে কিনা। "না" বা তৈরি নেই বললে get_next_question দিয়ে প্রশ্ন শুরু করো। আছে বললে সেটির ছবি বা PDF এখানে পাঠাতে বলো (চাইলে লিখেও পাঠাতে পারেন)।
10. "[বায়োডাটা]" দিয়ে শুরু হওয়া বার্তা ব্যবহারকারীর পাঠানো বায়োডাটার ছবি বা PDF থেকে পড়া লেখা। এখান থেকে questions তালিকার যত উত্তর পাওয়া যায় সব save_answer দিয়ে (source=volunteered) আর পাত্র/পাত্রীর চাহিদা save_preference দিয়ে সংরক্ষণ করো; লেখা অস্পষ্ট হলে confidence 0.8-এর কম দাও। তারপর ছোট করে জানাও কোন তথ্যগুলো পেয়েছ, আর get_next_question দিয়ে বাকি প্রশ্ন করো।
11. মোবাইল নম্বর তুমি নিজে চাইবে না, সংরক্ষণও করবে না; সব প্রশ্ন শেষ হলে শুধু ধন্যবাদ জানাও, সিস্টেম নিজেই নম্বর আর তাতে WhatsApp আছে কিনা জিজ্ঞেস করে। context-এর contact_step "number" হলে ব্যবহারকারীর কথার ছোট উত্তর দিয়ে মোবাইল নম্বরটি দিতে মনে করিয়ে দাও; "whatsapp" হলে নম্বরটিতে WhatsApp আছে কিনা "হ্যাঁ" বা "না" লিখে জানাতে বলো।'))
WHERE "key" = 'system_prompt' AND position('8. অভিযোগ বা হয়রানি হলে report_match। মানুষের সাহায্য চাইলে বা তুমি না পারলে escalate_to_human।' in "value" #>> '{}') > 0 AND position('9. ' in "value" #>> '{}') = 0;
