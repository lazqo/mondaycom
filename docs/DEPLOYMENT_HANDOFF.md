# Get Secure CRM — deployment handoff

Everything needed to put v0.4 into production and run it. One architecture, no alternatives.
Written for someone who has not seen the code.

You will need three things that only you can provide: a Railway account (card on file), the Titan
mailbox app password, and an Anthropic API key. Nothing else is outstanding.

---

## 1. Hosting platform

**Railway** (railway.com). One project containing two services:

| Service | What it is | Why |
| --- | --- | --- |
| `web` | The CRM, built from the repo's `Dockerfile` | Serves the app **and** holds the live IMAP connection to Titan |
| `Postgres` | Railway's managed PostgreSQL | Holds every record, email, attachment and photo |

Railway is the right fit because the CRM keeps a mailbox connection open permanently (IMAP IDLE) so
enquiries appear within seconds. That needs an always-on container, which rules out serverless hosts
such as Vercel. Railway also runs the managed database beside it and already understands this repo:
`railway.json` in the project root tells it to build the `Dockerfile` and health-check `/api/health`.

**The `web` service must stay at exactly one replica.** Two replicas would mean two processes
watching the same mailbox. Nothing else about the app prevents scaling; the mailbox does.

Expect roughly USD 10–20/month for both services at this size, plus Anthropic usage (section 10).

---

## 2. Services to create

1. Sign in to https://railway.com and create a **New Project**.
2. **Deploy from GitHub repo** → `lazqo/mondaycom` → branch `main` (or whichever branch you want
   production to track). Railway reads `railway.json` and builds the Dockerfile. The first build
   takes a few minutes.
3. In the same project: **+ Create → Database → Add PostgreSQL**.
4. On the `web` service → **Settings → Networking → Generate Domain**. Copy that URL; it is your
   `APP_URL`. Add a custom domain here later if you want `crm.getsecure.co.nz`.
5. On the `web` service → **Settings**, confirm replicas is **1**.

Do not create any storage bucket, Redis, or worker service. The app needs none of them.

---

## 3. Environment variables

Set these on the **`web`** service → **Variables**. Railway injects `PORT` itself; do not set it.

| Variable | Value to enter | Where it comes from |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Type it exactly like that. It is a Railway reference to the Postgres service you created. |
| `AUTH_SECRET` | run `openssl rand -base64 32` | Generate on your machine. Signs login cookies; changing it signs everyone out. |
| `ENCRYPTION_KEY` | run `openssl rand -base64 32` again | Generate on your machine. Encrypts the Titan mailbox password stored in the database. |
| `APP_URL` | `https://<your Railway domain>` | From step 2.4. Must be the https URL. |
| `APP_TIMEZONE` | `Pacific/Auckland` | Fixed. Drives "Today", follow-up dates and business hours. |
| `INGEST_IN_PROCESS` | `true` | Fixed. Runs the mailbox watcher inside the web service. |
| `INGEST_POLL_SECONDS` | `120` | Fixed. Backstop poll; IDLE reacts sooner. |
| `AI_PROVIDER` | `auto` | Fixed. Uses Claude when a key is present, offline rules when not. |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | https://console.anthropic.com → API keys → Create key. See section 10. |
| `AI_MODEL` | `claude-opus-5` | Fixed unless you deliberately change models. |
| `AI_LEAD_CONFIDENCE_THRESHOLD` | `0.75` | Fixed. Above this a lead is created automatically; below it goes to Needs review. |
| `HEALTH_TOKEN` | run `openssl rand -hex 16` | Generate on your machine. Lets an uptime monitor read detailed health. |

Store `AUTH_SECRET` and `ENCRYPTION_KEY` in a password manager. A database backup cannot be used
without them: the sessions and the saved mailbox password are tied to those two values.

**The Titan mailbox password is not an environment variable.** You enter it inside the app, where it
is encrypted before being stored (section 9).

To sanity-check a local `.env` against this list, run `pnpm env:check`.

---

## 4. Where the database lives

The `Postgres` service inside the same Railway project. The `web` service reaches it over Railway's
private network, so the database is not exposed to the internet by default.

To reach it from your laptop (for a manual backup, section 11): Postgres service → **Settings →
Networking → Public Networking** → enable. Railway then publishes a `DATABASE_PUBLIC_URL` variable
containing the external connection string. Traffic through it is billed as network egress, so use it
for backups and admin, not for the app.

---

## 5. Where uploaded photos and email attachments are stored

**In the PostgreSQL database**, as binary columns (`job_photos.content`, `email_attachments.content`).
There is no S3 bucket, no disk volume and no public file URL anywhere in the system.

This matters in three ways:

- **Access.** A file is only ever served through `/api/photos/…` or `/api/attachments/…`, which check
  your login session first. A signed-out request gets a 401, and there is no URL that shows a photo
  to someone without an account. Email attachments are sent with `Cache-Control: private, no-store`.
  Job photos use `private, max-age=3600` so a technician's phone does not re-download the same photo
  all day; that means a browser that already fetched a photo may still show it for up to an hour
  after the person's access is removed.
- **Backups.** Backing up the database backs up every photo and attachment. There is no second thing
  to back up.
- **Size.** Job photos will grow the database over time. Check the database size in Railway every few
  months; at a few hundred photos this is not a concern.

---

## 6. Deploy and migration commands

**There are none to run by hand.** Every push to the connected branch rebuilds and redeploys, and the
container runs pending database migrations automatically on start (`scripts/start.sh` calls
`scripts/migrate.mjs` before the server boots).

To deploy: push to the branch Railway tracks, or press **Deploy** in the Railway UI.

If you ever need to run a migration manually against the database (you should not):

```bash
DATABASE_URL='<the DATABASE_PUBLIC_URL from Railway>' node scripts/migrate.mjs
```

Migrations are idempotent — running them twice is safe.

---

## 7. First login and setup

1. Open `https://<your domain>/` in a browser. With no users in the database it lands on **`/setup`**.
2. **Step 1 — create your admin login.** Enter your name, email and a password. This creates the
   first admin account and signs you in.
3. You then get a six-step checklist that ticks itself off as each thing is done:
   1. Admin login (done by step 2)
   2. Add staff — office people and technicians, each with a role
   3. Connect the Titan mailbox (section 9)
   4. Configure AI (section 10)
   5. Set business hours and reminder thresholds
   6. Start using the CRM

**Do step 2 immediately after the first deploy.** Until the first admin exists, the create-admin form
is reachable by anyone who has the URL. Once a user exists the form is gone, and `/setup` requires an
admin login. This is the only window, and it closes as soon as you create your account.

You can reopen the checklist any time from the banner on the Today screen. There is no seed script to
run.

Roles: **Admin** sees everything including settings. **Office** sees the work but not settings.
**Technician** sees only My day, Customers, Jobs and Calendar — no inbox, no leads, no settings, no
mailbox configuration.

---

## 8. Connecting the Titan mailbox

In Titan webmail, once, as the mailbox you want to connect (for example `info@getsecure.co.nz`):

1. **Settings → Third-party email access** (sometimes "Mail clients") → turn it **on**.
2. If two-factor authentication is on for that account, create an **app password**. Use that, not the
   normal password.

Then in the CRM, as an admin:

1. **Settings → Email accounts → Connect mailbox**.
2. Enter the display name, the email address, the username (the full address) and the app password.
   Leave the hosts and ports as pre-filled — IMAP `imap.titan.email:993` SSL, SMTP
   `smtp.titan.email:465` SSL.
3. Press **Test connection**. Both IMAP and SMTP must say OK before you continue.
4. Press **Connect**, then **Check for new email**. The first sync pulls the last 14 days; after that
   only new messages, tracked by IMAP UID so nothing is imported twice.

The password is encrypted with `ENCRYPTION_KEY` before it is written to the database. It is never in
an environment variable, never in the repository and never shown again in the UI.

---

## 9. Where the Anthropic API key goes

Two places, in this order:

1. Get the key: https://console.anthropic.com → **API keys** → **Create key**. Copy it once; the
   console will not show it again.
2. Paste it into Railway → `web` service → **Variables** → `ANTHROPIC_API_KEY`. Saving a variable
   redeploys the service.

Leave `AI_PROVIDER=auto`. With the key present the CRM classifies enquiries with Claude
(`claude-opus-5`); with the key absent it silently falls back to the built-in offline rules, so a
missing or expired key degrades quality but never stops email coming in.

Check it took effect at **Settings → Email AI**, which names the active provider and model.

**Cost.** Roughly 2 US cents per email that actually reaches the AI, at current
Claude Opus 5 pricing (USD 5 per million input tokens, USD 25 per million output). Replies on an
existing thread, mail from known customers, bounces and newsletters never reach the AI at all. At
twenty fresh enquiries a day that is on the order of USD 10 a month. Set a spend limit in the
Anthropic console if you want a hard ceiling.

---

## 10. Verifying receive, reply and AI classification

Do these three in order, after the mailbox is connected. This is the staging checkpoint.

**IMAP receive.** From a personal address, send a realistic enquiry to the Titan mailbox — for
example: *"Hi, we need 6 CCTV cameras installed at our warehouse in Penrose, and a quote for an Ajax
alarm. Can someone come and look? — Dave, 021 555 0123."* Within a minute it should appear in the
CRM **Inbox**. If it does not, press **Check for new email** and then look at **Settings → System
status**.

**Live AI classification.** Open that email in the Inbox. It should either have created a lead on the
Leads board (with name, phone, service, site address, summary and urgency filled in) or be sitting in
**Needs review** with the AI's reading of it. Check the extracted fields look sensible. **Settings →
Email AI** shows the provider, the confidence and recent classifications; if it says the rules
classifier is active, the API key has not taken effect.

**SMTP reply.** Open the thread in the CRM and write a reply. Send it. Three things must be true: the
reply arrives in your personal inbox, it appears threaded under the original message rather than as a
new conversation, and it shows on the CRM thread as an outbound message. The CRM never sends AI-written
text to a customer; what you type is what goes.

If all three pass, the system is live. `docs/runbooks/staging-checkpoint.md` has the longer version of
this with troubleshooting.

---

## 11. Backups and restore

**Automatic (set this up before real data goes in).** Railway → `Postgres` service → **Backups** tab
→ enable **Daily**. Railway keeps daily backups for 6 days, weekly for 27, monthly for 89 — enable
daily and monthly. To restore: find the backup by date in that tab, press **Restore**, review the
staged change on the project canvas, press **Deploy**.

**Off-platform (recommended as well).** Railway's backups live in the same account as the thing they
protect. Once a week, from any machine with `pg_dump` installed:

```bash
scripts/backup.sh "<DATABASE_PUBLIC_URL from Railway>" ~/getsecure-backups
# writes ~/getsecure-backups/getsecure-2026-09-21T0300.dump and keeps the newest 30
```

Keep those dumps somewhere that is not Railway. To restore one into a fresh database:

```bash
pg_restore --no-owner --no-privileges --clean --if-exists \
  -d "<connection string of the target database>" getsecure-2026-09-21T0300.dump
```

Then point `DATABASE_URL` at that database and redeploy. Migrations are idempotent, so the app starts
cleanly. Sign in, open **System status**, and press **Check for new email** — anything that arrived
after the backup is re-fetched from Titan, and duplicate detection stops it being imported twice.

**A backup is useless without `AUTH_SECRET` and `ENCRYPTION_KEY`.** Keep both in your password
manager. Without `ENCRYPTION_KEY` the restored mailbox password cannot be decrypted and you would
reconnect the mailbox by hand.

Test a restore once, into a scratch database, before you rely on it.

---

## 12. Health monitoring

- **`GET https://<your domain>/api/health`** returns `{"ok":true,"db":"up"}` and HTTP 200, or 503
  when the database is down. Point a free uptime monitor (UptimeRobot, Better Stack) at it every
  5 minutes. Railway also health-checks this URL on every deploy.
- **Detailed health**: the same URL with the header `Authorization: Bearer <HEALTH_TOKEN>` adds
  mailbox sync ages, how many emails are waiting to classify, when reminders last ran, the AI
  provider, and a `warnings` list.
- **In the app**: **Settings → System status** shows the same thing for admins.
- **Logs**: Railway → `web` → Deployments → Logs. `[ingest]` lines are mailbox activity. An
  `[ingest] … error` repeating every few minutes means the Titan password or third-party access needs
  attention.

Healthy looks like: database up, each mailbox checked within the last 30 minutes, fewer than 20
emails waiting to classify, reminders run within the last hour.

---

## 13. Rolling back a bad deployment

Railway → `web` service → **Deployments**. Find the last deployment that worked, open its menu and
choose **Rollback** (or **Redeploy**). It rebuilds and serves that exact version. Deployments older
than your plan's retention are not offered.

**The database does not roll back with the code.** Every migration so far only adds tables, columns
and values, so older code runs fine against a newer database — a code rollback is safe today. If a
future release removes or renames a column, roll the code back *and* restore the database from the
backup taken before that deploy (section 11), in that order.

If a deploy fails to build, the previous version keeps serving; Railway does not take the old one
down until the new one is healthy.

---

## Keeping secrets out of GitHub

Rules, and what enforces them:

- **Real values only ever live in Railway variables** (and your password manager). Never in a file in
  the repository.
- `.gitignore` ignores every `.env` file. The one committed example, `.env.example`, contains
  placeholders only and is what a new machine copies to make a local `.env`.
- **Titan passwords never touch the repo or the environment.** They are typed into the app and stored
  encrypted.
- `scripts/check-secrets.sh` fails the build if any `.env` file becomes tracked, if a file contains an
  Anthropic key, AWS key, GitHub token, Slack token or private key, or if `.env.example` gains a real
  value. It runs in CI on every push, and locally with `pnpm secrets:check`.
- The repository history has been checked and contains no committed credentials.

If a key is ever exposed: revoke it at the source first (Anthropic console, or Titan app passwords),
then replace the value in Railway. Rotating `ENCRYPTION_KEY` means reconnecting the mailbox; rotating
`AUTH_SECRET` signs everyone out.

---

## Quick reference

| Thing | Where |
| --- | --- |
| First login | `https://<domain>/` → `/setup` |
| Connect mailbox | Settings → Email accounts |
| AI status and smoke test | Settings → Email AI |
| Reminder thresholds, business hours | Settings → Reminders |
| Staff and roles | Settings → Staff |
| System status | Settings → System status |
| Health endpoint | `/api/health` |
| Longer mailbox notes | `docs/runbooks/titan-mailbox.md` |
| Longer checkpoint notes | `docs/runbooks/staging-checkpoint.md` |
| Backup and monitoring detail | `docs/runbooks/backup-and-monitoring.md` |
| Full variable reference | `docs/PRODUCTION_ENV.md` |
