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
| `CHANNEL` | `mock` | `messenger` |
| `LLM_PROVIDER` | `mock` (rule-based, refused with `CHANNEL=whatsapp`) | `deepseek` |
| `TRANSCRIBER` | `mock` (looks up `samples/voice/manifest.json`) | `groq` |
| `EMBEDDER` | `e5` or `mock` | `e5` |
| `STORAGE` | `local` | `r2` |

Each secret is checked the first time its feature is used, and the error names what is missing.

## Running on Facebook Messenger

BS talks to people through your Facebook Page. Messenger identifies people by a Page-scoped ID, not a phone number, so after consent BS asks for a contact number using Messenger's "share my number" button. That is the number a paid match receives.

- **Shared with the button:** the number comes from the person's Facebook profile and is treated as verified.
- **Typed instead:** it lands in the admin inbox as **নম্বর যাচাই**. That person is not matched until someone phones the number and presses **ফোন করে যাচাই করেছি**.

### Setup

1. **Facebook Page:** create it, named consistently with the website.
2. **Meta app:** create one at developers.facebook.com, add the **Messenger** product, and connect the Page.
3. **App settings:**
   - **Advanced:** turn on **Require App Secret**.
   - **Basic:** set **Privacy Policy URL** to `https://biyeshadi.live/privacy` and **Data Deletion Instructions URL** to `https://biyeshadi.live/data-deletion`.
4. **Page token:** in Business Settings, create a **System User**, give it the Page, and generate a long-lived Page token with `pages_messaging`. Add `page_utility_messaging` if you will use utility templates.
5. **`.env`:** set `CHANNEL=messenger`, the `MESSENGER_*` values and `PUBLIC_URL`, plus the DeepSeek and Groq keys.
6. **Webhook:** deploy, then set the Messenger webhook to `https://biyeshadi.live/api/messenger/webhook` with your `MESSENGER_VERIFY_TOKEN`.
7. **Page menu:** in `/admin/channel`, press **Messenger সেটআপ প্রয়োগ করুন**. This sets Get Started, the greeting and the menu, and subscribes the app to the Page's events.
8. **Response mode:** in Page Settings → Advanced Messaging, set the response mode to **Hybrid** (bot plus humans).
9. **Test:** until App Review, only people with a role on the app (Admin, Developer or Tester) can chat with the bot. Add your testers there.
10. **Go public:** request **Advanced Access** for `pages_messaging` with a screencast of a real conversation. Meta asks for Business Verification for Advanced Access.

### Rules BS follows, and what you must do too

| Rule | How it is handled |
| --- | --- |
| 24-hour window | Free-form messages only within 24h of the person's last message. Outside it, only approved **utility templates** set under **বার্তা ও মূল্য**; empty means nothing is sent. The old message tags stopped working in April 2026. |
| No promotion outside the window | Utility templates are for payment and account status only. New-match alerts are deliberately not sent outside the window, so BS asks people to check in. |
| No financial account numbers | BS asks only for the bKash Transaction ID, plus the last 4 digits if offered. A full number someone types is cut to 4 digits when stored. |
| Disclose automation | The welcome says BS is an automated AI assistant, and BS says so again when it takes back a conversation from a human. |
| Human help | "মানুষের সাথে কথা বলতে চাই" or the menu's **মানুষের সাহায্য** goes to the admin inbox. Answer it from the Page inbox. |
| Human takeover | A reply typed in the Page inbox silences BS for that person (12 hours by default, set on `/admin/channel`). **BS-কে ফিরিয়ে দিন** on the user page ends it early. |
| Opt-out | STOP erases immediately; the menu's **আমার তথ্য মুছুন** explains it. Meta keeps its own copy of the Messenger thread. |
| Refused sends | Errors such as outside the window or person unavailable are marked failed and never retried. Only rate limits wait and retry. |
| Webhook security | Signed with the app secret, and every Graph call carries `appsecret_proof`. |
| Ads | Matchmaking ads need Meta's dating-ads permission and must target 18+. Click-to-Messenger ads give a 7-day reply window, which BS does not use yet. |

**What you must watch:** Meta restricts Pages that get many blocks or reports. Keep messages short and wanted, and respond to Page Support Inbox notices within 7 days.

## Other channels (not in use)

The WhatsApp Cloud API (`CHANNEL=whatsapp`) and OpenWA (`CHANNEL=openwa`, run with `pnpm openwa`) adapters are kept and tested, but switched off. Users keep their records under their channel identity, so switching channels later means people start a new conversation there.

## Going live (VPS)

Steps 1–5 apply to every channel. Steps 6–7 are for the WhatsApp Cloud API; for Messenger, follow "Running on Facebook Messenger" above instead.

1. **Try the real LLM.** Add `DEEPSEEK_API_KEY`, then run `LLM_PROVIDER=deepseek pnpm eval:extraction`. Tune the system prompt under **বার্তা ও মূল্য** if it scores under 85%. Rerun `pnpm simulate` with `LLM_PROVIDER=deepseek`: the script was written around the mock's wording, so any differences need reading rather than assuming failure.
2. **Prepare the VPS.** Copy your SSH key to the server, then run `sudo bash deploy/harden.sh deploy`. Confirm `ssh deploy@server` in a new terminal before closing the old one. Create `/opt/biyeshadi`, owned by `deploy`.
3. **Create `/opt/biyeshadi/.env`** from `.env.example` with `CHANNEL=messenger` `LLM_PROVIDER=deepseek TRANSCRIBER=groq STORAGE=r2`, and generate `POSTGRES_PASSWORD`, `AUTH_SECRET`, `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` (`openssl rand -hex 32`). The signing key must be hex.
4. **Create two private R2 buckets**: media and backups. Add the backup cron from the top of `deploy/backup.sh`, then run it once by hand and restore that dump somewhere to prove it works.
5. **Deploy.** Add repository secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS` (`ssh-keyscan -H server`) and variable `DEPLOY_ENABLED=true`. Point DNS at the VPS, then push to `main`. For a private repo, the VPS also needs lasting GHCR read access: the workflow's token expires when the job ends. Set `UPTIME_ENABLED=true` afterwards.
6. **Test number.** Set the bKash number in the admin, add `WHATSAPP_*` for a Meta test number, and take two real phones through the whole flow, including a voice note and a photo.
7. **Register the production webhook**: `https://biyeshadi.live/api/whatsapp/webhook`, subscribed to `messages`. Submit the four templates and put their names under **বার্তা ও মূল্য**. Without them, messages outside the 24-hour window are skipped and logged.

## Roles

- **owner**: everything.
- **verifier**: payments, photo moderation and inbox. No user search, transcripts, settings or revenue.

Add a verifier with SQL for now: insert into `admin_users` with a bcrypt hash and role `verifier`.
