# Get Secure CRM

A monday.com-style CRM for Get Secure, built around the core workflow:

**Lead → Customer → Quote → Job → Calendar**

v0.1: login, a Leads board (table with inline editing, grouped by status, plus a drag-and-drop
kanban), lead conversion to customer + job (+ optional draft quote), quotes with line items and GST,
jobs with scheduling onto a built-in calendar, user management, and an activity log.

v0.2: **Titan email ingestion.** A mailbox is connected over IMAP/SMTP; new enquiries are stored with
their full original message and thread, classified by a pluggable classifier (the built-in offline
rules by default, optionally Claude), and turned into Leads automatically when confidence is high or
sent to a Needs-review queue when not.
Replies are sent from the CRM through Titan SMTP and kept on the same thread.

v0.3: **Today dashboard, calendar & dispatch, My Day, follow-up automations.** A morning
"attention needed" screen; a day/week time grid with technician lanes, drag-to-reschedule and an
unscheduled-jobs tray; site visits booked from leads; a mobile technician view with
Scheduled → En route → On site → Done, notes and photos; and internal reminders for stale leads,
unsent quotes, unanswered quotes, uninvoiced jobs and follow-up dates. No automation emails customers.

v0.4: **Production-readiness.** A first-run setup checklist at `/setup` (admin login → staff →
Titan mailbox → AI → business hours), roles for Admin / Office / Technician with the field role kept
out of settings and the inbox, global search by name, phone, email or site address, a customer
history timeline (emails, leads, quotes, jobs, site visits, notes), a journey bar that connects
lead → site visit → quote → job, one-click decisions on the Needs-review list, security headers,
login throttling, private attachment/photo routes, a health endpoint and System status page, backup
scripts and runbooks, and a production `.env` checklist.

**Going live? Start with [docs/DEPLOYMENT_HANDOFF.md](docs/DEPLOYMENT_HANDOFF.md)** — one document
covering hosting, services, every environment variable, first login, the Titan mailbox, the Anthropic
key, verification, backups, health and rollback.

See also [docs/PLAN.md](docs/PLAN.md) for the roadmap, [docs/DEPLOY.md](docs/DEPLOY.md) for other
hosting options, [docs/runbooks/titan-mailbox.md](docs/runbooks/titan-mailbox.md) for mailbox detail,
and [docs/runbooks/staging-checkpoint.md](docs/runbooks/staging-checkpoint.md) for the real-mailbox + live-AI checkpoint.

## Stack

Next.js 15 (App Router, server actions) · TypeScript · PostgreSQL 16 + Drizzle ORM · Tailwind v4 · dnd-kit ·
imapflow / mailparser / nodemailer · Anthropic SDK · Playwright + Vitest. One codebase, two processes:
the web app and an optional email-ingestion worker (or run ingestion inside the web process).

## Local development

```bash
pnpm install
docker compose up -d           # Postgres on localhost:5432 (or use your own)
cp .env.example .env           # then set AUTH_SECRET and SEED_ADMIN_PASSWORD
pnpm db:migrate                # apply SQL migrations in ./drizzle
pnpm db:seed -- --sample       # optional: example leads (or just open /setup to create the admin)
pnpm secrets:check             # fails if any credential is tracked by git
pnpm dev                       # http://localhost:3000
```

Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from your `.env`.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js dev server / production build / production server |
| `pnpm db:generate` | Generate a new SQL migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations (also runs automatically on container start) |
| `pnpm db:seed [-- --sample]` | Create the first admin user; `--sample` adds example leads |
| `pnpm db:studio` | Drizzle Studio for browsing the database |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | ESLint / `tsc` / Vitest unit tests |
| `pnpm test:integration` | Vitest against the real database: ingestion, threading, classification; plus IMAP/SMTP when a local Dovecot is running |
| `pnpm test:e2e` | Playwright end-to-end: core workflow, and the email flow when a local Dovecot is running (`tests/support/dovecot/start.sh`) |
| `pnpm worker` | Run the email ingestion worker (IMAP IDLE + poll) as its own process |
| `pnpm mailbox:sync` | One sync pass over every active mailbox |
| `pnpm ingest:eml -- --mailbox <address> file.eml` | Import .eml files as if they arrived over IMAP (testing / backfill) |
| `pnpm ai:smoke [-- --recent N]` | Classify the sample enquiries (or the latest N real emails) with the active AI provider; prints extracted fields, writes nothing |

## Project layout

```
src/app/            routes (App Router). (app)/ is the authenticated shell; login/ is public
src/actions/        server actions: leads, contacts, quotes, jobs, events, users, auth, mailboxes, inbox
src/queries/        read queries used by pages (email.ts for inbox/threads)
src/components/     UI: leads board (table/kanban/cells), inbox, calendar, forms, layout, primitives
src/db/             Drizzle schema + client
src/lib/ai/         provider-neutral lead classifier interface + Anthropic and offline-rules providers
src/lib/automations/ follow-up rules (one candidate per entity) and the idempotent runner
src/lib/email/      parse, store/thread, classification pipeline, IMAP sync + IDLE watcher, SMTP replies
src/worker/         standalone ingestion worker entry point (src/instrumentation.ts runs it in-process)
src/lib/            auth (JWT cookie sessions), env validation, crypto for mailbox secrets, constants
drizzle/            SQL migrations (generated; commit them)
scripts/            migrate.mjs, seed.mjs (plain JS so they run in the production image)
tests/              unit (Vitest) and e2e (Playwright)
```

## Environment variables

| Name | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Append `?sslmode=require` for managed databases. |
| `AUTH_SECRET` | yes | Long random string used to sign session cookies. `openssl rand -base64 32` |
| `APP_URL` | no | Public URL (default `http://localhost:3000`) |
| `APP_TIMEZONE` | no | IANA zone for server-rendered times (default `Pacific/Auckland`) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME` | seed only | Used by `pnpm db:seed` when no users exist |
| `ENCRYPTION_KEY` | no | Key for mailbox passwords at rest (derived from `AUTH_SECRET` if unset) |
| `AI_PROVIDER` | no | `auto` (default), `anthropic`, or `rules` |
| `ANTHROPIC_API_KEY` / `AI_MODEL` | for Claude | Model defaults to `claude-opus-5` |
| `AI_LEAD_CONFIDENCE_THRESHOLD` | no | Auto-create leads at or above this confidence (default 0.75) |
| `INGEST_IN_PROCESS` | no | `true` runs the IMAP watcher inside the web server |
| `INGEST_POLL_SECONDS` | no | Backstop poll interval for mailboxes (default 120) |
