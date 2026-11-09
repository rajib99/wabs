# BiyeShadi.live

WhatsApp matrimonial matchmaking run by an AI agent, "BS". See `CLAUDE.md` for the brief.

## Run locally (no third-party secrets needed)

Needs Node 22+, pnpm, and Postgres with pgvector (`brew install pgvector`).

```bash
pnpm install
cp .env.example .env            # then set AUTH_SECRET and ADMIN_PASSWORD
createdb biyeshadi && createdb biyeshadi_test
pnpm db:migrate && pnpm db:seed
pnpm build && pnpm start        # terminal 1 (or: pnpm dev)
pnpm dev:inngest                # terminal 2
```

Log in at `/admin`, open **সিমুলেটর**, and chat as any phone number. Set the bKash number under **বার্তা ও মূল্য** before testing payments.

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit and integration tests against real Postgres |
| `pnpm simulate` | 20 synthetic users through the whole product (app and Inngest running) |
| `LLM_PROVIDER=deepseek pnpm eval:extraction` | Extraction accuracy on 50 Bengali messages; exits non-zero under 85% |

## Adapters, chosen by env

| Env | Development | Production |
| --- | --- | --- |
| `CHANNEL` | `mock` | `openwa` for now, `whatsapp` after Meta approval |
| `LLM_PROVIDER` | `mock` (rule-based, refused with `CHANNEL=whatsapp`) | `deepseek` |
| `TRANSCRIBER` | `mock` (looks up `samples/voice/manifest.json`) | `groq` |
| `EMBEDDER` | `e5` or `mock` | `e5` |
| `STORAGE` | `local` | `r2` |

Each secret is checked the first time its feature is used, and the error names what is missing.

## Running on real WhatsApp with OpenWA (interim)

[OpenWA](https://github.com/rmyndharis/OpenWA) links a phone number the way WhatsApp Web does. It is **unofficial**, which breaks WhatsApp's terms, and the number can be restricted or banned at any time with no appeal we control. Use a dedicated number you can afford to lose: not your personal one, and not the number you will register with the Cloud API.

**First run on your machine** (needs Node 22 via nvm, Google Chrome and the Inngest dev server):

1. In `.env`, set `CHANNEL=openwa`, `LLM_PROVIDER=deepseek`, `DEEPSEEK_API_KEY`, and `TRANSCRIBER=groq` with `GROQ_API_KEY` for voice notes.
2. Start everything, each in its own terminal: `pnpm openwa`, `pnpm build && pnpm start`, `pnpm dev:inngest`.
3. Open `/admin/whatsapp`, add your test numbers to **পরীক্ষকের তালিকা**, then press **সংযোগ শুরু করুন** and scan the QR from the business phone.
4. Set the bKash number under **বার্তা ও মূল্য**, and message the number from a tester's phone.

Everything starts closed: **the tester list begins empty, so BS ignores all strangers** and stores nothing about them. Turn it off only when you are ready for the public.

**While observing:**

| To | Go to |
| --- | --- |
| Read conversations and tokens used | `/admin/users` |
| Change how BS talks | System prompt under **বার্তা ও মূল্য** (no restart) |
| Change questions, weights, timers | **প্রশ্ন**, **ম্যাচিং সেটিংস** (no restart) |
| Stop replies at once | **BS বিরতি দিন** on `/admin/whatsapp`; held messages are answered on resume |
| See failed runs | Inngest at `http://localhost:8288` |
| See OpenWA's own dashboard | `http://localhost:2785` |

The Mac must stay awake: run `caffeinate -s` in a terminal. Messages that arrive while it is off may not all be recovered.

**What this channel does differently:**

- There is no Meta 24-hour window and no templates, so proactive messages go out as plain text.
- Sends are capped by OpenWA's pacing, which grows with the session's age. Refused or failed sends stay queued and are retried for 24 hours.
- A sender whose real number WhatsApp will not reveal is not served, because the number is what the payment flow releases. These show up as `channel.unverified_sender` in the audit log.
- STOP also erases OpenWA's copy of the chat. It cannot reach the WhatsApp app on the business phone, so clear that chat there too if you want it gone.

**Moving to a VPS:** follow "Going live" steps 2–5 below with `CHANNEL=openwa`, plus `OPENWA_API_KEY` and `OPENWA_WEBHOOK_SECRET`. The session does not move with the app: scan a fresh QR at `/admin/whatsapp` after deploying. Warning: WhatsApp watches data-centre IPs more closely than home connections, and OpenWA's own docs say so, so expect the risk to go up.

## Switching to the official Cloud API

Conversation, matching, payments and data are shared, so this is a configuration change.

1. Complete Meta's setup and get the four message templates approved.
2. In `.env`, set `CHANNEL=whatsapp` and uncomment the `WHATSAPP_*` block.
3. Restart the app and register `https://biyeshadi.live/api/whatsapp/webhook` in the Meta app.
4. Put the template names under **বার্তা ও মূল্য**. Without them, messages outside the 24-hour window are skipped.
5. Unlink at `/admin/whatsapp` first, then remove the `openwa` service from `docker-compose.yml` and set the repository variable `CHANNEL=whatsapp`.

User records are keyed by each user's own number, so profiles, matches and payments carry over. A number can't be on the Cloud API and linked to OpenWA at once, and the safer plan is to use a different number for each. That means existing users have to message the new number, or be reached there through approved templates.

The tester list applies on the Cloud API too, so check it before going public.

## Going live on the Cloud API

These are also the VPS steps for OpenWA, up to step 5. **Register the webhook in Meta only after step 6 passes.**

1. **Try the real LLM.** Add `DEEPSEEK_API_KEY`, then run `LLM_PROVIDER=deepseek pnpm eval:extraction`. Tune the system prompt under **বার্তা ও মূল্য** if it scores under 85%. Rerun `pnpm simulate` with `LLM_PROVIDER=deepseek`: the script was written around the mock's wording, so any differences need reading rather than assuming failure.
2. **Prepare the VPS.** Copy your SSH key to the server, then run `sudo bash deploy/harden.sh deploy`. Confirm `ssh deploy@server` in a new terminal before closing the old one. Create `/opt/biyeshadi`, owned by `deploy`.
3. **Create `/opt/biyeshadi/.env`** from `.env.example` with `CHANNEL=whatsapp` (or `openwa`) `LLM_PROVIDER=deepseek TRANSCRIBER=groq STORAGE=r2`, and generate `POSTGRES_PASSWORD`, `AUTH_SECRET`, `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` (`openssl rand -hex 32`). The signing key must be hex.
4. **Create two private R2 buckets**: media and backups. Add the backup cron from the top of `deploy/backup.sh`, then run it once by hand and restore that dump somewhere to prove it works.
5. **Deploy.** Add repository secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS` (`ssh-keyscan -H server`) and variable `DEPLOY_ENABLED=true`. Point DNS at the VPS, then push to `main`. For a private repo, the VPS also needs lasting GHCR read access: the workflow's token expires when the job ends. Set `UPTIME_ENABLED=true` afterwards.
6. **Test number.** Set the bKash number in the admin, add `WHATSAPP_*` for a Meta test number, and take two real phones through the whole flow, including a voice note and a photo.
7. **Register the production webhook**: `https://biyeshadi.live/api/whatsapp/webhook`, subscribed to `messages`. Submit the four templates and put their names under **বার্তা ও মূল্য**. Without them, messages outside the 24-hour window are skipped and logged.

## Roles

- **owner**: everything.
- **verifier**: payments, photo moderation and inbox. No user search, transcripts, settings or revenue.

Add a verifier with SQL for now: insert into `admin_users` with a bcrypt hash and role `verifier`.
