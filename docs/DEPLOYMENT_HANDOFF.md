# Get Secure CRM — deployment handoff

Everything needed to put v0.4 into production on a **Hostinger VPS** and run it. One architecture,
no alternatives. Written for someone who has not seen the code.

You will need two things that only you can provide: a Hostinger VPS and the Titan mailbox app
password. Hermes (Get Secure's own agent, section 17) reads every email and conversation; there
is no other AI service to sign up for.

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

**The "Vercel" check on GitHub is not this deployment.** A Vercel project
(`chris-projects-ae98c80a/mondaycom`) is still connected to the repository from earlier, so Vercel
tried to build every push and reported "Deployment has failed" next to the green CI tick. It has
failed on every commit and never served the CRM. `vercel.json` now turns Vercel's Git deployments
off, so new pushes should no longer produce a Vercel failure. To remove it entirely: Vercel
dashboard → the `mondaycom` project → Settings → Git → Disconnect (or delete the project). The only
checks that matter are **GitHub Actions → CI** and the server itself (section 12).

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
| `POSTGRES_PASSWORD` | run `openssl rand -hex 32` | Generate on the server. The database password; nothing else needs to know it. Hex only: it goes inside the database URL, where `/`, `+` and `=` break it. |
| `AUTH_SECRET` | run `openssl rand -base64 32` | Generate on the server. Signs login cookies; changing it signs everyone out. |
| `ENCRYPTION_KEY` | run `openssl rand -base64 32` | Generate on the server. Encrypts the Titan mailbox and calendar passwords stored in the database. |
| `HEALTH_TOKEN` | run `openssl rand -hex 16` | Generate on the server. Lets an uptime monitor read detailed health. |
| `APP_TIMEZONE` | `Pacific/Auckland` | Fixed. Drives "Today", follow-up dates and business hours. |
| `CALENDAR_SYNC_SECONDS` | `300` | Optional. How often Titan calendar changes are checked for. CRM changes go out straight away. |

`bash deploy/init-env.sh <domain>` in section 3 generates all four and sets the domain for you, so
you only fill these in by hand if you skipped it.

Store `AUTH_SECRET` and `ENCRYPTION_KEY` in a password manager. A database backup cannot be used
without them: the sessions and the saved mailbox and calendar passwords are tied to those two values.

**The Titan mailbox and calendar passwords are not in this file.** You enter them inside the app,
where they are encrypted before being stored (section 8).

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

**In the PostgreSQL database**, as binary columns (`job_photos.content`, `email_attachments.content`,
and for proposals `catalogue_images.content` and `quote_documents.content`).
There is no S3 bucket, no separate file directory and no public file URL anywhere in the system.

This matters in three ways:

- **Access.** A file is only ever served through `/api/photos/…`, `/api/attachments/…`,
  `/api/catalogue-images/…`, `/api/quotes/…/proposal` or `/api/quote-documents/…`, which check your
  login session first (proposal PDFs: office staff only). A signed-out request gets a 401, and there is no URL that shows a photo
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

**Check what is running:**

```bash
cd /opt/getsecure && git log -1 --oneline        # the code on the server
curl -s https://hermes.aucklandsecuritysystems.co.nz/api/health   # "version" = the commit the app was built from
```

(`version` is empty for builds made before `APP_VERSION` was set at build time; the update script
below sets it.)

**To deploy a new version** (backs up the database first, then pulls, rebuilds, waits for health
and prints the deployed commit):

```bash
cd /opt/getsecure
./deploy/update.sh
```

The same by hand:

```bash
cd /opt/getsecure
git pull --ff-only
APP_VERSION=$(git rev-parse --short HEAD) docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs web --tail 50   # look for "Migrations complete."
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
   5. Set business hours and the next-step checklist timings
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

**Sent mail.** "Also sync sent mail" is on by default. The CRM then also reads the mailbox's Sent
folder, so emails you send from Titan webmail, your phone or Outlook show on the right lead and
customer timeline, not only replies written in the CRM. Replies are matched to their conversation by
Message-ID, In-Reply-To and References; new emails by recipient. Messages the CRM sent itself are
recognised when their copy turns up in Sent and are not stored twice. This uses one more IMAP
connection (the Sent folder is watched with IDLE, like the inbox), and the first sync reads the last
14 days of Sent.

**Connect the mailbox customers actually write to. Do not forward into it** — see section 9.

The password is encrypted with `ENCRYPTION_KEY` before it is written to the database. It is never in
an environment variable, never in the repository and never shown again in the UI.

### Connecting the Titan calendar

The CRM calendar and the Titan calendar of `chris@getsecure.co.nz` stay in step both ways over
CalDAV. Site visits, jobs and appointments made in the CRM appear in Titan, and so on any phone or
computer showing that calendar. Events added, moved or deleted in Titan appear, move or disappear in
the CRM.

As an admin, **Settings → Calendar sync**:

1. Calendar server: `https://dav.flockmail.com` (pre-filled; EU-hosted Titan accounts use
   `https://dav-eu.titan.email`).
2. Username: the full address, `chris@getsecure.co.nz`. Password: the same password or app password
   used for the mailbox.
3. **Find calendars**, choose the calendar, tick which CRM events to copy (all three by default),
   then **Connect calendar**. The first sync copies existing upcoming CRM events across.

How it behaves:

- Each CRM event has a fixed ID in the calendar, so it is updated in place and never created twice.
- An event made in the CRM keeps its link: clicking it in the CRM calendar opens the lead, customer
  or job, and the Titan copy has an "Open in Get Secure CRM" link in its notes.
- Moving a site visit or job in Titan moves it in the CRM and is noted on the lead or job timeline.
  Deleting a job's event in Titan puts the job back to unscheduled.
- If both sides changed the same event, the later change wins.
- Repeating events from Titan show each occurrence in the CRM, read-only; change them in Titan.
- Titan changes are picked up every 5 minutes (`CALENDAR_SYNC_SECONDS`). A check where nothing
  changed is a single small request. **Sync now** checks immediately.

The calendar password is encrypted with `ENCRYPTION_KEY`, exactly like the mailbox password.

---

## 9. How enquiries are turned into leads (Hermes reads every email)

There is no separate email classifier any more, no Anthropic account and no API key. The CRM does
only the mechanical part of filing a new email:

- mail on a thread already linked to a lead, customer or job is filed there ("Existing");
- mail from a sender whose email address is a customer's, or an open lead's, is filed on that lead
  ("Existing");
- newsletters, bulk mail, bounces and auto-replies are filed as "Not a lead" and never read
  (section 17 lists the exact headers);
- website form enquiries are read field by field and become a lead straight away (below);
- everything else is marked **Hermes is reading** and handed to Hermes.

Hermes decides whether it is a lead, and the lead is created from Hermes's reading of the email:
the name, phone, site address and service it found (each checked against the words of the email),
its summary of what the customer wants, and the next step it recommends. If Hermes is not sure
enough to call it a lead, the email waits on **Home → Hermes needs you to decide** ("Hermes thinks
this is a lead": Make it a lead / Not a lead). If Hermes says it is not a lead (a supplier, a
provider, a statement), it is filed as "Not a lead" with whatever internal task it needs, and you
can still make it a lead from the Inbox. Section 17 has the details and the audit trail.

If Hermes is not connected or cannot be reached, nothing is invented from the words: the email
waits in **Needs review** as "Hermes could not read it", and is read again when Hermes is back.

### Website enquiries

Mail from the website's sending address (`noreply@updates.getsecure.co.nz`, or whatever
`LEAD_SENDER_ADDRESSES` lists) skips all of the above. The form is read field by field, and every
enquiry becomes its own conversation and its own lead with the enquirer's name, phone and email.
That address never belongs to a customer: the CRM refuses to save it on a customer or lead.

Website enquiries that arrived before this was in place may be filed on the wrong customer. Run the
repair once after updating. The first command only lists what it would change. The second command
makes those changes. Nothing is deleted, and running it again is safe:

```bash
cd /opt/getsecure
docker compose -f docker-compose.prod.yml exec -T web node_modules/.bin/tsx scripts/repair-website-leads.ts
docker compose -f docker-compose.prod.yml exec -T web node_modules/.bin/tsx scripts/repair-website-leads.ts --apply
```

### The limitation you need to know about

**Forwarded enquiries lose their sender.** If an enquiry is forwarded into the connected mailbox
rather than sent to it directly, the sender the CRM sees is your own address, and the customer's
details are only in the forwarded text. Tested with a real forward (before Hermes read email):

```
Dave's original:  6 CCTV cameras, 12 Station Road Penrose, Ajax alarm quote, 021 555 0123

Lead the CRM creates:
  name          Get Secure Info
  email         info@getsecure.co.nz     <- your address, not Dave's
  phone         (empty)
  site address  (empty)
```

Hermes now reads the forwarded text and uses the customer's name, phone and address it finds there
(each checked against the words), so a forwarded lead is usually filled in correctly. The sender's
address is still the forwarder's: replying to that lead from the CRM would email your own info
address rather than the customer, so check the email field before replying.

**Nothing is lost.** The complete forwarded message, exactly as it arrived, is visible in the CRM
Inbox — open the thread and you can read all of Dave's text. Only the automatic field extraction
misses it.

**So, day to day:** for any enquiry that reached the CRM by forwarding, check the lead's email
address (and anything Hermes left blank) before working it.

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
pass — Needs review means Hermes was not sure enough (or is not connected yet), which is the
behaviour you want.

**SMTP reply.** Open the thread in the CRM and write a reply. Send it. Three things must be true: the
reply arrives in your personal inbox, it appears threaded under the original message rather than as a
new conversation, and it shows on the CRM thread as an outbound message. What you type is exactly
what goes; the CRM never writes or sends anything to a customer on its own.

**Sent from outside the CRM.** From Titan webmail or your phone, reply to the test enquiry and also
send a new email to the same person. Within a minute (or after **Check for new email**) both show on
that lead's timeline marked "Sent from Titan". The reply from the CRM shows once, marked "Sent from
the CRM".

**Calendar.** Book a site visit on the lead. Within a few seconds it is in the Titan calendar on your
phone. Move it in Titan, press **Sync now** in Settings → Calendar sync, and the CRM shows the new
time.

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
business records. The repo ships the script `deploy/backup.sh`:
- it takes one `pg_dump` to `/opt/getsecure-backups/getsecure-<date>.dump`;
- it checks the dump is not empty;
- it keeps only the newest 14 nightly dumps on the server. Set `KEEP_NIGHTLY_BACKUPS` to change
  that.

Put it on a nightly cron (`crontab -e`):

```
0 3 * * * /opt/getsecure/deploy/backup.sh >> /var/log/crm-backup.log 2>&1
```

If you already have the older one-line `pg_dump` cron, replace it with this line: the old one never
deletes anything.

**Disk housekeeping.** `./deploy/update.sh` cleans up after itself:
- It keeps the newest 5 `pre-update-*.dump` backups. Set `KEEP_UPDATE_BACKUPS` to change that.
- After a healthy deploy only, it removes unused Docker images and build cache unused for a day.
  The running images are never touched.
- It prints the disk use at the end.

Container logs are capped at 3 × 10 MB per container (`docker-compose.prod.yml`). To see what uses
space: `df -h /`, `docker system df` and `du -sh /opt/getsecure-backups`. To clear the build cache
by hand at any time (safe while running): `docker builder prune -af`.

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
  mailbox sync ages, how many emails are waiting to classify, when the next-steps checklist last ran and a
  `warnings` list.
- **In the app**: **Settings → System status**, for admins.
- **Logs**: `docker compose -f docker-compose.prod.yml logs -f web`. `[ingest]` lines are mailbox
  activity. An `[ingest] … error` repeating every few minutes means the Titan password or
  third-party access needs attention.
- **Containers restart themselves** after a crash or a reboot (`restart: unless-stopped`).
- **Patch the server monthly**: `apt update && apt upgrade -y && reboot`. The stack comes back up on
  its own.

Healthy looks like: database up, each mailbox checked within the last 30 minutes, fewer than 20
emails waiting to classify, the next-steps checklist run within the last hour.

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

## 14. CCTV Business Brain (v0.3)

The Business Brain works out a CCTV system for a lead — cameras, recorder, storage, network,
materials, labour and price — with fixed rules, not AI. It **prepares** reply drafts and quotes for
Chris; it never sends, books or promises anything.

**Where it is**

- **Lead → CCTV assessment**: check the enquiry details, press **Run assessment**, read the decision
  packet, then **Prepare reply draft** / **Prepare quote**.
- **Approvals** (left menu): every prepared email and quote waits here. Only an approver can approve,
  and only an approved email can be sent. Changing anything after approval takes the approval away.
  Saving a draft never marks the lead as Contacted. **Put in Titan Drafts** copies a draft into the
  Titan Drafts folder if Chris prefers to send from Titan; the CRM notices when it goes out.
- **Settings → Business Brain**: rules; products, supplier listings and compatibility; suppliers and
  brand routing; installation packages and standard materials.
- **Settings → Staff → Approver**: who may approve and send. The first admin (and every admin that
  existed when this update was deployed) is an approver; only an approver can change this column.

**What the update puts in (nothing priced, nothing approved on Chris's behalf)**

- **Suppliers**: IT Plus (default), Clear Digital, SWL / Security Wholesale, Atlas Gentech, IOT
  Technologies, Vesta Electrical: the current, active list. Play Digital and Dicker Data (older,
  provisional v0.1 information) are kept only as deprecated history and are never quoted from.
- **Brand routing** (Suppliers & routing tab): VIGI/HiLook/TVT/AAP → IT Plus; Hikvision → IT Plus,
  Atlas for commercial; Tiandy → IOT; Dahua/Ajax → Clear Digital then IOT; Uniview → IT Plus, Clear
  Digital, IOT; Axis/Hanwha/Inner Range → Atlas; Akuvox → IT Plus then IOT; Gallagher/Aiphone →
  Clear Digital; Provision-ISR → SWL. Editable. A quote uses the preferred supplier's approved price,
  then the next route, then the default supplier.
- **Reference catalogue**: real products with specifications read from the manufacturer's own pages
  and datasheets (source link and date on every product): TP-Link VIGI, HiLook, Hikvision, TVT,
  Dahua, Tiandy, Uniview and Ajax for residential; Axis and Hanwha as the commercial catalogue;
  WD Purple / Purple Pro and Seagate SkyHawk / SkyHawk AI drives from 2 to 12 TB; documented junction
  boxes, brackets and kits. Anything the source does not publish is left blank and listed on the
  product as "not published by the source". It is added once: a product Chris deletes or edits is
  never re-added or overwritten. Tiers are set by family (VIGI good; HiLook, Dahua, Tiandy better;
  Hikvision best; Ajax premium) and marked provisional for Chris to confirm per product; TVT and
  Uniview have no tier yet. Research files: `data/catalogue-research/`.
- **Standard materials contents**: Cat6, connectors, clips and fixings, weatherproofing, misc
  (Installation & materials tab). Their cost is entered per installation package (v0.3, below).

**v0.3 real costing**

- **Approved kits** (Settings → Business Brain → Kits) replace recording profiles. A kit is Get
  Secure's standard system for an exact camera count and market (and tier): cameras + recorder +
  default HDD + relevant accessories. An approved kit is used automatically for a matching job;
  the installation package stays separate. See "CCTV kits and the HDD" below.
- **Installation packages** are keyed by an exact camera count: RES_CCTV_SINGLE_2/4/6/8 and
  RES_CCTV_DOUBLE_2/4/6/8. A 3, 5 or 7 camera job is a **custom installation** and is never
  mapped to a package. Each package has labour hours, internal rate ($95/h residential), standard
  material cost, conduit and complexity allowances (internal costs) and the customer sell
  allowance. The customer sees one line: "Installation, commissioning, cabling and standard
  installation materials".
- **Costing**: hardware at approved trade cost from the preferred supplier route (alternatives
  shown), marked up at the provisional 25% unless Chris overrides it; installation at the package
  sell allowance. The internal view shows hardware cost, supplier, freshness, labour hours and
  cost, materials, conduit/complexity, markup, sell ex GST, GST, total, gross profit, gross margin,
  missing lines and assumptions. None of it appears on the customer quote or email.
- **Snapshot and reprice**: a prepared quote freezes every line's model, supplier, SKU, cost, price
  date, markup, labour, materials and sell. Supplier changes never alter it. **Reprice with current
  prices** (quote page) re-runs it and sends it back to Needs Review.
- **Trade prices only**: an import must be confirmed as Get Secure trade pricing; RRP/retail
  columns are never read as cost.

**What Chris must enter and approve before the first fully priced quote**

1. **Kits** — for the systems you quote (e.g. VIGI Good, 4 and 6 cameras): camera, recorder and
   default HDD; then approve. Without a kit, products come from the catalogue and the HDD from the
   residential fallback (or must be chosen).
2. **Supplier trade prices** — for the cameras, recorders and drives you quote (CSV import or
   manual entry), then approve them. Stale (>30 days) or undated prices block quote approval.
3. **Installation packages** — for each of the eight: labour hours, standard material cost,
   complexity allowance (0 if none), conduit allowance (double storey) and the customer sell
   allowance; then approve.
4. **Markup** — confirm or replace the provisional 25% (Rules → suggestedMarkupPct); price bands
   are not set.
5. **Tiers and products** — confirm the provisional tier on the products you will quote.

Until these are in, assessments still run and show "Not fully priced" with exactly what is missing.

**Ready to quote checklist.** Every assessment opens with a checklist of what must be entered and
approved for the price to stand. For each item it shows ✓ or ✗, what's missing, and where to fix it:
- approved, current supplier prices for every hardware line;
- an HDD selected (Chris's choice, the kit default or the fallback), with an approved price;
- the recorder passing its checks;
- which approved kit was used (for information);
- the exact installation package, with every value entered and approved;
- the hardware markup decided by Chris (the assessment's markup override, or an approved rule);
- the camera tier approved;
- products verified or approved;
- the rules the quote relies on (price freshness, junction-box surfaces, GST) approved.

A Business Brain quote that is **Not fully priced cannot be approved**. Neither can one with stale
prices. The quote's approval panel lists any input that is still provisional.

**Supplier logins** typed under Suppliers are stored encrypted with `ENCRYPTION_KEY`, are never shown again
and are not available to any agent: only the supplier price-sync process or an approver can read them. Price
sources: manual entry, CSV import, price on application, and the **IT Plus trade-login connector**
(section 15). Other suppliers' connectors are not written yet. **Hermes is not connected**; the code refuses any customer-facing
action (sending, confirming, discounting, accepting) that is not done by an approver.

**Rollback note:** this update makes a quote's customer optional (Brain quotes can exist before the
lead is converted). Rolling the code back past it is still safe, but delete any Brain-prepared quotes
without a customer first: `docker compose -f docker-compose.prod.yml exec db psql -U getsecure -d getsecure -c "delete from quotes where contact_id is null"`.

### CCTV upgrades

When the assessment's **Job** is **Upgrade**, it asks about the existing system:
- type (IP/PoE, analogue/coax, mixed);
- recorder, camera count, cable type and condition;
- whether the existing camera locations suit;
- existing PoE, local power or baluns;
- how many cameras reuse an existing position, need a new position and cable, or are still to confirm.

The existing cabling decides the installation package:

| Existing cabling | Installation |
|---|---|
| Cat5e/Cat6, **reusable**, cameras in existing positions | `RES_CCTV_UPGRADE_IP_2/4/6/8` (runs kept, subject to testing and re-termination) |
| Coax | Never assumed reusable for PoE/IP. Chris decides: **replace with Cat6** for the IP system (priced as a new installation) or **keep the coax** with coax-compatible technology (needs its own design; not quoted). Until decided, it is priced as a new installation and the decision is flagged. |
| Damaged, not reusable, or other cable | Normal new-install package |
| Type or reusability **unknown / needs testing** | "Existing cabling must be confirmed before upgrade labour savings can be applied." The hardware is still prepared; installation stays unresolved (Not fully priced). The exception is when Chris has approved the rule "Upgrade with unconfirmed cabling" = `"new_install"`: then the new-install package is used as the conservative assumption. |
| Some positions reused and some new (mixed) | No package yet: installation needs Chris's calculation (shown as a custom installation) |
| All positions new | Normal new-install package |

The four upgrade packages exist with no values. Labour hours, materials, complexity and the
customer sell allowance are Get Secure's to enter, then approve, under Installation & materials.
Camera counts other than 2/4/6/8 are custom installations, as for new installs.

### CCTV kits and the HDD

Recording profiles have been removed. No design bitrate, retention target, storage headroom or
usable-capacity rule is used anywhere: the HDD is **chosen, not calculated**. Old recording-profile
rows stay in the database as history, but nothing reads them. The retired sizing rules are no longer
shown under Rules.

**Which HDD a quote uses**, in order:

1. **Chris's choice on the assessment.** The **HDD** field defaults to "Use kit HDD". Chris can pick
   a capacity (1/2/4/6/8 TB and any capacity in the catalogue) or a specific drive.
2. **The approved kit's default HDD**, set per kit in Settings → Kits. This is either a capacity or
   a specific drive. It is never resized.
3. **Residential only, with no kit HDD:** the fallback by camera count (Rules → "Residential
   default HDD by camera count"):

   | Cameras | Fallback |
   |---|---|
   | 2–4 | 2 TB |
   | 5–10 | 4 TB |

   The fallback never replaces a kit's HDD.
4. **Otherwise: HDD selection required.** The quote is not ready until Chris chooses one.

**Pricing.** The selected drive needs an approved product, an approved supplier SKU and a current
cost. If any of these is missing, the quote is **Not fully priced**. Another capacity is never
substituted because it happens to have a price.

**Recorder checks are unchanged.** The engine still checks channels, PoE ports, the PoE budget,
resolution and decoding, compatibility, the maximum HDD capacity the recorder supports, and
features. Bandwidth uses the cameras' **published maximum** bitrates:
- If the total is over the recorder's incoming limit, the assessment shows a warning ("set camera
  bitrates below maximum"). The recorder is not rejected.
- If a camera publishes no maximum, bandwidth shows as not verifiable.

**Retention.** It is never calculated or promised. Customer emails and quotes say: "Recording
duration depends on camera settings, recording configuration and scene activity." A customer who
asks for a specific number of days is a **custom requirement**. The assessment flags it for Chris,
who chooses an HDD to suit or designs it.

**Commercial CCTV** follows the same principle: a commercial kit or Chris's HDD choice, with no
profile system. A site visit is still required.

### Later: Alarm Brain (notes only, not built)

- AAP / Arrowhead is Get Secure's default wired alarm upgrade/replacement path where existing
  cabling can be reused.
- Preferred suppliers for AAP / Arrowhead: Vesta Electrical and IT Plus.

## 15. Supplier trade-login connectors (IT Plus, Clear Digital, SWL, Vesta Electrical)

Four suppliers price from their own websites behind Get Secure's trade login. One runner
(`src/lib/brain/suppliers/connector.ts`) drives a site module each:

| Supplier | Website | Platform | Sign-in | Where the code lives |
| --- | --- | --- | --- | --- |
| IT Plus | www.itplus.co.nz | WooCommerce ("Login to see prices") | `/my-account/` form with nonce | `itplus.ts` |
| Clear Digital | www.cleardigital.co.nz | custom shop ("Login for pricing", stock hidden) | `/members/login.php`, email + password | `cleardigital.ts` |
| SWL / Security Wholesale | www.swl.co.nz | WebNinja B2B ("POA" for guests) | `/login`, CSRF token + email + password | `webninja.ts` |
| Vesta Electrical | www.vestaelectrical.co.nz | WebNinja B2B ("POA" for guests) | `/login`, CSRF token + email + password | `webninja.ts` |

Each connector logs in with the login stored under **Settings → Business Brain → Suppliers &
routing** (encrypted; entered once by Chris, never pasted anywhere else) and reads Get Secure's
trade price from the logged-in product page. The same rules hold for all four: the only cost ever
read is an unambiguous price on a verified logged-in page with a known GST basis (a "+ GST" /
"ex GST" / "inc GST" label by the price, or the page's own "All prices exclude GST" note, or the
basis seen on that supplier's earlier logged-in pages); the page's code must be the listing asked
for; "POA", RRP, "was/now", ranges and two prices are reported, not recorded; a public figure
(IT Plus's product API, Clear Digital's Open Graph meta, a guest "POA" page) is never used;
CAPTCHA, two-factor and challenge pages stop the run; failure reasons are fixed text that never
carries the username, password or a cookie. Matching: an exact model/SKU match on the listing's
code, its model field, or the model written as one word of its name (SWL's own codes are stock
numbers, so its listings match on the name); anything closer than that is offered for Chris to
choose. Everything is run from **Settings → Business Brain → Supplier pricing**, one card per
supplier:

- **Test connection** — logs in and checks one mapped product page shows a price. Records nothing.
- **Refresh one product** (pick any catalogue product; the connector finds its listing),
  **Refresh selected**, and **Refresh … priced catalogue** (every product with a listing there).
- Status: connector state, last successful / failed login (with the reason), last successful /
  failed price sync, whether the supplier shows prices ex or inc GST, recent runs and their
  results, and each listing's price history.

**First run on a new connector.** Store the login, press **Test connection**, and read the message:
it says whether the sign-in worked and, once a product is mapped, what the sample page's price
text was and how it was read. If a price is reported as "does not say whether the price is ex or
inc GST", the site shows prices without a label and without a site-wide note: tell the developer
the exact price text shown on the card and the connector is taught that site's wording. Nothing is
recorded until a price is read with confidence.

**How prices are approved (Run F).** The top of the Supplier pricing tab is Chris's choice for
every connected supplier. With "Approve logged-in supplier prices automatically" on, a price read
while logged in, for a product already matched and priced at that supplier, becomes the approved
trade cost at once when the change is within the threshold ("Hold a change bigger than N% for
review", default 20). The first price ever seen for a product, a bigger jump, and any public or
retail price still wait for Chris. A refresh never changes a quote already prepared (a reprice
picks the new cost up). The switch is off by default, and every change to it is logged. The same
card lists the retailers Get Secure buys from when no supplier stocks an item (PB Tech, Noel
Leeming, Harvey Norman and Bunnings by default): the research profile may quote their retail
price, picture and availability as a retail price, never as a trade cost. The approval rule
applies to every connected supplier (IT Plus, Clear Digital, SWL, Vesta Electrical) alike.

What the IT Plus connector in particular will and won't do (the others follow the same rules
with their own page markup):

- **When a price is recorded**: the session is verified as logged in, the page's SKU is the listing
  asked for, the price is read from that logged-in page, its GST basis is clear, and there is no
  RRP/retail/"was" ambiguity. If all of those hold, it is recorded, even when the amount happens to
  equal a public figure.
- **The public feed never decides anything about price.** IT Plus's public product API also carries a
  price; the connector uses that API only to find SKUs, page addresses and listing descriptions, and
  throws its price away. It is never compared with, or used to accept or reject, the logged-in price.
- **Nothing ambiguous is recorded**: a page with two prices, a range, an RRP/retail label, "was/now"
  wording or a struck-through price without exactly one current price, a SKU that doesn't match, or
  no GST indication is reported with the reason. A normal sale (one struck-through and one current
  price) records the current price and shows "sale price; was $…". A bundle's "From:" price is read
  only when every bundled extra is optional (then it is the product alone).
- **GST**: IT Plus shows "+ GST"; prices are stored ex GST (an inc-GST price would be converted).
- **Matching**: only an exact model/SKU match is automatic. Where IT Plus has several close listings,
  nothing is chosen: the result shows each one with IT Plus's own description, stock and notes, and
  you pick the purchasing SKU. For WD Purple drives IT Plus lists `-SUP` ("Supply Only") and `-Inst`
  ("Price Including Installation In a Recorder"). Their notes say the drive supplied may be a WD
  Purple or an equivalent Seagate SkyHawk depending on stock, HDD orders can be cancelled and final
  pricing is IT Plus's decision.
- **Review**: a new price waits for Chris's approval; any change to an approved cost (even 1c) is
  held as pending, and the quoted cost stays the approved one until it is approved. An unchanged
  price just refreshes the price date. History keeps every change with its stock and run.
- **Quotes**: a refresh never changes a prepared quote (quotes keep their price snapshot); use
  **Reprice** on the quote to use current approved prices.
- **Stops, never bypasses**: a CAPTCHA, a two-factor / verification code prompt, a Cloudflare
  security check, or rate limiting stops the run and is reported. A rejected login is not retried
  automatically until the stored login is changed (repeated failures can lock the account); Test
  connection always tries.
- **Secrets**: the login is decrypted only inside the run; the username, password and IT Plus
  session cookies are never stored outside the encrypted credential, logged, shown in the UI,
  written into run results or given to any agent. Login failures are reported as fixed reasons
  (IT Plus's own message can quote the username, so it is never passed on).

Products for the first real 4-camera VIGI system at IT Plus: **VIGI InSight S455(2.8mm)** (IT Plus
stocks the InSight S range, not the C340/C350/C445/C455 in the catalogue), **VIGI NVR1004H-4P**, a
**WD Purple** drive (choose `-SUP` or `-Inst`) and the **VJB-240** junction box (documented for the
S455; recommended on brick/concrete and not charged until Chris confirms it).

---

## 16. Branded PDF proposals

When Chris approves a Business Brain quote, the CRM makes a branded Get Secure PDF from exactly what he
approved, stores it, and attaches it to the prepared email for that lead. **Nothing is sent.** The
email still needs Chris's approval and his Send, as before.

```
Business Brain prepares the quote → Chris reviews → Chris approves the quote
  → the CRM makes the PDF from the approved quote (stored; nothing sent)
  → the prepared customer email carries the PDF
  → Chris approves the email, then sends it (separately)
```

**What is on it** (A4, normally 2 pages for a residential quote):
- **Header and cover:** the Get Secure logo (from getsecure.co.nz), the forest green / sage / beige
  palette and the website's typefaces (Outfit and Inter).
- **Customer details:** name, site address, quote number, date and validity date (30 days by default).
- **Recommendation:** a short summary built from the approved lines (camera count, areas covered,
  recorder, storage), with the total investment.
- **"Your system":** a card for each main product (cameras, recorder, drive). Each card has the photo,
  customer name, model in small text, quantity, one-line description and 2–4 highlights. Small
  accessories such as junction boxes are listed but get no card.
- **Installation:** the installation line and what it includes.
- **Investment summary:** every approved line with its quantity, then subtotal ex GST, GST and total
  inc GST. There are no per-line prices (decided: quantities and the approved totals only).
- **"Good to know":** the quote's assumptions, exclusions and notes, plus "Recording duration depends
  on camera settings, recording configuration and scene activity." There is no number of days.
- **Closing:** warranty and support, next steps, and contact details in the footer of every page.
- **Company identity:** customers see **Get Secure Ltd**. The footer also carries, in small print,
  "Get Secure Ltd is a trading name of GE Secure Limited".

**Never on it:**
- supplier, supplier SKU or trade cost;
- markup, gross profit or margin;
- labour hours or rate;
- complexity or other internal allowances.

The PDF's data is built from the quote's customer lines and each product's customer content only, and
the tests check that none of these fields appear.

**Validity and invalidation.** A PDF is tied to the quote's approval fingerprint. If the quote is
repriced, edited, sent back for review or superseded:
- The PDF is voided and can no longer be downloaded as current.
- An approved email carrying it goes back to Ready for review.
- That email cannot be approved or sent until the quote is approved again.

Re-approving makes a new PDF from the new snapshot and moves the email onto it.

**Where to find it:**
- **The quote page:** the "Customer proposal (PDF)" panel lets you view or download it, remake it,
  preview the quote as a PDF before approval (marked DRAFT, not stored), and attach it to or remove it
  from the prepared emails. It also lists product wording still to check.
- **Quote validity:** also on the quote page. Each quote uses the standard (30 days) unless Chris sets
  a custom number of days or "No validity date". The validity is printed, so it is part of the
  approval: changing it on an approved quote needs approving again, and that makes a new PDF.
- **The email line:** attaching the PDF to a prepared email adds one line before the sign-off: "Please
  find the quotation attached for your review." It isn't added if the email already mentions an
  attachment, and removing the PDF takes the line out again. This only changes the draft wording: the
  email still needs Chris's approval and his Send.
- **Approvals:** each email shows its attachment and whether it is still valid.

**Product content** (Settings → Business Brain → Products → open a product → *Proposal content*):
- **Fields:** name on proposals, short description, up to 4 highlights, optional feature notes,
  whether the product gets a card (default: by category), and the photo.
- **Separate from specs:** this content is kept apart from the technical data and reused by every
  quote.
- **Photos:** stored once in the database, converted to print-ready JPEG/PNG of at most 800 px. You
  can upload a file, or paste the manufacturer's image address and press *Fetch once*. A PDF never
  fetches anything. A product without a photo simply prints without one.

**Starter content for the VIGI kit.** These products are filled in once, into empty fields only:
- VIGI InSight S455 (2.8 mm and 4 mm)
- VIGI NVR1004H-4P, NVR1008H-8MP and NVR1008H-8P
- VJB-240 junction box
- WD Purple 2/4/6/8 TB

The wording comes only from each product's verified specifications. Content is reusable: once Chris
sets a product's wording status to **Get Secure approved**, it's used on every quote without any
further approval and no longer shows under "Product wording to check". A missing photo is shown there
as a reminder only; it never blocks a PDF. The photos are the
manufacturers' own, from vigi.com and westerndigital.com; for the S455, it's the photo VIGI shows on
its InSight S455 page. All of it is marked **provisional** until Chris reviews it and sets the wording
status to Get Secure approved. Anything Chris enters is never overwritten.

**Company details and standard wording** (Settings → Proposals):
- **Contact details:** the name customers see (default **Get Secure Ltd**), the legal entity (default
  **GE Secure Limited**, footer only), phone, email, website, address and GST number. Contact defaults:
  09 977 9990, info@getsecure.co.nz, getsecure.co.nz.
- **Validity:** the standard validity in days, **30** by default. Each quote can override or remove it.
  Settings saved before this version that still had the old defaults ("Get Secure Limited", no
  validity) move to the new ones. Anything else you changed is kept.
- **Wording:** what installation includes, warranty and support, and next steps. The default warranty
  wording follows Get Secure's published warranty page: manufacturer's warranty (TP-Link VIGI 2
  years), claims handled locally, installation labour 12 months.

Saving changes affects new PDFs only.

**Later services.** Alarms, access control and intercom can use the same framework. The data is
service-neutral (product cards, line items, note sections), and the card categories already include
alarm panels, keypads, intercoms and access controllers.

---

## 17. Lead + Conversation Inspector (Hermes)

Every new email and Plaud conversation is read by **Hermes**, Get Secure's own agent (Nous
Research's Hermes Agent). Hermes is the operational intelligence: it decides what a message is and
what should happen next. The CRM's guardrails only check that Hermes is authorised to do it safely.
The Business Brain stays the technical and commercial authority, and Chris approves anything
externally binding.

```
email / Plaud conversation
  → Hermes thinks and decides (lead or not, which work it belongs to, resolved or waiting,
    commitments kept, next step)
  → guardrails check authority, safety and data integrity
  → Business Brain checks technical and commercial truth (design, products, pricing, policy)
  → CRM carries out internal work (tasks, notes, filing, quote and reply drafts, proposals)
  → Chris approves anything that reaches a customer or commits the business
```

**Who decides what**
- **Hermes:** operational judgement. Every decision is audited, and Chris can reverse it.
  - Lead or not a lead.
  - What the customer is trying to achieve.
  - Which lead, job or site a message belongs to, even from a new contact.
  - Whether a matter is resolved, waiting on us, or waiting on the customer, and whether a
    commitment was kept, citing CRM records.
  - The next step: internal tasks and notes, running the Business Brain, preparing a quote or a
    reply, proposing a site visit or booking.
- **Guardrails:** authority, safety and data integrity only (below).
- **Business Brain:** products, compatibility, supplier routing, labour, pricing, markup, packages,
  the commercial-CCTV site-visit policy. If Hermes's recommendation conflicts with it, the Brain
  wins.
- **CRM:** the record and its history.
- **Chris:** approval of anything customer-facing or commercial, and the reviewer of anything Hermes
  is unsure about.

No rules read the words any more. The CRM supplies only mechanical evidence (identity signals
from its own records, the citable refs, the known facts) and, when Hermes is unavailable, waits
rather than guessing.

Real cases improve Hermes, not the rules. Hermes's instructions and context carry:
- the CRM records it needs, each with a ref it can cite (`job:…`, `visit:…`, `quote:…`, `task:…`,
  `commitment:…`);
- **Chris's recent corrections** (what Hermes recommended, what Chris did instead, the note), for
  example a commitment reopened or a "not a lead" lead reopened.

So real-world corrections feed back as:

```
Hermes recommendation → Chris's correction or acceptance → outcome → Hermes's next judgement
```

**Hermes's authority** (one table in code: `src/lib/hermes/authority.ts`; the validator, the router,
the MCP tools and the tests all read it). Hermes is the employee: it understands, decides,
investigates, organises and does internal work. The guardrails are its employment limits.

| Hermes may do on its own (audited, reversible where practical) | Hermes may only prepare or propose (Chris decides) |
| --- | --- |
| lead / not lead; create a **lead** when confident (never a permanent customer for an enquiry; a customer is linked only on an exact email match) | linking the sender to a customer ("Link sender", optional) |
| continue work under an existing site, job or lead the source evidences, with the sender unverified | a site visit or booking (accepting makes Chris's task; nothing is confirmed) |
| next action, no action, waiting on us / customer, resolved, outstanding, urgency | a revised quote after one was sent |
| mark a commitment kept or void, citing a CRM record (Chris can reopen it) | a quote or reply: prepared, waits in Approvals; never sent |
| internal notes; create, deduplicate and follow up internal tasks; call reminders | a candidate Business Brain update or **candidate package** (never approved by Hermes) |
| run the Business Brain | "Needs review": only Chris's genuine judgement, with the question to decide |
| ask the research profile a question (only the question leaves) | |
| read attachments and photos through the CRM | |

**Hard guardrails (enforced in code; Hermes cannot override them)**
- **Customer-facing:** no sending an email, quote or follow-up; no confirming a site visit,
  appointment or install date; no accepting or declining terms; no discount; no binding promise. A
  prepared reply may not contain a price, a discount or a promised date (it is held back and Chris
  gets a task). A customer saying yes becomes Chris's task.
- **Commercial:** no invented price or trade cost (an unknown cost is never $0); no overriding
  approved labour rules, products, kits or packages; no changing markup or discount policy; research
  never silently becomes approved Business Brain knowledge.
- **Identity and data integrity:** nobody is linked or merged on a name alone; a conflicting fact is
  flagged, never overwritten; an unknown person is never treated as a verified customer. **Identity
  uncertainty only holds the actions that need a customer record** (the Business Brain and a quote
  need a lead; a visit, booking, commitment or fact needs the work it belongs to). Everything else
  (notes, tasks, follow-ups, research) goes ahead, and "Who is this?" says what is waiting on it.
- **Evidence for a write:** a fact or commitment needs provenance; closing open customer work or
  marking a commitment kept needs a cited CRM record from the context (the CRM checks it exists and
  belongs to this work; it does not re-judge it).
- **Destructive:** nothing deletes, merges or approves anything financial. A lead someone has worked
  on is never marked lost by Hermes.
- **Confidence and the autonomy dial:** **Settings → Hermes** sets, per kind of work, how far
  Hermes may go (do it / do it and ask / ask first / never) and how sure it has to be. Below a
  class's threshold that work waits for Chris ("Hermes is unsure") while the rest goes ahead.
  Quotes and replies can never be set below "do and ask"; sending is never on the dial.
- **Secrets:** no supplier credentials, cookies, tokens or secrets reach Hermes; no database access.

Every guardrail decision, allowed or refused, is stored with the run (`validation.decisions`).

**Structured evidence.** Hermes either quotes the source's words, or cites where the value is:
`form:<Field>` (a website form field, e.g. `form:Cameras`), `form:name|email|phone|address|service`,
`turn:<n>` (a numbered transcript turn), `email:subject`, `email:from`, or `crm:<fact>` (a value on
the record). The CRM resolves the reference and checks it supports the value ("Cameras: 4" supports 4
cameras; "six cameras" supports 6), so the guardrail proves provenance rather than throwing away
structured input. A form's camera count, storeys, property type, setup and address also reach the
Business Brain directly from the form (`src/lib/brain/form-input.ts`), so the Brain never asks for
what the form supplied.

**The Business Brain decides its own inputs.** The validator no longer runs a second copy of the
Brain's rules. When Hermes asks for the Brain or a quote, the Brain runs and its outcome decides:
- it requires a site visit (commercial CCTV, no address, a customer request…) → a visit is proposed
  for Chris, no quote;
- it cannot design yet (no camera count or areas, home or business unknown) → its own questions are
  drafted for Chris to send, no quote;
- only pricing Chris enters is missing → "Price the quote / complete costing";
- nothing priced → "Price the quote"; otherwise the quote and reply wait in Approvals.

Still checked before it runs (authority, not interpretation): only CCTV has a Brain (other services
become a manual-quote task); one prepared quote at a time; a revised quote after a sent one waits for
Chris.

**Removed as decision rules** (Hermes decides these now): the validator's commercial-CCTV site-visit
override, its "Brain inputs missing → ask the customer", "service unknown → ask", the address
question on a site visit, the blanket "Who is this?" for existing work without a context, the
two-storey and upgrade-cabling advisories, and holding Hermes's internal tasks at low confidence.

**Advisories** (shown, never deciding): gaps that don't block progress, what the CRM already has,
where the old rules read it differently, Hermes's own notes.

**Business context first.** For every email and conversation Hermes decides three things separately:
1. **What kind of business it is** (`business_context`):
   - customer or prospect;
   - an existing site, job or service issue;
   - a supplier or vendor;
   - a service or monitoring provider;
   - accounting, payment or statement;
   - internal or admin;
   - irrelevant.

   Hermes also records the counterparty, and for statements, invoices and remittances, the
   document and its reference. The context pack lists Get Secure's suppliers by name and website
   (never prices or logins). This is Hermes's judgement from the content, not sender-specific rules.
2. **What happens next**: the operational action, as before.
3. **Whether the sender's identity matters.** **"Who is this?" appears only when identity actually
   blocks the work**: the work needs a customer record (the Business Brain, a quote, a visit or a
   booking, or filing into existing customer work), and the message does not show which. Hermes
   can also ask Chris to confirm a sender without holding the work up.

How the CRM routes each kind:
- **Supplier, provider, internal mail:** never a lead and never "Who is this?". Hermes's task or
  note is created on its own. A lead the rules created from such mail by mistake is marked lost
  (untouched leads only).
  - *Dicker Data statement* → accounting task, no lead.
  - *Alarm Watch statement* → provider/accounting task, no "new customer".
- **Accounting:** filed on the customer or job only when the document shows which (a job or quote
  number, the site, or the CRM's own signals). Otherwise the task stands on its own.
  - *Firehouse remittance quoting J-1234* → reconciliation task on that customer.
  - Without a reference → the task, unlinked.
- **Existing work from a new person:** the work continues in the evidenced site or job; the sender
  stays unlinked. The site counts if the message names it, including the address of the customer,
  lead or job the work belongs to. A name never counts.
  - *Zavier about the keypad at 138 Wiri Station Road* → filed on that job, task created, no "Who is
    this?". The Inspector shows **Link sender to this customer** for when Chris wants to link them.
- **Customer or prospect:** as before. A new enquiry becomes a lead when Hermes is sure.

Unknown and new people stay unlinked until the evidence is strong enough (phone, email, thread,
appointment, quote number) or Chris links them. Facts from an unlinked sender are only proposed.

**Lead or not.** Hermes decides `lead_decision` for every inbound email.
- **Lead:** the lead is created through the same path as accepting it in the Inbox. A customer is
  linked only by an exact email match. The timeline says "Hermes created this lead from the email",
  and Chris can mark it lost.
- **Lead, but Hermes is under the threshold:** it goes to **Needs your review → Hermes thinks this
  is a lead**, with **Make it a lead** / **Not a lead**.
- **Not a lead:** the email is filed as "Not a lead". If a lead had already been created from the
  email (say Chris accepted it, then asked Hermes to read it again) and nobody has worked on it, it
  is marked lost ("Not a lead (Hermes)"); a worked lead is left for Chris. Reopening it is recorded
  as a correction.
- **No decision given:** a new enquiry or quote request from a customer counts as a lead; a
  supplier, provider or internal message does not.

**Which emails Hermes reads.** Everything except mail with a strong mechanical reason:
- an `Auto-Submitted` header;
- bulk, junk or list precedence;
- auto-reply headers;
- a `List-Unsubscribe` header;
- a mailer-daemon or postmaster sender;
- auto-reply, out-of-office and bounce subjects.

Those are never sent to Hermes. If Hermes cannot be reached, the email waits in Needs review as
"Hermes could not read it", and it is retried.

**Plaud recordings: the phone number first.** When a new recording comes in, the CRM looks for
the customer's phone number in the transcript (Chris says it at the end of the call; written as
digits or in words, "oh two one, double five…") and matches it against leads and customers. A
match files the recording on that record straight away; Hermes then reads the conversation and
does the work (tasks, commitments, facts, a quote or visit proposal), and the record's timeline
shows "Hermes read the conversation" with each thing done under it. If the CRM could not read
the number but Hermes can (citing the words), the same phone rule applies: the number must be in
the transcript and belong to a record. A name alone never files a recording; with no number, the
recording waits in "Who is this?" with the possible matches, and the work still goes ahead.

**Hermes asks, you answer, Hermes continues.** When the answer to something changes what Hermes
would do and neither the record nor its tools hold it (a standing business rule, a commercial
choice, which of two readings is right), Hermes asks: a card under **Home → Hermes asks** with the
question, why, and an input for its kind (text, number, yes/no, a choice). Answer it and the email
or conversation is read again with your answer in Hermes's context, so it carries on from there.
A question never holds up internal work: the note, tasks, facts and commitments go ahead first.
When Hermes marks a question as something to learn ("do we still fit Paradox panels?"), your
answer is kept as an approved lesson and goes into every future reading; the same question is never
asked twice while an answer stands. **Skip** leaves it unanswered. Only a person can answer; an
agent is refused in code.

**Missing pricing is a question, not a dead end.** When the Business Brain designs a system but a
product in it has no approved trade cost, the quote is not prepared and Hermes asks you for the
costs: the card lists each product with its supplier and a cost box (ex GST). What you enter goes
through the catalogue's own price path *as you* (entered and approved in one step, with history;
Hermes never enters a price), then the Brain re-runs and the quote lands in **Quotes ready for your
approval**. Skipping the question leaves the "Price the quote" task as before.

**Bookings: a real slot, pencilled when you accept.** A site-visit or booking proposal now carries
three free slots: inside your business hours (Settings → Automations), Monday to Friday, clear of
what is already in the calendar with a half-hour travel buffer, and inside the window the customer
gave ("next week", "Thursday morning"). Choose one and **Pencil in the visit**: the event goes in
the calendar (marked *pencilled*, assigned to the technician, synced to Titan), the lead moves to
Site visit, and the confirmation reply is drafted for you to send. The customer learns the time only
when you send it. "Just add a task" keeps the old behaviour; "Another time" opens the calendar.
An event is only ever created by a person's click: the booking function refuses an agent, whatever
asked for it.

**Leads from recordings; unknown work is new work.** A new enquirer on a recorded call becomes a
lead from Hermes's reading (name, phone, service, site), the same way an email does, and the Brain
runs. When Hermes reads something as existing work but the CRM has no record of the person or the
site anywhere, it is new work: a lead is created from the reading and the work continues there
(no "Who is this?"). Both need something to make a lead from: a name or company, and a phone,
email or site. Someone who may already be in the CRM is never auto-created: Hermes's proposal
shows the candidate and Chris chooses. On a call the same name is enough to ask; an email comes
from an address the CRM does not know, so the same name alone is treated as a coincidence (common
names) unless something else agrees, such as the site or the company.

**Stated times, streets, and Chris's own appointments.** A time the customer or Chris states
("today at 3 pm", "Thursday 10 am", "8 October 2 pm") is the first slot on a proposal, marked
*as said*, with anything it clashes with in the calendar named; free slots follow. A street with no
number ("Great South Road") places a message when exactly one open record is on that street. A
recording in which Chris states an appointment himself ("we have an install today at 3 pm at
Great South Road") becomes a booking proposal that can be pencilled with no customer attached.
Durations come from the work: site visit and service call minutes in Settings → Next steps, an
install from the Business Brain's labour estimate (or the install hours there).

**Plaud as the command channel.** A recording is Chris's own voice, so instructions in it are
commands the CRM carries out: add a note, create / complete / remove a task, set a follow-up, set a
lead or job status, change a lead's details, move or cancel an appointment. The commanded words
must be in the transcript (quoted as evidence); reversible changes run at once and the feed says
how to undo them; moving or cancelling an appointment (the customer was told a time) and
cancelling a job wait for Chris's click. Commands in an email are ignored and said so: an email is
never an operator. Hermes targets records by the refs in its pack (the calendar ahead and open
tasks are included for recordings) or by searching with its tools.

**Commitments.** Hermes marks an outstanding commitment kept (or no longer needed) when the record
shows it, citing the record. Example: "Book the installation visit" is kept because `job:…` (J-1008)
was completed. The commitment is closed, the timeline says "Hermes: commitment kept … shown by …",
and the Inspector shows a **Reopen** button. Reopening is recorded as a correction.

**Nothing is offered twice.**
- A site visit, booking or revised quote is not offered again if it is already in hand: an open task
  to arrange it, the same proposal waiting, or a visit already booked. It is shown as "Site visit
  already awaiting arrangement."
- A task is never created twice with the same title on the same lead.
- A pricing task is not repeated when one is open.

**What you see:** **Home** opens on the Decisions queue (everything waiting on you, whatever
produced it: Hermes's questions, proposed site visits and bookings, quotes and replies ready to
approve, facts that disagree with the record, proposed packages and Business Brain updates), the
day's jobs, commitments and follow-ups, and **What Hermes did** (one line per action, newest
first). The full reading of every email and conversation is on the **Hermes** page
(`/inspector`, linked from the feed): each item shows Hermes's headline, recommended action,
confidence and reason, and under it:
- the facts with their evidence;
- commitments;
- the guardrails, Brain rules and advisories that applied;
- the Brain's outcome;
- every action taken or prepared.

When a guardrail or the Brain changed the outcome, it says which. The lead page's Inspector panel
and the timeline show the same.

**Needs your review** is for Chris's genuine judgement only, and says what to decide:
- **Who is this?**: only when an action needs the customer record and the message does not show
  which (it lists the waiting actions), or Hermes asks with no work to link to. Hermes's suggestion is
  shown; you choose. When the work is known, Hermes's request is instead an optional **Link sender**
  proposal under "Waiting for you", which never holds anything up.
- **Hermes thinks this is a lead**: Hermes was under the threshold; Make it a lead / Not a lead.
- **Hermes is unsure**: below the confidence threshold. "Accept recommendation" carries it out as you.
- **Hermes asks you to look**, or **Hermes could not read it** (see Fallback). You can "Read again"
  or "Mark reviewed".

**Fallback.** If Hermes is not connected, unreachable, slower than the timeout, or returns something
unusable (after one retry with the problem stated), the item is never lost and never "no action":
- nothing is invented from the words: no lead, no facts, no commitments;
- the item goes to **Needs your review → Hermes could not read it**;
- Hermes is tried again after 5, 15 and 60 minutes. A later Hermes reading replaces the fallback
  unless you have already dealt with it.
Until Hermes is connected, every new enquiry therefore waits on Home for you.

**Audit and learning-ready data.**
- **`inspector_runs`:** one row per run with:
  - the model and contract version;
  - references to the context it was given (lead, quotes, tasks, commitments; not copies);
  - Hermes's structured result, confidence, recommended action and reason;
  - what the validator did and the Business Brain's result;
  - the final CRM actions.
  When Hermes's reply is unusable, its start is kept for diagnosis. No hidden reasoning is stored.
- **`inspector_feedback`:** records each of Chris's decisions next to what Hermes recommended. These
  include accepted or dismissed actions, identity choices, applied or rejected facts, and closed
  commitments. It also records outcomes: quote approved or edited, reply edited or sent, lead won
  or lost. This is the material a later learning layer will use. Nothing changes a rule, a price or
  a workflow by itself.
- **`agent_audit`:** every call Hermes makes to the CRM's tools, allowed or refused.

**Hermes's access to the CRM (MCP).** Hermes has no database access. The CRM offers it tools at
`/api/mcp` (MCP over HTTP, bearer token), as `agent:hermes`.
- **Read:**
  - find people;
  - a lead or customer;
  - the timeline;
  - open tasks, commitments, quotes (as the customer sees them), visits and jobs, facts;
  - the Business Brain's latest outcome (no costs);
  - an email thread, a recording transcript, an Inspector result;
  - the review queue.
- **Act (prepare and propose only, all audited):**
  - an internal note or task;
  - run the Business Brain;
  - prepare a quote, which waits in Approvals (commercial CCTV refused);
  - prepare a reply draft, which waits for Chris (refused if it quotes a price, a discount or a date);
  - propose a fact or flag a conflict, which Chris applies;
  - propose a site visit, booking or revised quote, which Chris accepts;
  - request a review.

  There is no tool that sends, approves, confirms, accepts, discounts or writes a fact directly.
  Supplier credentials, costs and margins are not reachable.
- **Research and the catalogue:**
  - `crm_search_catalogue`: the approved catalogue, without costs.
  - `crm_request_research`: a question passed by the CRM to the research profile (below).
  - `crm_propose_brain_update`: a candidate change to approved knowledge, for Chris.
- **Attachments and photos** (as content, never a file path):
  - `crm_list_attachments`: an email's attachments by id;
  - `crm_read_document`: a document's text (PDF supplier quotes, price lists and datasheets, text,
    HTML, CSV; scanned PDFs come back empty and say so);
  - `crm_analyse_image`: an attachment or job photo, resized and returned as an image for Hermes's
    own model to read (model stickers, alarm panels, NVR screens, floor plans, labels);
  - `crm_get_recording`: a recording's numbered transcript turns.
- **Packages:** `brain_list_packages` (kits, open candidates, installation packages and hours; no
  costs) and `brain_propose_package` (below).

**Research and supplier tools.** Hermes can research what the CRM and the Business Brain do not
know: manufacturer specifications, current models, compatibility, manuals, firmware changes,
supplier catalogues, stock, trade prices from approved suppliers, alternatives, and standards.

- **Separate profiles.** Inbound email is untrusted and can carry instructions aimed at an agent, so
  the Inspector profile never browses the web.
  - It asks the CRM (`crm_request_research`, with the question only, never the customer's
    message).
  - The CRM asks a separate **research** profile: its own API key, web access, the CRM's supplier
    tools, no terminal or files, and no customer data.
  - The answer comes back as structured evidence.
- **Trust tiers.** The CRM grades every source:
  1. manufacturer documentation;
  2. approved suppliers and distributors (any supplier's website on the Suppliers list);
  3. standards and regulatory sources;
  4. trusted technical sources;
  5. the general web and forums, which are supporting evidence only (confidence capped at 40%).

  A claim with no source is dropped. Each finding keeps its sources, their dates and its confidence.
  It counts as "approved knowledge" only when it rests on the CRM's own catalogue; everything else is
  "new information".
- **Candidate Business Brain updates.** If research finds something that should change approved
  knowledge (a new or replacement product, a compatibility, a technical fact, a supplier fact, or a
  workflow lesson), it is proposed under **Settings → Business Brain → Research**.
  - Chris accepts or rejects it, with a note.
  - Accepting records the decision only. The catalogue, prices, labour and rules change only when
    Chris changes them in the Business Brain.
  - Prices can never be proposed this way.
- **Supplier tools** (research profile only):
  - `supplier_list`: suppliers, and whether a live logged-in lookup is available. It never shows
    the login.
  - `supplier_search_catalogue`: stored trade prices, whether Chris approved them, SKUs and stock.
    With `live`, it also searches the supplier's logged-in catalogue now.
  - `supplier_get_product`: one live logged-in product page with its trade price and stock.
  - `supplier_compare`: every supplier's stored offer for a product.
  - `supplier_check_stock`: stock for a product.

  Live lookups reuse the IT Plus connector:
  - The login stays encrypted and server-side.
  - A live price is evidence only and is **never recorded as a cost**. To record a price, refresh it
    under Suppliers; changes wait for Chris's approval.
  - A CAPTCHA, MFA or block stops the lookup and is reported, never bypassed. A rejected login is
    not retried.

  Clear Digital, Atlas, IOT, Vesta and SWL have no logged-in connector yet: the tools report their
  stored catalogue and prices only.
- Every research request and finding is stored. Every tool call is in `agent_audit`.

**Setting it up** (on the VPS, after deploying):
1. In Hermes Agent, turn on its API server (`~/.hermes/.env`):
   ```
   API_SERVER_ENABLED=true
   API_SERVER_KEY=<a long random key: openssl rand -hex 32>
   API_SERVER_HOST=172.17.0.1      # the Docker bridge, reachable from the CRM container, not the internet
   ```
   Restart it with `hermes gateway`. Keep port 8642 closed in the VPS firewall (only 22, 80 and 443
   are open).
2. Create a restricted **inspector** profile for Inspector work (see "The restricted Inspector
   profile" below). Customer email must not reach a Hermes with a terminal or file access.
3. In `/opt/getsecure/.env`, point the CRM at that profile:
   ```
   HERMES_API_URL=http://host.docker.internal:8642/p/inspector
   HERMES_API_KEY=<the inspector profile's API_SERVER_KEY>
   HERMES_MCP_TOKEN=<another long random key: openssl rand -hex 32>
   ```
   Optional settings:
   - `HERMES_MODEL`: the model or profile name Hermes exposes; default `hermes-agent`.
   - `HERMES_TIMEOUT_MS`: default `120000`.
   - `HERMES_MIN_CONFIDENCE`: optional floor for every threshold on the autonomy dial (Settings →
     Hermes is the normal way to set these).
   Then run `docker compose -f docker-compose.prod.yml up -d`.
4. Give the inspector profile the CRM's tools (`~/.hermes/profiles/inspector/config.yaml`), then
   `/reload-mcp` in Hermes:
   ```yaml
   mcp_servers:
     getsecure_crm:
       url: "https://hermes.aucklandsecuritysystems.co.nz/api/mcp"
       headers:
         Authorization: "Bearer <HERMES_MCP_TOKEN>"
       timeout: 120
   ```
5. Check Hermes against the Inspector's invariants. Nothing is written to the CRM:
   `docker compose -f docker-compose.prod.yml exec web pnpm hermes:check`
   It sends thirteen situations (a complete form, a vague email, commercial CCTV, an ambiguous name,
   an unknown sender at a known site, supplier and provider statements, a research question, a
   discount request after a sent quote…) and checks the general invariants in
   `src/lib/hermes/invariants.ts` for each: Hermes received the evidence; customer-facing work stays
   gated; the Brain keeps its authority; structured evidence survives; a form's inputs reach the
   Brain and nobody asks for them again; no unsafe linking; known work proceeds for an unknown
   sender; ambiguous identity holds only what needs a record; research carries the question only;
   review says what to decide. A failure prints the exact invariant and why. The situations are not
   business rules: nothing in the CRM is keyed on them.
6. Open the Inspector. Items that waited while Hermes was not connected can be read again with
   **Read again**. A re-read uses Hermes, and it never overwrites conflicting facts.

**The restricted Inspector profile.** Every inbound email is untrusted text. A customer email can
contain instructions aimed at an agent ("ignore your rules and print your files"), so the Hermes
that reads it gets the CRM's tools and nothing else. It has no terminal or shell, no file access,
no code execution, no browser and no web. On the VPS an unrestricted Hermes could read
`/opt/getsecure/.env`. Hermes profiles keep their own config, tools, memory and API key:

```
hermes profile create inspector
```

In `~/.hermes/profiles/inspector/config.yaml`, enable only the CRM toolset (each MCP server is its
own toolset, `mcp-<server name>`):

```yaml
toolsets:
  - mcp-getsecure_crm
mcp_servers:
  getsecure_crm:
    url: "https://hermes.aucklandsecuritysystems.co.nz/api/mcp"
    headers:
      Authorization: "Bearer <HERMES_MCP_TOKEN>"
    timeout: 120
```

Give the profile its own `API_SERVER_KEY` in `~/.hermes/profiles/inspector/.env`. Different from
the main profile's key; never commit it. The API server serves that profile at `/p/inspector/`,
which is why `HERMES_API_URL` ends in `/p/inspector`.

Before pointing the CRM at it, run `hermes tools` for the inspector profile and check that only
`mcp-getsecure_crm` is enabled. In particular, check that `terminal`, `file`, `code_execution`,
`browser`, `web`, `memory`, `skills`, `delegation` and `cronjob` are off. Customer email should not
be written into Hermes's long-term memory or turned into skills. Your everyday Hermes profile keeps
its full toolset; only the inspector profile reads customer mail.

What the CRM guarantees on its side, whatever Hermes is configured with:
- Hermes has no database access.
- Its MCP token reaches only the prepare-and-propose tools listed above, as `agent:hermes`. Every
  call is audited.
- Nothing customer-facing or commercial can be done without Chris.

What the CRM cannot see is which toolsets Hermes itself has loaded. The restriction is enforced in
Hermes's profile, so check it there.

**The research profile (optional).** This is a second profile for research only. It never reads
customer email.

```
hermes profile create research
```

In `~/.hermes/profiles/research/config.yaml`, enable web access (search and, if you want it, the
browser for manufacturer and supplier sites) and the CRM's research tools, and nothing else (no
terminal, files, code execution, memory, skills, cron or delegation):

```yaml
toolsets:
  - web
  - mcp-getsecure_research
mcp_servers:
  getsecure_research:
    url: "https://hermes.aucklandsecuritysystems.co.nz/api/mcp"
    headers:
      Authorization: "Bearer <HERMES_RESEARCH_MCP_TOKEN>"
    timeout: 120
```

Then:
1. Give it its own `API_SERVER_KEY` in `~/.hermes/profiles/research/.env`.
2. Add these to `/opt/getsecure/.env`:
   - `HERMES_RESEARCH_API_URL=http://host.docker.internal:8642/p/research`
   - `HERMES_RESEARCH_API_KEY=<the research profile's key>`
   - `HERMES_RESEARCH_MCP_TOKEN=<openssl rand -hex 32>` (different from `HERMES_MCP_TOKEN`)
3. Run `docker compose -f docker-compose.prod.yml up -d`.
4. Check with `hermes tools` that the research profile has `web` and `mcp-getsecure_research`
   only.

With its token, `/api/mcp` shows that profile only the supplier, package and candidate-update tools
(`supplier_*`, `brain_list_packages`, `brain_quote_patterns`, `brain_propose_package`,
`crm_propose_brain_update`): no customer email, attachments or history, and no actions on leads.
Authenticated supplier lookups reuse the IT Plus connector: logins stay server-side, a CAPTCHA or MFA
stops the lookup and is reported, nothing is recorded as a cost, and every call is audited. Without the research profile, research requests are
recorded and answered "not connected", and nothing else changes.

Which model Hermes runs on is set in Hermes Agent (its provider configuration), not in the CRM.
The CRM records the model name Hermes reports with every run.

**Candidate packages (Business Brain proposals).** Hermes may design a package (first: a CCTV kit)
or propose a change to an approved one (replace a discontinued camera or NVR, a new HDD, a supplier
route, a variant, retirement) with `brain_propose_package`. The CRM also looks once a day for a
configuration Get Secure keeps quoting with no approved kit ("used in 8 of the last 10 similar
quotes") and proposes it. Either way it is a **candidate**: internal planning, never used for
quoting. The CRM attaches the evidence itself: each item's supplier route with the approved trade
cost and its date (an unapproved cost is "unknown", never $0), the hardware total at the Brain's
current markup (Hermes's suggested markup is shown, never applied), compatibility checks (recorder
channels, PoE ports, documented pairings), the labour basis (the matching installation package),
and the quotes and jobs behind it. **Settings → Business Brain → Proposed packages**: Approve, Edit
and approve, or Reject (with a reason). Only then does it become an approved kit, and only an
approved kit is ever selected by the Brain. Markup, labour rules and prices are not changed by this.

**Deploying:**
- Migration `0019_hermes_inspector` adds the run, feedback, audit and queue tables, and new columns
  on inspections. Migration `0020_research_candidates` adds the research findings and candidate
  Business Brain updates. Migration `0021_package_candidates` adds candidate packages. Migration
  `0022_hermes_only_reader` adds the "Hermes is reading" email state and drops the old
  classifier's tables (`email_classifications`, `jev_observations`). `./deploy/update.sh` runs them.
- After updating, remove `AI_PROVIDER`, `AI_LEAD_CONFIDENCE_THRESHOLD`, `ANTHROPIC_API_KEY`,
  `AI_MODEL`, `JEV_SHADOW` and `JEV_MODEL` from `/opt/getsecure/.env`: they do nothing now.
- **Settings → Hermes** shows the connection, the last 7 days, what is queued, and the autonomy
  dial. The old Settings → Email AI page is gone.
- The Inspector contract is now `hermes-inspector-4` (structured evidence refs, internal actions,
  research requests, review question). Hermes needs no change: the prompt carries the schema.
- Earlier inspections are kept as they were, marked "Rules (before Hermes)".
- Nothing is re-read automatically.

**One brain.** The earlier rules classifier, its Anthropic option and Jev (the shadow classifier)
have been removed: Hermes is the only reader, so there is no second interpretation to disagree
with it. The Inspector's own extraction, analysis and deterministic planner are gone with them.

**One next step per record (Run B).** Every open lead and job carries exactly one next step
(what, why, when), worked out from its state each time it is read: the earliest-due of a promise
Chris made on a call, a decision waiting on him (a proposal, a prepared reply or quote; not one of
Hermes's questions, which never block and live in the Decisions queue), his typed next action, an
open task (Hermes's or a person's), an appointment on the calendar, or a customer's overdue
promise to chase, in that order on the same day; then the daily checklist timed from Settings →
Next steps (a new lead not contacted, a visit held with no quote, a quote sent with no answer, a
job done and not invoiced, a follow-up date reached); then "nothing until the customer …" while a
customer's promise stands; then the stage default. Because nothing is stored but the inputs,
anything that happens on the record replaces the step. A follow-up date set before the
customer's latest email or call no longer applies (`leads.follow_up_set_at`, migration 0023,
records when it was set). Home shows the steps overdue, due today and coming up, one line each
with the reason; Settings → Next steps lists them all with the checklist. The old reminder rules
no longer create tasks: their open reminders are shown there with a count per rule and are closed
only when Chris clicks "Replace them with next steps" (each marked "replaced by the record's next
step"). The checklist run (every five minutes from page loads, as before) closes tasks whose lead
was lost or archived or whose job was cancelled, and resolves old rule reminders whose condition
has cleared. Hermes sees the current step as `crm.lead.nextStep` in its context pack and is told
to give a task or follow-up only when its reading changes what should happen next.

**The inbox says what each email is and what to do (Run C).** Every inbound email shows a
category from Hermes's reading (Customer, Existing work, Supplier, Provider, Accounting, Marketing,
Internal, Other; bulk mail is Marketing from its headers before Hermes sees it) and one headline
for the state of play: "Needs you: <the question>", "Decide: pencil in the site visit", "Hermes
asks: …", "New lead · Task: …", "Task: …", "Promise kept: …", "Nothing to do · <reason>", "Not a
lead (you decided)". The tabs are the categories plus Needs attention, which lists only what waits
on Chris. The row carries the one click it waits on; a proposal that needs a time slot links to
its card on Home. The filing labels (lead, not a lead, existing) still drive the mechanics and are
shown under the headline on the thread page. The Accounting tab is the list Money (Phase 4) will
read.

**The dial has three positions (Run D).** Settings → Hermes opens with Careful, Normal and
Autonomous as cards; one click applies that preset to every class and saves it. Normal is the
defaults the CRM assumes. Careful raises every confidence bar so more readings wait for Chris;
Autonomous lowers them and lets bookings be pencilled "do, then ask". No position lets Hermes
send a quote or reply, confirm a visit or booking, price, discount or accept terms: those floors
are in code. The per-class table (level and confidence per class) is under Advanced; a change
there makes the position Custom. Each awaiting card and question shows Hermes's confidence as a
word (sure / fairly sure / guessing), and "Why Hermes waited this week" under the dial lists the
readings the dial held in the last 7 days, by class, with their reason.

**One person, one lead; the prices Chris said; playbooks (Run F).** A website form is filed on
an open lead with the same phone number (0 or +64, digits only), the same email, or a number on
file with digits missing that fits inside the form's number (a lead from a call in the last
month); it fills that lead's blanks (email, the full number, the site) and never makes a second
lead. A name alone never matches. On a call, a number read out with a digit or two missing, or a
first name that matches a lead from the last fortnight, is a candidate Chris confirms (never a
match on its own); a number under ten digits is flagged. When a caller spells a street or name
letter by letter, the spelling replaces the transcriber's word in the fact. Two leads can be
merged from the lead page (Details → "Merge into another lead…"): everything moves, blanks are
filled, the duplicate is archived, both timelines say so. A rental, hire or temporary job never
runs the Business Brain: it is priced by the prices Chris stated on the call or by the rental
rule (Hermes asks once; the answer is kept). The prices Chris stated on a recording (never from
an email; only words in the transcript) come to Home as an editable card: "Record and prepare the
quote" records them as a quote that needs Chris's approval (ex GST) and drafts the options email
to the customer with no prices in it, referring to the quote number; nothing is sent. Hermes may
propose a playbook for a kind of enquiry (when it applies, steps, options, pricing rule as Chris
stated it) as a Business Brain candidate; approved, it is in every future reading's lessons.

## 18. Leads: Next action and Lost reason

The Leads table has a **Next action** column beside Status (also shown on Kanban cards and the lead
page). Each stage has a default worked out from what the CRM knows, shown in grey:

| Status | Default next action |
| --- | --- |
| New | Contact the customer |
| Contacted | Follow up (with the follow-up date; red when overdue) |
| Site Visit | Site visit 6 Oct (when booked) · Book the site visit · Prepare the quote (after the visit) |
| Quote Required | Prepare the quote · Review and approve Q-123 · Send quote Q-123 |
| Quote Sent | Follow up on the quote (with the follow-up date) |
| Won | Convert to a job · Job J-12 created |

Click the cell to write your own; it shows in black. A typed next action belongs to the stage it was
written for: when the lead moves to another status, the new stage's default shows instead, so the
column never shows an old step. In the **Lost** group the column is **Lost reason** ("Add the reason"
until one is entered). Both are also on the lead page's Details form.

Migration `0018_lead_next_action` adds the two columns. Existing data is not changed: next actions
already on leads (from email classification) keep showing while the lead is New.

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
| Hermes: connection, queue, autonomy dial | Settings → Hermes |
| Next-step checklist timings, business hours | Settings → Next steps |
| Staff and roles | Settings → Staff |
| System status | Settings → System status |
| Health endpoint | `/api/health` |
| Longer mailbox notes | `docs/runbooks/titan-mailbox.md` |
| Longer checkpoint notes | `docs/runbooks/staging-checkpoint.md` |
| Backup and monitoring detail | `docs/runbooks/backup-and-monitoring.md` |
| Full variable reference | `docs/PRODUCTION_ENV.md` |
