# BiyeShadi.live — Build Prompt List

Nov 7, 2026 · @Alex

## Read this first: platform risk

The biggest risk is not technical. WhatsApp's [Business Messaging Policy](https://business.whatsapp.com/policy) lists **dating services** as prohibited, and Meta's [enforcement page](https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement-violations) says businesses may not facilitate online dating. A paid matchmaking bot on the Cloud API can get the number banned, and Meta may bar you from all future WhatsApp business use.

Facebook ads for matchmaking need [prior written permission](https://transparency.meta.com/policies/ad-standards/restricted-goods-services/dating-ads/) from Meta and must target 18+.

How to de-risk before you build:

- Apply for Meta's dating-ads permission first; matrimonial (family-oriented, marriage-only) framing is your strongest case.
- Build the conversation engine **channel-agnostic** so WhatsApp is one adapter. Keep a fallback ready: Telegram bot or a web chat on biyeshadi.live.
- Never take payment inside WhatsApp; keep bKash collection and verification on your side (already the plan).
- Get a written opinion on Bangladesh data-protection rules before storing photos and personal data at scale.

## Recommended stack

Use PostgreSQL as the single source of truth and let code, not the LLM, make the match decision. The LLM talks and extracts answers; SQL filters and a scoring function decide matches, so results are explainable and your admin thresholds actually bind.

| Layer | Choice | Why |
| --- | --- | --- |
| Channel | WhatsApp Cloud API (direct from Meta), behind a channel adapter | No BSP markup; adapter lets you swap to Telegram/web if WhatsApp blocks you |
| App | One Next.js 15 app (TypeScript, App Router) in Docker on your VPS | Webhook, API routes and admin in one codebase; stays Vercel-compatible if you move later |
| Background jobs | Inngest, self-hosted in Docker on the VPS | Durable steps, retries, per-user ordering, and `sleep`/`waitForEvent` for the 24-hour payment rule |
| Database | Postgres 16 + pgvector in Docker on the VPS, Drizzle ORM, nightly backups off-server | No database bill; 8 GB RAM is plenty at launch |
| Files | Cloudflare R2 (free tier), private bucket, signed URLs | Photos and voice notes never public, not lost if the VPS dies |
| LLM | DeepSeek API (`deepseek-chat`) via the OpenAI SDK with a custom base URL | Cheap, OpenAI-compatible, supports tool calls |
| Embeddings | `multilingual-e5-small` running on the VPS (CPU) | DeepSeek has no embeddings API; this small model handles Bengali and runs fine on 2 vCPU |
| Speech-to-text | Groq `whisper-large-v3`, language `bn` | Fast, cheap, most accurate Whisper model |
| Admin auth | Auth.js with owner/verifier roles | Simple, works on phone |
| Hosting cost | Existing VPS + DeepSeek and Groq pay-as-you-go | A few dollars a month at early volume |

## Build prompts (run in order)

Feed these one at a time to Claude Code. Each assumes the previous one is merged and tested. Paste Prompt 0 at the top of the repo as `CLAUDE.md` so every later prompt inherits it.

**Prompt 0 — Project brief (save as CLAUDE.md)**

> We are building BiyeShadi.live, a matrimonial matchmaking service run entirely over WhatsApp by an AI agent called "BS". Users arrive from Facebook ads, chat with BS in Bengali (text or voice), build a profile through conversation, get matched by a scoring engine, exchange photos only with mutual consent, and pay BDT 300 each via bKash to exchange phone numbers. A human admin verifies payments in a dashboard. Stack: one Next.js 15 app (TypeScript, App Router), self-hosted Inngest for all background work and timers, Postgres 16 + pgvector via Drizzle ORM, all in Docker Compose on a 2 vCPU / 8 GB VPS; Cloudflare R2 for media; WhatsApp Cloud API; DeepSeek (`deepseek-chat`, OpenAI-compatible API) for conversation and extraction; Groq `whisper-large-v3` for Bengali speech-to-text; `multilingual-e5-small` on CPU for embeddings. Rules: no AI inference runs on the VPS except embeddings. Any work over a few seconds runs as an Inngest function with steps. Put the LLM and transcriber behind interfaces (`LLMProvider`, `Transcriber`) so providers can be swapped by env. Build so the app runs end-to-end with no third-party secrets except DATABASE\_URL and the LLM key: use a MockChannelAdapter, an /admin/simulator chat page, and a local file store in development, all selected by env vars; validate each secret only when its feature is first used. The user's WhatsApp number (E.164) is the primary identifier everywhere. All user-facing text is Bengali. The LLM never decides matches; deterministic code does. Never send one user's phone number to another except through the payment flow. All config (questions, weights, thresholds, prices, messages) lives in the database and is editable from the admin panel, never hard-coded.

**Prompt 1 — Scaffold**

> Scaffold a single Next.js 15 app (TypeScript, App Router, pnpm, `output: 'standalone'`): `app/api/whatsapp/webhook`, `app/api/inngest` (Inngest serve handler), `app/admin` (shadcn/ui) with `app/admin/simulator`, `lib/db` (Drizzle + node-postgres), `lib/channel`, `lib/ai` (LLMProvider, Transcriber, Embedder), `inngest/functions`. Add a `ChannelAdapter` interface (receiveMessage, sendText, sendImage, sendTemplate, downloadMedia) with `WhatsAppCloudAdapter` and `MockChannelAdapter`. Add `docker-compose.yml` with services: app, postgres (pgvector image), inngest (self-hosted, with its Redis), and caddy for HTTPS; set memory limits so the stack fits in 8 GB. Add `.env.example`, lazy zod-validated env, structured logging, and `/api/health`.

**Prompt 2 — Database schema**

> Create the Drizzle schema and migrations (enable the pgvector extension) for: `users` (phone PK, name, gender, status, created\_by\_relation: self/parent/sibling/other, consent\_at, blocked), `messages` (every inbound/outbound message: phone, direction, type text/voice/image, raw\_text, transcript, media\_key, wa\_message\_id unique, created\_at), `message_embeddings` (vector column), `questions` (key, bengali\_text, field\_type, options, order, required, active, ask\_condition), `profile_answers` (phone, question\_key, value jsonb, source: asked/volunteered/inferred, confidence, message\_id), `preferences` (phone, field, operator, value, is\_dealbreaker), `photos` (phone, r2\_key, approved\_by\_admin), `matches` (user\_a, user\_b, score, breakdown jsonb, state, timestamps per state), `photo_requests`, `payments` (match\_id, payer\_phone, method, sender\_wallet\_number, trx\_id unique, amount, status pending/verified/rejected, verified\_by, verified\_at), `settings` (key/value jsonb), `admin_users`, `audit_log`. Add indexes for matching queries and a seed script.

**Prompt 3 — WhatsApp webhook and pipeline**

> Implement the Cloud API webhook route: GET verification; POST reads the raw body, checks X-Hub-Signature-256, inserts the message with ON CONFLICT (wa\_message\_id) DO NOTHING to dedupe, sends an Inngest event `wa/message.received`, and returns 200 immediately. Do no AI or media work in the route. The Inngest function handling that event uses `concurrency: { key: event.data.phone, limit: 1 }` so each user's messages are processed in order. Send via the Graph API inside Inngest steps (automatic retries). Track each user's 24-hour customer-service window; outside it, only send approved template messages (template names in settings). Store delivery and read status updates.

**Prompt 4 — Voice notes and images**

> In the `wa/message.received` Inngest function, as separate steps: for voice notes, download the media, store the original in R2, and transcribe with `GroqTranscriber` (OpenAI-compatible `/audio/transcriptions` endpoint at Groq, model `whisper-large-v3`, `language: 'bn'`, retry on 429 with backoff). Save the transcript on the message, then continue as if it were text. If transcription fails or returns very little text, ask the user in Bengali to type it or resend. For images, store in R2 privately and ask the user (in Bengali) whether this is their profile photo; mark as pending admin approval. Reject files over 16 MB politely. Log Groq usage seconds per message for cost tracking.

**Prompt 5 — BS conversation agent with memory**

> Build the agent loop with `DeepSeekProvider` (OpenAI SDK, `baseURL: https://api.deepseek.com`, model `deepseek-chat`, temperature 0.3). Before every reply, load context for that phone: the full structured profile (all `profile_answers`), preferences, the last 20 messages, top 5 semantically similar older messages from pgvector (embed with `multilingual-e5-small` on CPU via transformers.js or fastembed, 384 dimensions; embed each message in a background step, not in the reply path), the current match states, and pending payments. Keep the system prompt (Bengali, editable in settings) as a fixed prefix so DeepSeek's context cache cuts cost. Give the model tools: `save_answer(question_key, value, source, confidence)`, `save_preference(field, operator, value, is_dealbreaker)`, `get_next_question()`, `respond_to_match(match_id, action)`, `submit_payment(match_id, wallet_number, trx_id)`, `escalate_to_human(reason)`. Validate every tool argument with zod; on invalid JSON, retry once, then fall back to a safe Bengali reply. Rules: extract every answer the user volunteers in any message, even unasked; never ask a question whose key already has an answer with confidence ≥ 0.8; ask at most 2 questions per reply; confirm low-confidence answers once. Treat phrases like "only government job" as dealbreaker preferences. Keep replies short, warm, respectful Bengali. Log tokens per reply.

**Prompt 6 — Question bank engine**

> Implement `get_next_question(phone)`: return the highest-priority active question whose key has no confident answer and whose `ask_condition` (JSON rules, e.g. ask "spouse\_job\_type" only if gender = female) is met. Seed questions in Bengali: name, age, gender, profile created for, religion, marital status, district, current location, education, profession and job type (govt/semi-govt/private/business/other), income range, height, family details, preferred age range, preferred education, preferred job type, preferred location. Mark profile complete when all required keys are answered.

**Prompt 7 — Matching engine**

> Build `findMatches(phone)` as an Inngest function triggered by `profile/completed` and `profile/updated` events, plus a nightly Inngest cron that re-runs it for active users. Step 1, SQL hard filters: opposite gender, both profiles complete and active, neither blocked, no existing match row, and every dealbreaker preference of BOTH users satisfied (e.g. if she requires job\_type in \[govt, semi\_govt\], private job holders are excluded). Step 2, weighted score 0–100 using per-field weights and comparison rules from settings (exact, range, list-overlap, distance by district). Step 3, keep candidates with score ≥ `match_threshold` (default 70, editable). Store the per-field breakdown. Limit active introductions per user per day (setting). Write Vitest tests covering dealbreaker override and threshold edges.

**Prompt 8 — Introduction and consent flow**

> Implement the match state machine: proposed → shown\_to\_a → a\_interested → shown\_to\_b → b\_interested → both\_interested → payment\_pending → contact\_released (plus declined, expired). Show profiles as a Bengali card WITHOUT photo or phone: age, education, profession, job type, district, family summary, match %. If a user asks for the photo, create a `photo_request` and ask the owner for permission; only send the photo after an explicit yes; same in reverse. If either declines at any step, close politely without revealing who declined. When both say they want to talk, emit `match/both_interested`. Use templates when a party is outside the 24-hour window. Implement state expiry with an Inngest function per match using `step.waitForEvent` with timeouts from settings.

**Prompt 9 — Manual bKash payment flow**

> Build an Inngest function triggered by `match/both_interested`. Step 1: send each party the bKash number and amount (BDT 300, from settings) and ask for the sending wallet number and transaction ID. The agent's `submit_payment` tool validates trx format, rejects reused trx IDs, and creates a pending `payments` row shown in the admin queue. When an admin marks a payment verified, emit `payment/verified` with match\_id and phone. Step 2: `waitForEvent('payment/verified')` for the first payer. Step 3: `waitForEvent` for the other party with a 24-hour timeout; meanwhile tell the payer in Bengali that the other number will come within 24 hours and remind the other party. If the second payment arrives, send both numbers to both. On timeout, release the other party's number to the payer only. Rejected payments get a polite Bengali message with the reason. Log every step in `audit_log`.

**Prompt 10 — Admin dashboard**

> Build the admin under `/admin` in the same app, with Auth.js login and roles (owner, verifier) enforced in middleware and server actions. Pages: payment queue (pending first, one-click verify/reject with note; verify emits `payment/verified` to Inngest), users (search by phone, full profile, conversation transcript with voice notes playable via R2 signed URLs, photos with approve/reject, block), matches (filter by state and score, breakdown view), question bank (CRUD, reorder, conditions, Bengali text), matching settings (threshold slider, field weights, daily intro limit, expiry timers), message templates and prices, live stats (new users/day, completion rate, matches, payments, revenue). Every change writes to `audit_log`.

**Prompt 11 — Safety and compliance**

> Add: 18+ age gate at first message (stop and politely end if under 18), consent message with privacy terms before storing data, STOP/delete command that erases the profile and media, report/block a match, rate limits per number, prompt-injection guard (users cannot change their own verification status or see other users' data through the agent), photo moderation queue, and an `escalate_to_human` inbox in the admin.

**Prompt 12 — Tests and deploy**

> Write a simulator script that plays 20 synthetic Bengali users (including voice notes from sample files) through the full flow using the MockChannelAdapter: onboarding, volunteered answers, dealbreakers, match, photo consent, one-sided payment with 24h timeout (use a short test timeout), two-sided payment. Add Vitest coverage for matching and payment states, and an eval set of 50 Bengali messages checking DeepSeek's extraction accuracy. Then deploy to the VPS: harden it (non-root user, SSH keys only, ufw allowing 22/80/443, fail2ban), install Docker, run the compose stack with Caddy for HTTPS on biyeshadi.live, GitHub Actions that build the image and deploy over SSH, nightly `pg_dump` uploaded to R2 with 14-day retention, Sentry for errors, and an uptime check on the webhook route. Register the production webhook URL in the Meta app only after a test number passes the full flow.

## Gaps to decide before launch

- [ ] **The 24-hour rule leaks revenue.** Once users learn the other side calls them anyway, the second party stops paying. Consider one party paying BDT 500 to unlock both, or releasing nothing until both pay.
- [ ] **Proactive messages cost money and need approved templates.** Contacting the opposite party about a new match is usually outside the 24-hour window, so it needs a paid template that Meta may reject for matchmaking.
- [ ] **Profiles made by parents.** In Bangladesh many profiles are created by a guardian; decide whose number gets released and whose consent counts.
- [ ] **Fake and already-married profiles.** Decide on optional verification (selfie match or video call) and a visible "verified" badge.
- [ ] **Photos can be screenshotted.** Consent gating is good, but add a watermark with the viewer's last 4 digits to deter misuse.
- [ ] **Manual bKash checks will not scale.** Plan the move to the bKash merchant/tokenized checkout API once volume passes \~30 payments a day.
- [ ] **Refund policy** when a verified payer never gets a response or the number is wrong.
