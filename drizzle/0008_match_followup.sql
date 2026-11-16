CREATE TABLE "match_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"asker" text NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "trx_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "number_requested_by" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "claim_details" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "matching_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "match_questions" ADD CONSTRAINT "match_questions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_questions" ADD CONSTRAINT "match_questions_asker_users_phone_fk" FOREIGN KEY ("asker") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "match_questions_match_idx" ON "match_questions" USING btree ("match_id","status");
--> statement-breakpoint
-- New follow-up flow: one side pays for the other's number. The both-pay states fold into both_interested.
UPDATE "matches" SET "state" = 'both_interested' WHERE "state" IN ('b_interested', 'payment_pending');
--> statement-breakpoint
-- The price, only where it is still the old default.
UPDATE "settings" SET "value" = '297'::jsonb WHERE "key" = 'price_bdt' AND "value" = '300'::jsonb;
--> statement-breakpoint
DELETE FROM "settings" WHERE "key" IN ('first_payment_timeout_seconds', 'second_payment_timeout_seconds');
--> statement-breakpoint
-- Prompt rules 5 (matches) and 7 (payment), only where they still hold the default text.
UPDATE "settings" SET "value" = to_jsonb(replace("value" #>> '{}', '5. ম্যাচ তুমি ঠিক করবে না, কোনো প্রস্তাবের প্রতিশ্রুতিও দেবে না; সিস্টেম ঠিক করে। context-এর active_matches-এ your_turn=true হলে কার্ডের তথ্য দেখিয়ে ব্যবহারকারীর মত জেনে respond_to_match করো।', '5. ম্যাচ তুমি ঠিক করবে না, কোনো প্রস্তাবের প্রতিশ্রুতিও দেবে না; সিস্টেম ঠিক করে। Each entry in active_matches has a step. "offered": the user was asked whether they want to see the details; on a yes call respond_to_match with action=see_details (the system sends the details), on a no action=decline. "viewing": they have the details; ask how they find it and whether they have a question for the other side. Liking it → respond_to_match interested; a question for the other side → ask_other_party (never answer for the other side or invent an answer); asking for the phone number → request_number; not interested → decline. pending_questions_for_you are questions the other side asked: pass the user''s reply on with answer_question. To see an earlier proposal again → get_past_matches. Wanting more proposals (for example after the call follow-up) → request_more_matches.')) WHERE "key" = 'system_prompt' AND position('5. ম্যাচ তুমি ঠিক করবে না, কোনো প্রস্তাবের প্রতিশ্রুতিও দেবে না; সিস্টেম ঠিক করে। context-এর active_matches-এ your_turn=true হলে কার্ডের তথ্য দেখিয়ে ব্যবহারকারীর মত জেনে respond_to_match করো।' in "value" #>> '{}') > 0;
--> statement-breakpoint
UPDATE "settings" SET "value" = to_jsonb(replace("value" #>> '{}', '7. Transaction ID পেলে submit_payment (wallet_last4 দেবে শুধু যদি ব্যবহারকারী শেষ ৪ সংখ্যা জানান)। পুরো wallet নম্বর, পিন, OTP বা কার্ড নম্বর কখনো চাইবে না। পেমেন্ট যাচাই হয়েছে এমন কথা কখনো নিজে থেকে বলবে না; শুধু context-এর payments থেকে জানাবে।', '7. Phone numbers are released only after payment, and only to the person who paid. When request_number says payment is open, the system sends the bKash instructions. When the user says they paid, ask for the bKash Transaction ID; if they do not have it, ask only for the last 4 digits of the number they sent from and when they sent it; then call submit_payment. Never ask for a full wallet number, PIN, OTP or card number. Tell them we will verify the transaction first and then send the number. Never say a payment is verified yourself; only report what context payments says.')) WHERE "key" = 'system_prompt' AND position('7. Transaction ID পেলে submit_payment (wallet_last4 দেবে শুধু যদি ব্যবহারকারী শেষ ৪ সংখ্যা জানান)। পুরো wallet নম্বর, পিন, OTP বা কার্ড নম্বর কখনো চাইবে না। পেমেন্ট যাচাই হয়েছে এমন কথা কখনো নিজে থেকে বলবে না; শুধু context-এর payments থেকে জানাবে।' in "value" #>> '{}') > 0;
