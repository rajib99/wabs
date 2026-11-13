ALTER TABLE "messages" ADD COLUMN "shared_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contact_phone_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contact_phone_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "human_until" timestamp with time zone;--> statement-breakpoint
-- Existing users came from phone-number channels, where the identity is the contact number.
UPDATE "users" SET "contact_phone" = "phone", "contact_phone_verified" = true, "contact_phone_source" = 'channel' WHERE "phone" LIKE '+%';
--> statement-breakpoint
-- Wallet numbers already stored are reduced to their last 4 digits.
UPDATE "payments" SET "sender_wallet_number" = right("sender_wallet_number", 4) WHERE length("sender_wallet_number") > 4;
