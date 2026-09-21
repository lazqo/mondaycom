# Get Secure CRM — deployment handoff

Everything needed to put v0.4 into production on a **Hostinger VPS** and run it. One architecture,
no alternatives. Written for someone who has not seen the code.

You will need two things that only you can provide: a Hostinger VPS and the Titan mailbox app
password. There is no AI service to sign up for — the CRM runs with its built-in offline classifier
(section 9).

Every command below is run over SSH on the VPS, as root, from `/opt/getsecure`.

---

## 1. Hosting platform

**A single Hostinger KVM VPS running Docker.** Three containers on one machine, started by one
Compose file:

| Container | What it is | Why |
| --- | --- | --- |
| `web` | The CRM, built from the repo's `Dockerfile` | Serves the app **and** holds the live IMAP connection to Titan |
| `db` | PostgreSQL 16 | Holds every record, email, attachment and photo |
| `caddy` | Reverse proxy | HTTPS certificate, obtained and renewed automatically |

A VPS is the right fit because the CRM keeps a mailbox connection open permanently (IMAP IDLE) so
enquiries appear within seconds. That needs a process that stays alive, which is why **Vercel cannot
run this app** — its functions are frozen between requests, so the mailbox watcher would die on every
cold start and no email would ever be detected automatically.

**Plan: KVM 2** (2 vCPU, 8 GB RAM, 100 GB NVMe, about USD 9/month). KVM 1 (1 vCPU, 4 GB) also runs
the app fine, but the first Docker build takes noticeably longer on one core. Either is cheaper than
a managed platform, and this is the whole bill — there are no per-request or per-email costs.

**Run exactly one `web` container.** Never scale it. Two would mean two processes watching the same
mailbox.

What you take on by running a VPS: operating system updates, the firewall, and your own database
backups. Sections 11 and 12 cover those and are not optional.

---

## 2. Creating the server

1. Hostinger → **VPS** → buy a **KVM 2** plan.
2. When it asks for an operating system, choose the **Ubuntu 24.04 with Docker** application template.
   That installs Docker and Docker Compose for you. A plain Ubuntu 24.04 works too; you would then
   install Docker yourself from docs.docker.com.
3. Set the root password (or better, add your SSH key) during setup, and note the server's IP address.
4. **Point your domain at it.** In whatever manages DNS for `aucklandsecuritysystems.co.nz`, add an
   `A` record for `hermes` pointing to the VPS IP address. Wait until
   `ping hermes.aucklandsecuritysystems.co.nz` answers with that IP before doing section 3, because
   the HTTPS certificate cannot be issued until DNS resolves.
5. In hPanel → VPS → **Firewall**, allow inbound `22` (SSH), `80` (HTTP) and `443` (HTTPS), and
   nothing else. PostgreSQL must never be reachable from the internet; the Compose file already keeps
   it on an internal network only.

---

## 3. Installing the CRM

SSH in (`ssh root@<your VPS IP>`), then:

```bash
apt update && apt install -y git
git clone https://github.com/lazqo/mondaycom.git /opt/getsecure
cd /opt/getsecure
git checkout claude/pensive-wright-jjs01m     # or main, once this branch is merged

bash deploy/init-env.sh hermes.aucklandsecuritysystems.co.nz    # your domain
```

That writes `.env` with the four secrets generated on the server and permissions set to 600. It
never prints them and refuses to overwrite an existing `.env`. To fill the file in by hand instead,
`cp deploy/env.example .env && nano .env` and see section 4.

**Copy `AUTH_SECRET` and `ENCRYPTION_KEY` into your password manager now**, before you go further:

```bash
grep -E '^(AUTH_SECRET|ENCRYPTION_KEY)=' .env
```

Then start everything:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The first build takes a few minutes. It compiles the app, starts PostgreSQL, runs the database
migrations automatically, and brings up Caddy, which fetches a Let's Encrypt certificate for your
domain. Watch it with:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

You are ready when the `web` log prints `✓ Ready` followed by
`[ingest] email ingestion loop started`.

---

## 4. Environment variables

These live in `/opt/getsecure/.env` on the server. That file is listed in `.gitignore` and must never
be committed. `deploy/env.example` is the template you copied.

| Variable | Value to enter | Where it comes from |
| --- | --- | --- |
| `DOMAIN` | `hermes.aucklandsecuritysystems.co.nz` | Your domain from step 2.4. Caddy gets the certificate for exactly this name. |
| `APP_URL` | `https://hermes.aucklandsecuritysystems.co.nz` | The same name with `https://`. Used in links and staff notifications. |
| `POSTGRES_PASSWORD` | run `openssl rand -base64 32` | Generate on the server. The database password; nothing else needs to know it. |
| `AUTH_SECRET` | run `openssl rand -base64 32` | Generate on the server. Signs login cookies; changing it signs everyone out. |
| `ENCRYPTION_KEY` | run `openssl rand -base64 32` | Generate on the server. Encrypts the Titan mailbox password stored in the database. |
| `HEALTH_TOKEN` | run `openssl rand -hex 16` | Generate on the server. Lets an uptime monitor read detailed health. |
| `APP_TIMEZONE` | `Pacific/Auckland` | Fixed. Drives "Today", follow-up dates and business hours. |
| `AI_PROVIDER` | `rules` | Fixed. Built-in offline classifier. No external AI service, no per-email cost. |
| `AI_LEAD_CONFIDENCE_THRESHOLD` | `0.75` | Fixed. At or above this a lead is created automatically; below it goes to Needs review. |

`bash deploy/init-env.sh <domain>` in section 3 generates all four and sets the domain for you, so
you only fill these in by hand if you skipped it.

Store `AUTH_SECRET` and `ENCRYPTION_KEY` in a password manager. A database backup cannot be used
without them: the sessions and the saved mailbox password are tied to those two values.

**The Titan mailbox password is not in this file.** You enter it inside the app, where it is
encrypted before being stored (section 8).

`INGEST_IN_PROCESS`, `INGEST_POLL_SECONDS` and `PORT` are set by the Compose file; leave them alone.

---

## 5. Where the database lives

In the `db` container on the same VPS, with its data on a Docker volume named
`getsecure_pgdata`, which survives container rebuilds and reboots. It is **not** published to the
internet — only the `web` container can reach it, over Compose's internal network.

To open a database shell when you need one:

```bash
cd /opt/getsecure
docker compose -f docker-compose.prod.yml exec db psql -U getsecure -d getsecure
```

---

## 6. Where uploaded photos and email attachments are stored

**In the PostgreSQL database**, as binary columns (`job_photos.content`, `email_attachments.content`).
There is no S3 bucket, no separate file directory and no public file URL anywhere in the system.

This matters in three ways:

- **Access.** A file is only ever served through `/api/photos/…` or `/api/attachments/…`, which check
  your login session first. A signed-out request gets a 401, and there is no URL that shows a photo
  to someone without an account. Email attachments are sent with `Cache-Control: private, no-store`.
  Job photos use `private, max-age=3600` so a technician's phone does not re-download the same photo
  all day; that means a browser that already fetched a photo may still show it for up to an hour
  after the person's access is removed.
- **Backups.** Backing up the database backs up every photo and attachment. There is no second thing
  to back up.
- **Size.** Job photos will grow the database over time. `df -h` on the VPS and the backup file size
  tell you where you stand; at a few hundred photos this is not a concern on a 100 GB disk.

---

## 7. Deploying an update, and migrations

**Migrations run themselves.** The container runs pending database migrations on start
(`scripts/start.sh` calls `scripts/migrate.mjs` before the server boots), and they are idempotent, so
there is nothing to run by hand.

To deploy a new version:

```bash
cd /opt/getsecure
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

That rebuilds the app, applies any new migrations and restarts it. The database container is left
running and keeps its data. Expect under a minute of downtime while the new container starts.

To restart without rebuilding: `docker compose -f docker-compose.prod.yml restart web`.

---

## 8. First login, setup, and the Titan mailbox

Open `https://hermes.aucklandsecuritysystems.co.nz/` in a browser. With no users in the database it lands on
**`/setup`**.

1. **Create your admin login.** Name, email, password. This creates the first admin account and signs
   you in.
2. Work the six-step checklist, which ticks itself off as each thing is done:
   1. Admin login (done by step 1)
   2. Add staff — office people and technicians, each with a role
   3. Connect the Titan mailbox (below)
   4. Configure email AI — press **Use offline rules for now**; there is nothing else to set
   5. Set business hours and reminder thresholds
   6. Start using the CRM

**Do step 1 immediately after the first deploy.** Until the first admin exists, the create-admin form
is reachable by anyone who has the URL. Once a user exists the form is gone and `/setup` requires an
admin login. This is the only window, and it closes as soon as you create your account.

Roles: **Admin** sees everything including settings. **Office** sees the work but not settings.
**Technician** sees only My day, Customers, Jobs and Calendar — no inbox, no leads, no settings, no
mailbox configuration.

### Connecting Titan

In Titan webmail, once, as the mailbox that receives enquiries (`info@getsecure.co.nz`):

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

**Connect the mailbox customers actually write to. Do not forward into it** — see section 9.

The password is encrypted with `ENCRYPTION_KEY` before it is written to the database. It is never in
an environment variable, never in the repository and never shown again in the UI.

---

## 9. How enquiries are turned into leads (no AI service)

There is no Anthropic account, no API key and no per-email cost. `AI_PROVIDER=rules` uses the
classifier built into the app, which reads each new email and looks for:

- your services by keyword — CCTV, Ajax, alarm, access control, intercom, gate automation, and
  service or fault calls
- a New Zealand phone number, and a street address, by their shape
- enquiry intent — quote, price, install, book, site visit, how much, looking for
- urgency words — urgent, ASAP, today, emergency, break-in

It scores each email. At or above `AI_LEAD_CONFIDENCE_THRESHOLD` a lead is created on the board with
whatever it could extract; below that the email waits in **Needs review** for you to accept, edit or
reject. Newsletters, invoices, bounces and auto-replies are filtered out before any of this.

**Settings → Email AI** shows the active classifier and recent decisions. It will say the offline
rules classifier is in use, which is correct.

### The limitation you need to know about

**Forwarded enquiries lose their details.** If an enquiry is forwarded into the connected mailbox
rather than sent to it directly, the forward header cuts the message off before the classifier reads
it. Tested with a real forward:

```
Dave's original:  6 CCTV cameras, 12 Station Road Penrose, Ajax alarm quote, 021 555 0123

Lead the CRM creates:
  name          Get Secure Info
  email         info@getsecure.co.nz     <- your address, not Dave's
  phone         (empty)
  site address  (empty)
```

The lead is still created, because the subject line carries enough to score above the threshold, so
it does not stop in Needs review for you to catch. Replying to that lead from the CRM would email
your own info address rather than the customer.

**Nothing is lost.** The complete forwarded message, exactly as it arrived, is visible in the CRM
Inbox — open the thread and you can read all of Dave's text. Only the automatic field extraction
misses it.

**So, day to day:** for any enquiry that reached the CRM by forwarding, open the email in the Inbox
and correct the lead's name, email, phone and site address by hand before working it. Treat the
auto-filled fields on a forwarded lead as untrustworthy.

**The clean fix** is to connect `info@getsecure.co.nz` directly as the CRM mailbox, as section 8
says, instead of forwarding from it into another address. The customer's real address and full
message are then preserved and everything works as designed. That is a configuration change, not
code. Website landing-page enquiries have the same shape of problem: there is no form endpoint yet,
so they only arrive as whatever email the form service sends.

---

## 10. Verifying receive and reply

Do these in order, after the mailbox is connected. This is the staging checkpoint.

**IMAP receive.** From a personal address, send a realistic enquiry to the Titan mailbox — for
example: *"Hi, we need 6 CCTV cameras installed at our warehouse in Penrose, and a quote for an Ajax
alarm. Can someone come and look? — Dave, 021 555 0123."* Send it **directly**, not forwarded, for
this test. Within a minute it should appear in the CRM **Inbox**. If it does not, press **Check for
new email** and then look at **Settings → System status**.

**Classification.** Open that email in the Inbox. It should either have created a lead on the Leads
board with the service, phone and address filled in, or be waiting in **Needs review**. Either is a
pass — Needs review means the classifier was not confident, which is the behaviour you want.

**SMTP reply.** Open the thread in the CRM and write a reply. Send it. Three things must be true: the
reply arrives in your personal inbox, it appears threaded under the original message rather than as a
new conversation, and it shows on the CRM thread as an outbound message. What you type is exactly
what goes; the CRM never writes or sends anything to a customer on its own.

Then repeat the first test with a **forwarded** enquiry, so you see for yourself what section 9
describes before you rely on it.

If those pass, the system is live. `docs/runbooks/staging-checkpoint.md` has the longer version with
troubleshooting.

---

## 11. Backups and restore

You are running your own server, so backups are your responsibility. Do both of the following.

**Hostinger snapshots.** hPanel → VPS → **Backups**. Free weekly backups are included, plus manual
snapshots you can take before a risky change. These restore the whole machine. Take a manual snapshot
once the CRM is working, before you put real data in.

**Nightly database dumps, kept off the server.** A whole-machine weekly snapshot is not enough for
business records. The repo ships the script:

```bash
mkdir -p /opt/getsecure-backups
cd /opt/getsecure
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump --format=custom --no-owner --no-privileges -U getsecure getsecure \
  > /opt/getsecure-backups/getsecure-$(date -u +%Y-%m-%dT%H%M).dump
```

Put that on a nightly cron (`crontab -e`):

```
0 3 * * * cd /opt/getsecure && docker compose -f docker-compose.prod.yml exec -T db pg_dump --format=custom --no-owner --no-privileges -U getsecure getsecure > /opt/getsecure-backups/getsecure-$(date -u +\%Y-\%m-\%dT\%H\%M).dump 2>> /var/log/crm-backup.log
```

**Copy those dumps somewhere that is not this VPS** — your laptop, Google Drive, a NAS. A backup that
only exists on the machine it protects is not a backup. From your own computer:

```bash
scp root@<VPS IP>:/opt/getsecure-backups/*.dump ~/getsecure-backups/
```

**Restore** into the running stack:

```bash
cd /opt/getsecure
cat getsecure-2026-09-21T0300.dump | docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore --no-owner --no-privileges --clean --if-exists -U getsecure -d getsecure
docker compose -f docker-compose.prod.yml restart web
```

Then sign in, open **System status**, and press **Check for new email** — anything that arrived after
the backup is re-fetched from Titan, and duplicate detection stops it being imported twice.

**A backup is useless without `AUTH_SECRET` and `ENCRYPTION_KEY`.** Keep both in your password
manager. Without `ENCRYPTION_KEY` the restored mailbox password cannot be decrypted and you would
reconnect the mailbox by hand.

Test a restore once, before you rely on it.

---

## 12. Health monitoring and server upkeep

- **`GET https://hermes.aucklandsecuritysystems.co.nz/api/health`** returns `{"ok":true,"db":"up"}` and HTTP 200, or
  503 when the database is down. Point a free uptime monitor (UptimeRobot, Better Stack) at it every
  5 minutes. This is the single most valuable thing to set up, because it tells you the CRM is down
  before your staff do.
- **Detailed health**: the same URL with the header `Authorization: Bearer <HEALTH_TOKEN>` adds
  mailbox sync ages, how many emails are waiting to classify, when reminders last ran and a
  `warnings` list.
- **In the app**: **Settings → System status**, for admins.
- **Logs**: `docker compose -f docker-compose.prod.yml logs -f web`. `[ingest]` lines are mailbox
  activity. An `[ingest] … error` repeating every few minutes means the Titan password or
  third-party access needs attention.
- **Containers restart themselves** after a crash or a reboot (`restart: unless-stopped`).
- **Patch the server monthly**: `apt update && apt upgrade -y && reboot`. The stack comes back up on
  its own.

Healthy looks like: database up, each mailbox checked within the last 30 minutes, fewer than 20
emails waiting to classify, reminders run within the last hour.

---

## 13. Rolling back a bad deployment

The previous version is the previous git commit, so rolling back is checking it out and rebuilding:

```bash
cd /opt/getsecure
git log --oneline -5             # find the commit that was working
git checkout <that commit>
docker compose -f docker-compose.prod.yml up -d --build
```

**The database does not roll back with the code.** Every migration so far only adds tables, columns
and values, so older code runs fine against a newer database and a code rollback alone is safe. If a
future release removes or renames a column, roll the code back *and* restore the database from the
dump taken before that deploy (section 11), in that order.

If something worse happens — a broken server rather than a bad build — restore the Hostinger snapshot
from hPanel, which returns the whole machine to that point.

---

## Keeping secrets out of GitHub

Rules, and what enforces them:

- **Real values only ever live in `/opt/getsecure/.env` on the server** and in your password manager.
  Never in a file in the repository.
- `.gitignore` ignores every `.env` file. The committed templates, `.env.example` and
  `deploy/env.example`, contain placeholders only.
- **Titan passwords never touch the repo or the environment file.** They are typed into the app and
  stored encrypted.
- `scripts/check-secrets.sh` fails the build if any `.env` file becomes tracked, if a file contains an
  Anthropic key, AWS key, GitHub token, Slack token or private key, or if `.env.example` gains a real
  value. It runs in CI on every push, and locally with `pnpm secrets:check`.
- The repository history has been checked and contains no committed credentials.

If a credential is ever exposed: revoke it at the source first (Titan app passwords), then replace the
value in `.env` and restart. Rotating `ENCRYPTION_KEY` means reconnecting the mailbox; rotating
`AUTH_SECRET` signs everyone out.

---

## Quick reference

| Thing | Where |
| --- | --- |
| SSH in | `ssh root@<VPS IP>`, then `cd /opt/getsecure` |
| Create `.env` with fresh secrets | `bash deploy/init-env.sh hermes.aucklandsecuritysystems.co.nz` |
| Start / update | `docker compose -f docker-compose.prod.yml up -d --build` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f web` |
| Restart the app only | `docker compose -f docker-compose.prod.yml restart web` |
| Database shell | `docker compose -f docker-compose.prod.yml exec db psql -U getsecure -d getsecure` |
| First login | `https://hermes.aucklandsecuritysystems.co.nz/` → `/setup` |
| Connect mailbox | Settings → Email accounts |
| Classifier status | Settings → Email AI |
| Reminder thresholds, business hours | Settings → Reminders |
| Staff and roles | Settings → Staff |
| System status | Settings → System status |
| Health endpoint | `/api/health` |
| Longer mailbox notes | `docs/runbooks/titan-mailbox.md` |
| Longer checkpoint notes | `docs/runbooks/staging-checkpoint.md` |
| Backup and monitoring detail | `docs/runbooks/backup-and-monitoring.md` |
| Full variable reference | `docs/PRODUCTION_ENV.md` |
