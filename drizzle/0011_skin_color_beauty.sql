-- Two questions for both bride and groom, right after height: skin colour, and a 1-10 self-rating of looks.
-- Required for new profiles; people who already finished keep their complete profile and are not stopped.
INSERT INTO "questions" ("key", "bengali_text", "field_type", "options", "order", "required", "active")
  VALUES ('skin_color', 'পাত্র/পাত্রীর গায়ের রং কেমন: উজ্জ্বল ফর্সা, ফর্সা, উজ্জ্বল শ্যামলা, শ্যামলা, নাকি কালো?', 'select', '[{"value": "very_fair", "label": "উজ্জ্বল ফর্সা"}, {"value": "fair", "label": "ফর্সা"}, {"value": "bright_wheatish", "label": "উজ্জ্বল শ্যামলা"}, {"value": "wheatish", "label": "শ্যামলা"}, {"value": "dark", "label": "কালো"}]'::jsonb, COALESCE((SELECT "order" FROM "questions" WHERE "key" = 'height_cm'), (SELECT MAX("order") FROM "questions")) + 3, true, true)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "questions" ("key", "bengali_text", "field_type", "options", "order", "required", "active")
  VALUES ('beauty_rating', 'দেখতে কেমন, ১ থেকে ১০-এর মধ্যে নিজে একটি নম্বর দিন (১০ = খুব সুন্দর)।', 'number', '{"min": 1, "max": 10}'::jsonb, COALESCE((SELECT "order" FROM "questions" WHERE "key" = 'height_cm'), (SELECT MAX("order") FROM "questions")) + 6, true, true)
ON CONFLICT ("key") DO NOTHING;
