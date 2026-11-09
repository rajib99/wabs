CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"match_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_a" text NOT NULL,
	"user_b" text NOT NULL,
	"score" double precision NOT NULL,
	"breakdown" jsonb NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"state_timestamps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_embeddings" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"direction" text NOT NULL,
	"type" text NOT NULL,
	"raw_text" text,
	"transcript" text,
	"media_key" text,
	"media_id" text,
	"media_mime" text,
	"wa_message_id" text,
	"dedupe_key" text,
	"status" text DEFAULT 'received' NOT NULL,
	"status_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"usage_seconds" double precision,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_wa_message_id_unique" UNIQUE("wa_message_id"),
	CONSTRAINT "messages_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"payer_phone" text NOT NULL,
	"method" text DEFAULT 'bkash' NOT NULL,
	"sender_wallet_number" text,
	"trx_id" text NOT NULL,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_trx_id_unique" UNIQUE("trx_id")
);
--> statement-breakpoint
CREATE TABLE "photo_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"requester" text NOT NULL,
	"owner" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"r2_key" text NOT NULL,
	"message_id" uuid,
	"owner_confirmed_at" timestamp with time zone,
	"approved_by_admin" boolean,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"field" text NOT NULL,
	"operator" text NOT NULL,
	"value" jsonb NOT NULL,
	"is_dealbreaker" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"question_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text NOT NULL,
	"confidence" double precision NOT NULL,
	"confirm_asked_at" timestamp with time zone,
	"message_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"key" text PRIMARY KEY NOT NULL,
	"bengali_text" text NOT NULL,
	"field_type" text NOT NULL,
	"options" jsonb,
	"order" integer DEFAULT 0 NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"ask_condition" jsonb
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"phone" text PRIMARY KEY NOT NULL,
	"name" text,
	"gender" text,
	"status" text DEFAULT 'new' NOT NULL,
	"created_by_relation" text,
	"age_confirmed_at" timestamp with time zone,
	"consent_at" timestamp with time zone,
	"blocked" boolean DEFAULT false NOT NULL,
	"profile_complete" boolean DEFAULT false NOT NULL,
	"profile_completed_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_phone_users_phone_fk" FOREIGN KEY ("phone") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_user_a_users_phone_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_user_b_users_phone_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_phone_users_phone_fk" FOREIGN KEY ("phone") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_phone_users_phone_fk" FOREIGN KEY ("phone") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_phone_users_phone_fk" FOREIGN KEY ("payer_phone") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "photo_requests" ADD CONSTRAINT "photo_requests_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_requests" ADD CONSTRAINT "photo_requests_requester_users_phone_fk" FOREIGN KEY ("requester") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "photo_requests" ADD CONSTRAINT "photo_requests_owner_users_phone_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_phone_users_phone_fk" FOREIGN KEY ("phone") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_phone_users_phone_fk" FOREIGN KEY ("phone") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "profile_answers" ADD CONSTRAINT "profile_answers_phone_users_phone_fk" FOREIGN KEY ("phone") REFERENCES "public"."users"("phone") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "profile_answers" ADD CONSTRAINT "profile_answers_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "escalations_status_idx" ON "escalations" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_pair_idx" ON "matches" USING btree (LEAST("user_a", "user_b"),GREATEST("user_a", "user_b"));--> statement-breakpoint
CREATE INDEX "matches_state_idx" ON "matches" USING btree ("state","score");--> statement-breakpoint
CREATE INDEX "matches_user_a_idx" ON "matches" USING btree ("user_a","created_at");--> statement-breakpoint
CREATE INDEX "matches_user_b_idx" ON "matches" USING btree ("user_b","created_at");--> statement-breakpoint
CREATE INDEX "message_embeddings_phone_idx" ON "message_embeddings" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "message_embeddings_hnsw_idx" ON "message_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "messages_phone_created_idx" ON "messages" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payments_match_idx" ON "payments" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_open_per_payer_idx" ON "payments" USING btree ("match_id","payer_phone") WHERE "payments"."status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "photo_requests_match_requester_idx" ON "photo_requests" USING btree ("match_id","requester");--> statement-breakpoint
CREATE INDEX "photos_phone_idx" ON "photos" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "preferences_phone_field_idx" ON "preferences" USING btree ("phone","field");--> statement-breakpoint
CREATE INDEX "preferences_dealbreaker_idx" ON "preferences" USING btree ("phone") WHERE "preferences"."is_dealbreaker";--> statement-breakpoint
CREATE UNIQUE INDEX "profile_answers_phone_key_idx" ON "profile_answers" USING btree ("phone","question_key");--> statement-breakpoint
CREATE INDEX "profile_answers_key_idx" ON "profile_answers" USING btree ("question_key");--> statement-breakpoint
CREATE INDEX "users_match_pool_idx" ON "users" USING btree ("gender","status","profile_complete","blocked");