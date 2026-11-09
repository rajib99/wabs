# BiyeShadi.live — project brief

We are building BiyeShadi.live, a matrimonial matchmaking service run entirely over WhatsApp by an AI agent called "BS". Users arrive from Facebook ads, chat with BS in Bengali (text or voice), build a profile through conversation, get matched by a scoring engine, exchange photos only with mutual consent, and pay BDT 300 each via bKash to exchange phone numbers. A human admin verifies payments in a dashboard.

Stack: one Next.js 15 app (TypeScript, App Router), self-hosted Inngest for all background work and timers, Postgres 16 + pgvector via Drizzle ORM, all in Docker Compose on a 2 vCPU / 8 GB VPS; Cloudflare R2 for media; WhatsApp Cloud API; DeepSeek (`deepseek-chat`, OpenAI-compatible API) for conversation and extraction; Groq `whisper-large-v3` for Bengali speech-to-text; `multilingual-e5-small` on CPU for embeddings.

Rules:
- No AI inference runs on the VPS except embeddings.
- Any work over a few seconds runs as an Inngest function with steps.
- Put the LLM and transcriber behind interfaces (`LLMProvider`, `Transcriber`) so providers can be swapped by env.
- Build so the app runs end-to-end with no third-party secrets except DATABASE_URL and the LLM key: use a MockChannelAdapter, an /admin/simulator chat page, and a local file store in development, all selected by env vars; validate each secret only when its feature is first used.
- The user's WhatsApp number (E.164) is the primary identifier everywhere.
- All user-facing text is Bengali.
- The LLM never decides matches; deterministic code does.
- Never send one user's phone number to another except through the payment flow.
- All config (questions, weights, thresholds, prices, messages) lives in the database and is editable from the admin panel, never hard-coded.

## Channels
`CHANNEL` selects the adapter behind `ChannelAdapter`: `mock` (simulator), `openwa` (interim, unofficial gateway via `pnpm openwa`), `whatsapp` (official Cloud API, target once Meta approves). Conversation, matching and payment code must stay channel-agnostic: anything specific to one channel goes in its adapter or behind a capability such as `enforcesServiceWindow`. Identity must come from the channel, never from text a user typed.

## Commands
- `pnpm db:migrate && pnpm db:seed` — set up the database
- `pnpm dev` + `pnpm dev:inngest` — app and Inngest dev server
- `pnpm openwa` — run the OpenWA gateway locally (first run clones and builds it)
- `pnpm test` — Vitest (needs Postgres + pgvector, uses `TEST_DATABASE_URL`)
- `pnpm simulate` — 20 synthetic users through the full flow (app and Inngest must be running)
- `pnpm eval:extraction` — 50-message extraction eval (needs `DEEPSEEK_API_KEY` for a meaningful score)
- `LLM_PROVIDER=mock` runs a deterministic rule-based LLM stand-in for development only.
