# Get Secure CRM — Build Plan

A monday.com-style CRM built from scratch for Get Secure, with lead ingestion from
Titan email, AI lead classification, Plaud transcript capture, Apple Calendar sync,
a native calendar, and a dispatch system.

Status: **v0.1 in progress.** See "Build log" at the end for what exists today and how it deviates
from the original plan.

---

## 1. What we are building

One web app with four pillars:

| Pillar | What it does |
| --- | --- |
| **Board engine** | monday.com-style workspaces, boards, groups, items, typed columns, views (table, kanban, calendar, timeline, map), automations, dashboards, activity log, comments, files. |
| **CRM** | Leads → Contacts / Companies → Deals (pipeline) → Quotes → Jobs. Every CRM object is a board item, so it gets all board features for free. |
| **Inbox & capture** | Titan mailbox ingestion, AI lead classification and extraction, Plaud transcript capture attached to the right contact/deal. |
| **Scheduling & dispatch** | Native calendar (two-way synced with Apple/iCloud), dispatch board for assigning jobs to field staff, day/week/map views, mobile-friendly job cards. |

### Assumptions (change these and the plan changes)

- Get Secure is a security services / installs business: leads come in by email, work is done on site by field staff, so "dispatch" means assigning jobs to people with a time window and a location.
- Small team at launch (1–10 users), single company tenant. Multi-tenant SaaS is out of scope; the schema keeps a `workspace_id` so it can be added later.
- Timezone: Pacific/Auckland. All storage in UTC, all display in the user's timezone.
- One Titan mailbox to start (e.g. `info@…` or `sales@…`); more mailboxes later is a config change, not a rebuild.
- One Apple ID's iCloud calendar to sync at launch; per-user calendars later.
- Self-hosted / VPS-style deployment is acceptable (the IMAP listener and sync jobs are long-running processes, which serverless-only hosting cannot run).

---

## 2. Integration research (verified 2026-09-20)

### Titan Email
- No public REST API for reading mail. Access is **IMAP** (`imap.titan.email:993` SSL) and **SMTP** (`smtp.titan.email:465` SSL / `587` STARTTLS).
- Requires "third-party email access" enabled on the account and an **app password** when 2FA is on.
- Plan: a long-running IMAP worker using **IMAP IDLE** (push-like) with a polling fallback every 2 minutes. Track `UIDVALIDITY` + last seen `UID` per folder so restarts never double-ingest.
- Outbound (replies, quotes) go via SMTP from the same mailbox so threads stay intact in Titan.

### Plaud recorder
- Plaud's official **Dev API** (docs.plaud.ai) is a *partner/embedded* API: you bind devices and submit audio for transcription under your own app. It is not a "read my personal Plaud library" API and has no documented webhooks.
- Plaud ships an official **MCP server and CLI** that can search recordings, read transcripts and AI notes for your own account.
- Plaud app can **export** transcripts (TXT/SRT/DOCX/PDF) and share them.
- Plan, in priority order:
  1. **Plaud CLI/MCP puller** — a scheduled job that lists new recordings and pulls transcript + summary (primary path; needs a one-time auth on the server).
  2. **Email-in** — any transcript emailed to a dedicated address (e.g. `notes@…` on Titan) is ingested by the same IMAP pipeline and parsed as a transcript.
  3. **Manual upload / paste** — drop a TXT/SRT/DOCX or paste text on a contact or deal.
  4. **Audio upload → our own transcription** (optional later): if a raw audio file arrives, transcribe server-side.
- Open item to confirm on day one of Phase 5: whether the Plaud CLI can run headless on a server with a long-lived token. If not, path 2 + 3 become primary and path 1 becomes a desktop "sync agent" that runs on your Mac.

### Apple Calendar (iCloud)
- Only route is **CalDAV** at `https://caldav.icloud.com` with your Apple ID + a 16-character **app-specific password** (2FA must be on).
- Full read/write: create, update, delete propagate both ways.
- **No push.** Plan: poll every 2–5 minutes using the CalDAV `sync-collection` report (delta sync via sync-token) so each poll is cheap. Use `ctag` to skip untouched calendars.
- Our calendar is the source of truth for CRM-linked events; iCloud events that are not CRM-linked are mirrored read-mostly so they show up as "busy" in scheduling.
- Optional read-only `.ics` feed per user/team so any calendar app can subscribe to the CRM calendar.

### AI lead classification
- Claude API via the official TypeScript SDK, model `claude-opus-5`, **structured outputs** (`output_config.format`) so every email produces a validated JSON object: `{ is_lead, lead_type, urgency, service_requested, site_address, contact: {name, email, phone, company}, summary, suggested_next_action, confidence }`.
- Adaptive thinking on, `effort: "low"` for classification (fast and cheap; raise per-route if accuracy needs it). Server-side `fallbacks: "default"` enabled so a refusal never drops an email.
- Prompt caching on the stable system prompt + few-shot examples; the email body goes after the cache breakpoint.
- Same call shape reused for transcripts: extract action items, decisions, follow-up date, and which contact/deal it belongs to.
- Every AI result is stored with the raw response and a `reviewed_by` field. Classifications under a confidence threshold land in a "Needs review" group instead of being auto-filed.

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (Next.js app, React, Tailwind, shadcn/ui)                 │
│  - Board grid (TanStack Table + virtualisation)                    │
│  - Kanban / Timeline / Calendar / Map views                        │
│  - Realtime updates via SSE                                        │
└───────────────▲────────────────────────────────────────────────────┘
                │ HTTPS (tRPC + route handlers)
┌───────────────┴───────────────┐      ┌───────────────────────────┐
│  web  (Next.js server)        │      │  worker (Node, BullMQ)    │
│  - auth (Auth.js)             │      │  - imap-listener (IDLE)   │
│  - tRPC API                   │◄────►│  - classify-email (Claude)│
│  - automation trigger emit    │ Redis│  - caldav-sync            │
│  - SSE fan-out                │ jobs │  - plaud-pull             │
│  - file uploads → S3/R2       │ +pub │  - automation-runner      │
└───────────────┬───────────────┘      │  - notifications / email  │
                │                      └─────────────┬─────────────┘
        ┌───────▼──────────────────────────────────────▼──────┐
        │  PostgreSQL 16  (Drizzle ORM, JSONB column values)   │
        │  Redis 7        (queues, pub/sub, cache)             │
        │  S3-compatible object storage (files, audio, raw MIME)│
        └──────────────────────────────────────────────────────┘
```

### Stack decisions

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | **Next.js 15 (App Router) + TypeScript** | One codebase for UI and API, server components for fast board loads. |
| API | **tRPC** | End-to-end types for a column-heavy UI with many small mutations. |
| DB | **PostgreSQL 16 + Drizzle ORM** | JSONB for flexible column values, strong indexing, LISTEN/NOTIFY for realtime. |
| Jobs | **BullMQ on Redis** | Retries, scheduling, rate-limiting for IMAP/CalDAV/Claude jobs. |
| Auth | **Auth.js (email magic link + passkeys)**, roles: admin / member / field | Small team, no password management. |
| Realtime | **SSE** per workspace, backed by Redis pub/sub | Simpler than websockets; enough for board updates and dispatch changes. |
| UI kit | **Tailwind + shadcn/ui**, **TanStack Table**, **dnd-kit**, **FullCalendar** (or custom), **MapLibre** | Proven pieces for grid, drag-drop, calendar, map. |
| Email | **imapflow** (IMAP IDLE), **mailparser**, **nodemailer** (SMTP) | Mature Node IMAP/SMTP libs. |
| CalDAV | **tsdav** + **ical.js** | CalDAV client with sync-collection support; robust iCalendar parsing. |
| AI | **@anthropic-ai/sdk**, `claude-opus-5`, structured outputs | See §2. |
| Files | **S3-compatible** (Cloudflare R2 or MinIO in dev) | Cheap, works everywhere. |
| Monorepo | **pnpm workspaces + Turborepo**: `apps/web`, `apps/worker`, `packages/db`, `packages/core`, `packages/ui`, `packages/integrations` | Shared types between web and worker. |
| Dev env | **Docker Compose** (Postgres, Redis, MinIO, Mailpit) | One command to run everything locally. |
| Deploy | **Docker images → single VPS or Railway/Fly** (web + worker + managed Postgres/Redis) | Long-running IMAP/CalDAV workers need always-on processes. |
| Testing | **Vitest** (unit), **Playwright** (e2e), seeded fixture mailbox & CalDAV mock | Integrations are the risk; test them. |

---

## 4. Data model (core)

Board engine tables (everything else is built on these):

```
workspaces          id, name, settings
users               id, email, name, role, timezone, avatar
boards              id, workspace_id, name, kind (generic|leads|contacts|companies|deals|jobs|dispatch), settings
groups              id, board_id, title, color, position
columns             id, board_id, type, title, settings(jsonb), position, is_system
items               id, board_id, group_id, name, position, created_by, archived_at
item_values         item_id, column_id, value(jsonb), text_search(tsvector)   -- one row per cell
views               id, board_id, type (table|kanban|calendar|timeline|map|dashboard), config(jsonb)
updates             id, item_id, author_id, body(richtext), created_at        -- comments / activity posts
activity_log        id, workspace_id, entity, entity_id, actor_id, action, diff(jsonb), created_at
files               id, owner_entity, owner_id, storage_key, mime, size, name
automations         id, board_id, trigger(jsonb), conditions(jsonb), actions(jsonb), enabled
automation_runs     id, automation_id, item_id, status, log(jsonb), ran_at
notifications       id, user_id, kind, payload, read_at
```

Column types (v1): text, long_text, number, status (labels + colors), people, date, timeline (start/end), checkbox, dropdown, email, phone, link, location (address + lat/lng), files, connect_boards (item link), mirror (read-through of a linked item's column), formula (server-evaluated), created_at, last_updated, auto_number.

CRM tables (typed projections over board items, so both the grid and the domain logic can use them):

```
contacts            item_id, first_name, last_name, email, phone, company_id, source
companies           item_id, name, domain, phone, address, ...
leads               item_id, status, source, classification(jsonb), email_thread_id, converted_to_deal_id
deals               item_id, stage, value, probability, expected_close, contact_id, company_id, owner_id
quotes              id, deal_id, number, line_items(jsonb), total, status, sent_at, accepted_at
jobs                item_id, deal_id, site_address, geo, window_start, window_end, status, assigned_to[]
```

Capture tables:

```
mailboxes           id, provider (titan), address, imap_host, smtp_host, credentials_ref, last_uid, uidvalidity
email_threads       id, mailbox_id, subject, participants[], last_message_at, linked_item_id
emails              id, thread_id, message_id, in_reply_to, from, to[], subject, text, html, raw_key, received_at
email_classifications id, email_id, model, result(jsonb), confidence, raw_response(jsonb), reviewed_by
transcripts         id, source (plaud_cli|email|upload), external_id, recorded_at, duration, title, text, summary, extraction(jsonb), linked_item_id, audio_key
```

Calendar tables:

```
calendars           id, owner_user_id, name, color, kind (crm|icloud_mirror), caldav_url, sync_token, ctag
events              id, calendar_id, uid, summary, description, location, starts_at, ends_at, all_day, rrule, attendees[], linked_item_id, etag, last_synced_at, origin (crm|icloud)
event_sync_log      id, event_id, direction, result, error
availability        user_id, weekday, start, end          -- working hours for dispatch
```

Design rules:
- **Every CRM record is a board item.** The typed table holds a copy of the "system" columns for fast queries; the board engine holds the same values in `item_values`. A single write path (`items.setValue`) keeps them in sync inside one transaction.
- **Soft delete everywhere**, activity log on every mutation.
- **Idempotency keys** on all inbound integrations (`message_id`, CalDAV `uid`+`etag`, Plaud recording id).

---

## 5. Feature specification

### 5.1 Board engine (monday.com parity, v1)
- Workspace sidebar with folders and boards; favourites; search (Postgres full-text across item names and text cells).
- Table view: groups (collapsible, colored), inline cell editing per column type, add column, reorder/resize columns, multi-select + bulk edit, sort, filter (per column, saved filters), group by, virtualised rows (10k+ items).
- Kanban view: group by any status/dropdown column, drag between lanes.
- Calendar view: from any date or timeline column.
- Timeline view: Gantt-style bars from timeline columns, drag to reschedule.
- Map view: from a location column (used by dispatch).
- Item panel: side drawer with all columns, Updates (comments with @mentions and files), Activity log, linked items, emails, transcripts, events.
- Automations: trigger → conditions → actions, built from a recipe list ("When status changes to X, notify Y", "When item created, assign to Z", "Every day at 8am, if date is past, set status Overdue", "When email classified as lead, create item in Leads"). Runs in the worker; logs each run.
- Dashboards: widgets (numbers, bar/line chart, funnel, calendar, table) over one or more boards with filters.
- Notifications: in-app bell + email digests; @mentions, assignments, automation notifications.
- Permissions: workspace roles; board-level view/edit; "field" role sees only assigned jobs and the dispatch mobile view.
- Import/export: CSV import with column mapping; CSV export of any view.
- Keyboard-first grid, undo for cell edits, optimistic updates, live updates from other users.

### 5.2 CRM
- Boards created on setup: **Leads**, **Contacts**, **Companies**, **Deals**, **Quotes**, **Jobs**, **Dispatch** (a view over Jobs), plus an **Inbox** board for unclassified mail.
- Lead lifecycle: New → Contacted → Qualified → Quoted → Won/Lost. "Convert" creates Contact + Company (dedupe on email/domain/phone) and a Deal, keeping the email thread attached.
- Deal pipeline with stages, value, probability, weighted forecast dashboard.
- Quotes: line items, tax, PDF generation, send by email via Titan SMTP, accept link → Deal Won → Job created.
- Jobs: site address (geocoded), time window, required skills, assigned staff, checklist, on-site notes, photos, status (Scheduled → En route → On site → Done → Invoiced).
- Contact/company 360 view: all emails, transcripts, events, deals, jobs on one panel.
- Duplicate detection on contact create and email ingest.

### 5.3 Inbox & lead capture (Titan)
- Mailbox setup screen: address, app password (stored encrypted with a server-side key, never returned to the client), folders to watch, "send as" identity.
- IMAP worker: IDLE on INBOX; on each new message → store raw MIME in object storage → parse → thread by `In-Reply-To`/`References`/subject → enqueue classification.
- Classification job: Claude structured output (see §2). Outcomes:
  - `is_lead && confidence ≥ 0.8` → create/merge Lead item in Leads board, link thread, set fields from extraction, fire automations.
  - `is_lead && confidence < 0.8` → item in Leads "Needs review" group with the AI's suggestion shown inline; one-click accept/fix.
  - not a lead → filed in Inbox board (still searchable, can be manually converted).
  - Known contact → thread attached to their Contact and any open Deal.
- Reply from inside the CRM (SMTP), with templates; sent mail is stored and threaded.
- "Email titles" list: an Inbox view showing subject, from, date, AI label, linked item, which was the original ask.

### 5.4 Transcripts (Plaud)
- Sources per §2: CLI/MCP pull job, email-in, upload/paste.
- On ingest: store text + optional audio; run extraction (attendees, summary, action items with dates, next steps, sentiment, "which contact/deal is this about" by matching names/emails/phones against the CRM).
- Attach to the matched item; if no confident match, land in a "Transcripts — unmatched" group for manual linking.
- Action items become checklist entries or new tasks on the linked item; dates become calendar events on request.

### 5.5 Calendar (native + Apple)
- Native calendar: day/week/month/agenda; team view (one lane per person); create from any item; events link back to items; reminders → notifications.
- Apple sync per §2: connect screen (Apple ID + app-specific password), choose which iCloud calendars to mirror and which one receives CRM events. Conflict rule: last-writer-wins by `DTSTAMP`, with a conflict entry in `event_sync_log` and a notification if both sides changed within one poll window.
- Free/busy: merges CRM events + mirrored iCloud events + working hours → used by dispatch to suggest slots.
- ICS subscription feed per user.

### 5.6 Dispatch
- Dispatch board = Jobs filtered to a date range, with three synced views:
  - **Schedule**: lanes per staff member, hours across; drag a job to assign/reschedule; unassigned jobs in a tray; conflicts highlighted; travel-time gaps estimated from geocodes (straight-line first, routing API later).
  - **Map**: pins by status/assignee, cluster, click to open job, "nearest available" helper.
  - **List**: table view with bulk actions.
- Field mobile view (responsive, installable PWA): today's jobs, navigate button, status buttons (En route / On site / Done), notes, photos, customer signature.
- Customer notifications (optional): email on scheduled / en route via Titan SMTP.
- Every assignment writes a calendar event for the assignee, which syncs to Apple.

---

## 6. Phased roadmap

Each phase ends with something usable. Estimates assume one full-time engineer plus AI assistance; run phases 3–6 in parallel if there are more hands.

| # | Phase | Deliverable | Est. |
| --- | --- | --- | --- |
| 0 | **Foundation** | Monorepo, Docker Compose, Postgres/Drizzle schema for board engine, auth, workspace/user admin, CI (lint, typecheck, unit, e2e smoke), deploy pipeline to staging. | 1 wk |
| 1 | **Board engine core** | Boards, groups, items, columns (all v1 types), table view with inline editing, filters/sort/search, item panel with updates and activity, realtime SSE, CSV import/export. | 3 wk |
| 2 | **CRM objects** | Leads/Contacts/Companies/Deals/Jobs boards with system columns, convert-lead flow, dedupe, 360 panel, kanban view, pipeline dashboard. | 2 wk |
| 3 | **Titan inbox + AI classification** | Mailbox connect, IMAP IDLE worker, threading, Claude classification with structured outputs, auto-create leads, needs-review queue, reply via SMTP, Inbox board. | 2 wk |
| 4 | **Native calendar + Apple sync** | Calendar model, day/week/month/team views, events linked to items, CalDAV connect + delta sync both ways, conflict log, ICS feed. | 2 wk |
| 5 | **Plaud transcripts** | CLI/MCP pull job (or desktop sync agent if headless auth is not possible), email-in and upload paths, extraction, auto-linking, action items. | 1.5 wk |
| 6 | **Dispatch** | Jobs schedule lanes, drag assign/reschedule, map view, free/busy from calendar, field PWA with status/photos/signature, assignment → calendar event. | 3 wk |
| 7 | **Automations & dashboards** | Recipe builder, worker runner, run logs, dashboard widgets, notifications and digests. | 2 wk |
| 8 | **Quotes & polish** | Quotes with PDF + accept link, timeline view, formula/mirror columns, permissions hardening, performance pass (10k items), backups, monitoring, docs. | 2 wk |

Total: ~18–19 weeks sequential; ~12 weeks with two engineers.

### Milestone checkpoints
- **M1 (end of Phase 2):** you can run the business manually in it: add leads, move deals, book jobs.
- **M2 (end of Phase 4):** leads arrive from Titan on their own and appointments show in Apple Calendar.
- **M3 (end of Phase 6):** field staff run their day from their phone.
- **M4 (end of Phase 8):** feature-complete v1.

---

## 7. Repository layout

```
.
├── apps/
│   ├── web/                 # Next.js app (UI + tRPC API)
│   └── worker/              # BullMQ workers: imap, classify, caldav, plaud, automations, notify
├── packages/
│   ├── db/                  # Drizzle schema, migrations, seed
│   ├── core/                # board engine domain logic, column types, automation runner, CRM services
│   ├── integrations/        # titan (imap/smtp), caldav, plaud, anthropic client + prompts
│   ├── ui/                  # shared React components (grid, cells, kanban, calendar)
│   └── config/              # eslint, tsconfig, tailwind presets
├── docs/
│   ├── PLAN.md              # this file
│   ├── adr/                 # architecture decision records
│   └── runbooks/            # mailbox setup, Apple app password, Plaud auth, backups
├── docker-compose.yml       # postgres, redis, minio, mailpit
├── turbo.json
└── package.json             # pnpm workspaces
```

---

## 8. Security & operations

- Secrets (Titan app password, Apple app-specific password, Anthropic key, Plaud token) encrypted at rest with a KMS/env master key; never sent to the browser; rotated from an admin screen.
- Raw email and audio stored in private object storage with signed URLs.
- Audit log for every read of a credential and every AI call (model, tokens, cost).
- Rate limits and backoff on IMAP, CalDAV, and Claude calls; dead-letter queue with an admin "retry" screen.
- Nightly Postgres backups + object storage lifecycle rules; restore runbook tested in Phase 8.
- Health endpoints for web and each worker; uptime alerts; Sentry for errors.
- Data residency: choose a NZ/AU region for DB and storage.

---

## 9. Risks and open questions

| Risk / question | Mitigation |
| --- | --- |
| Plaud CLI may not run headless on a server. | Phase 5 day 1 spike. Fallback: email-in + upload, or a small Mac menu-bar sync agent. |
| iCloud CalDAV has no push; sync latency 2–5 min. | Acceptable for scheduling; dispatch UI shows "synced X min ago". |
| Titan IMAP session limits / IDLE drops. | Reconnect with backoff, poll fallback, one connection per mailbox. |
| AI misclassifies a lead. | Confidence threshold + needs-review group; all decisions reversible; feedback stored for prompt tuning and an eval set in Phase 3. |
| Flexible JSONB columns vs. query speed. | Typed CRM projections for hot paths; GIN indexes on `item_values`; virtualised grid. |
| Scope creep toward full monday.com. | v1 column/view/automation lists in §5 are the contract; anything else goes to a v2 backlog. |

Questions to answer before Phase 0 (defaults in bold if unanswered):
1. Which Titan mailbox(es) should feed leads? (**one shared sales inbox**)
2. Which iCloud calendar receives CRM events, and whose Apple ID? (**one business calendar under your Apple ID**)
3. How many field staff at launch, and do they need logins or just a link to their day? (**logins, "field" role**)
4. Hosting preference: your own VPS vs. managed (Railway/Fly + managed Postgres)? (**managed, NZ/AU region**)
5. Do quotes need invoicing/accounting sync (Xero)? (**out of v1; Xero is a v2 item**)

---

## 10. Next step

Start Phase 0: scaffold the monorepo, schema, auth, Docker Compose, and CI on this branch, then begin Phase 1's board engine.


---

## Build log

### v0.1 — core workflow slice (2026-09-20)

Scope was deliberately narrowed to the Get Secure workflow **Lead → Customer → Quote → Job → Calendar**
instead of the full board engine. What shipped:

- Login (email + password, signed cookie sessions), admin user management.
- Leads board with the columns Lead | Company | Phone | Email | Service | Site | Status | Assigned To |
  Follow-up | Last Contact | Source, grouped by status (New → Contacted → Site Visit → Quote Required →
  Quote Sent → Won / Lost), inline cell editing, and a drag-and-drop kanban view.
- Lead detail page with full edit form, activity log, and **Convert** (new or existing customer, optional
  job, optional draft quote, optional mark-as-won).
- Customers (contacts) list/detail with linked leads, quotes and jobs.
- Quotes with line items and GST; marking a quote sent/accepted/declined moves the originating lead to
  Quote Sent / Won / Lost, and accepting creates the job if none exists.
- Jobs with status flow and a **Schedule** card that creates/updates a calendar event.
- Built-in calendar (month + week), standalone events, job events link back to the job.
- PostgreSQL schema via Drizzle migrations; Dockerfile; Railway/Render configs; GitHub Actions CI
  running lint, typecheck, unit tests and a Playwright e2e of the whole flow.

Deviations from the plan, and why:

- **Typed tables instead of the generic board engine.** Leads/contacts/quotes/jobs are ordinary tables
  with fixed columns. This got a usable CRM out in one slice; the generic column/board engine is still
  the plan for later phases and the typed tables become its "system columns" when it lands.
- **Server actions instead of tRPC**, single Next.js app instead of a monorepo. Less scaffolding for
  the same result at this size. The worker for email ingestion will be a second entry point in this
  repo, sharing `src/db` and `src/lib`.
- **No Redis yet.** Nothing needs a queue until IMAP ingestion arrives.

### v0.2 — Titan email ingestion (2026-09-21)

- **Mailboxes** (admin): connect a Titan mailbox over IMAP/SMTP, test the connection, sync now,
  pause/remove. Passwords are AES-256-GCM encrypted at rest.
- **Ingestion**: IMAP IDLE watcher with a polling backstop, runnable inside the web process
  (`INGEST_IN_PROCESS=true`) or as a separate worker (`PROCESS_TYPE=worker`). Per-mailbox UID cursor
  plus Message-ID uniqueness means no duplicates across restarts or UIDVALIDITY changes.
- **Storage**: full original MIME, parsed text/HTML, headers, attachments; threading by
  References/In-Reply-To, then normalised subject + counterpart within 30 days.
- **AI layer** (`src/lib/ai`): one `LeadClassifier` interface; `AnthropicClassifier` (Claude with
  structured output, prompt caching, low effort) and `RulesClassifier` (offline, deterministic, used
  in CI). Extracts name, company, email, phone, service, site, summary, urgency, next action, plus a
  confidence and a reason. Every result is stored with provider/model/tokens and the reviewer's decision.
- **Pipeline**: existing-thread and known-customer matching first (no AI call), automated-mail
  prefilter, then classification → auto-create Lead (confidence ≥ 0.75) / Needs review / Not a lead.
- **Inbox**: sender, subject, received, classification, linked lead/customer; tabs and search; thread
  view with original HTML in a sandboxed frame, attachments, AI assessment panel (accept, edit &
  create, not a lead, re-run), link/unlink to existing lead/customer/job, and a reply composer that
  sends through Titan SMTP, threads correctly, stores the outbound message and copies it to Sent.
  No AI-written replies are ever sent.
- **Leads**: email-sourced leads carry summary, urgency, next action, AI confidence and an envelope
  link to the thread; the lead page shows the original email.
- **Tests**: unit (parser, rules classifier, crypto), integration against Postgres + a local Dovecot
  IMAP server (fetch, incremental cursor, IDLE detection, SMTP reply threading), and Playwright e2e
  proving a delivered email appears on the Leads board with extracted fields and the original email.
  CI installs Dovecot and runs all of it.

Deviation: the Anthropic provider is code-complete but was exercised only through its interface in
this environment (no API key available here); the offline rules provider drives the automated tests.
First production run should watch the Inbox "Needs review" tab and the stored confidences.

### v0.3 — Today, calendar & dispatch, My Day, follow-up automations (2026-09-21)

- **Today** (`/dashboard`, the new home): overdue tasks, tasks due today, Needs review emails,
  today's jobs and site visits, unassigned jobs, new leads, leads with a follow-up date reached,
  quotes waiting on action (draft or sent). Manual tasks can be added and completed inline.
- **Calendar**: day view with one lane per technician (plus Unassigned), week time grid, month
  overview. Job chips are coloured by job status and show customer, time, technician and address;
  clicking opens the job. Drag a chip to another slot or lane to reschedule/reassign (15-minute
  snap, duration kept). Unscheduled jobs sit in a tray and drop onto the grid to schedule (2-hour
  default). Site visits are booked from the lead page and appear on the calendar and Today.
- **Jobs**: statuses are now Unscheduled → Scheduled → En Route → On Site → Done → Invoiced
  (+ Cancelled); notes and photos (stored in Postgres, served through an authenticated route).
- **My Day** (`/my-day`): mobile-friendly list of the signed-in technician's jobs for a day (admins
  can pick anyone) with map and call links, one-tap status advance, add note, add photo (camera
  capture on phones), plus that person's reminders.
- **Automations** (internal only, never emails customers): new lead not contacted, site visit done
  but no quote, quote sent with no response, job done but not invoiced, follow-up date reached.
  Each creates one open task per entity, re-runs never duplicate, tasks auto-resolve when the
  condition clears, dismissed ones stay dismissed. Thresholds live in Settings → Automations.
  Scheduling or moving a job notifies the assignee in-app (email optional). The runner executes
  every five minutes inside the ingestion loop and on dashboard load.
- **Notifications** bell in the sidebar.
- **Settings → AI**: active provider, model, threshold, recent classifications with review outcome,
  and a no-side-effects smoke test over the bundled enquiries. `pnpm ai:smoke` does the same from
  the command line, including over the latest real emails.

Staging checkpoint (deploy, real Titan mailbox, live AI) is documented step by step in
`docs/runbooks/staging-checkpoint.md`; it needs the hosting account, mailbox app password and API
key, which only the owner holds.

### v0.4 — production-readiness and operational polish (2026-09-21)

- **First-run setup** (`/setup`): with no users in the database the login page sends you to a
  create-admin form; afterwards a six-step checklist (admin, staff, Titan mailbox, AI, business
  hours/reminder thresholds, start) derives its state from real data and can be re-opened from
  the Today banner. Seeding is optional.
- **Roles**: Admin, Office (member) and Technician (field). Technicians land on My day and only
  see My day, Customers, Jobs and Calendar; settings, inbox, leads and quotes redirect them away,
  and the underlying server actions enforce the same rule. Staff page lets an admin change roles.
- **Terminology and navigation**: Tasks → Reminders, Contacts → Customers, Automations → Reminders,
  Mailboxes → Email accounts, Users → Staff, AI → Email AI; classification labels read "New lead /
  Needs review / Not a lead / Known customer / Sent by us"; plain-language empty states everywhere.
- **Today**: greeting in NZ time, sections renamed and capped at eight rows with a "more" link,
  all times rendered in `APP_TIMEZONE` on the server (previously UTC slipped into a few lists).
- **Mobile**: header no longer wraps; nav scrolls horizontally; search sits under the header.
- **Needs review**: Lead / Not a lead buttons directly on the list; on the thread page, accepting
  opens the new lead with a "Next to review" link so a backlog can be cleared in one pass.
- **Connected flow**: a journey bar (Lead → Site visit → Quote → Job → Done) on lead, quote and
  job pages with the one next action; customer page has a full history timeline with filters and
  free-text notes; search (`/search`) matches name, company, phone digits, email, site address,
  quote and job numbers and email subjects.
- **Notifications**: readable text, relative time, dismiss one or clear all.
- **Security / operations**: security headers, login rate limiting, JSON 401 for `/api/*`,
  private no-store caching on attachments and photos, `/api/health` (minimal unless admin or
  `HEALTH_TOKEN`), Settings → System status, `scripts/backup.sh`, `pnpm env:check`,
  `docs/PRODUCTION_ENV.md` and `docs/runbooks/backup-and-monitoring.md`.
- Migration `0003` adds the `field` role.

Staging checkpoint still needs the hosting account, Titan app password and Anthropic key; with
those, `docs/runbooks/staging-checkpoint.md` can be followed without further development.

Next (after a period of real use): quote PDF + send-by-email, customer notifications on scheduling
(with approval), Apple Calendar sync, Plaud transcripts, Xero, and the generic board engine.
