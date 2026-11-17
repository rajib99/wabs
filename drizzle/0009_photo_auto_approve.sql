-- Photos are shared without admin approval now: the photo-step message no longer promises a team review.
-- Changed only where it still holds the old default, so admin edits are kept.
UPDATE "settings" SET "value" = jsonb_set("value", '{photo_step_request}', to_jsonb('শেষ ধাপ: আপনার (বা যাঁর জন্য পাত্র/পাত্রী খুঁজছেন তাঁর) এক বা একাধিক ছবি এখানে পাঠান।

কোনো উপযুক্ত প্রস্তাবের পক্ষ ছবি দেখতে চাইলে আমরা কি আপনার ছবি তাঁকে দেখাতে পারি? "হ্যাঁ" বা "না" লিখুন। "না" বললে প্রতিবার আপনার অনুমতি নিয়ে তবেই পাঠাব।'::text)) WHERE "key" = 'messages' AND "value" ->> 'photo_step_request' = 'শেষ ধাপ: আপনার (বা যাঁর জন্য পাত্র/পাত্রী খুঁজছেন তাঁর) এক বা একাধিক ছবি এখানে পাঠান। ছবি আমাদের টিম দেখে নেবে, তারপরই কাউকে দেখানো হবে।

কোনো উপযুক্ত প্রস্তাবের পক্ষ ছবি দেখতে চাইলে আমরা কি আপনার ছবি তাঁকে দেখাতে পারি? "হ্যাঁ" বা "না" লিখুন। "না" বললে প্রতিবার আপনার অনুমতি নিয়ে তবেই পাঠাব।';
