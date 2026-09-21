# Production environment checklist

Every variable the app reads, what it is for, and whether staging needs it. Set these on the
hosting service (Railway/Render variables, or a `.env` file the container can read). Never commit
real values. `pnpm env:check` validates a local `.env` against this list.

## Required

| Variable | Example | Why |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://user:pass@host:5432/getsecure?sslmode=require` | PostgreSQL 16. Holds everything: customers, leads, emails, attachments, job photos. Managed hosts inject this. |
| `AUTH_SECRET` | `openssl rand -base64 32` | Signs login cookies. Changing it signs everyone out. Keep it out of logs. |
| `APP_URL` | `https://crm.getsecure.co.nz` | Public URL, used in staff notification emails and links. |
| `APP_TIMEZONE` | `Pacific/Auckland` | "Today", follow-up dates, business hours and reminder timing all use this. |

## Email ingestion (Titan)

| Variable | Example | Why |
| --- | --- | --- |
| `INGEST_IN_PROCESS` | `true` | Run the IMAP watcher inside the web app (single service). Set `false` if you run a separate worker (`PROCESS_TYPE=worker`). Never both against one mailbox. |
| `INGEST_POLL_SECONDS` | `120` | Backstop poll interval; IMAP IDLE reacts sooner. |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` | Encrypts mailbox passwords at rest. Optional: derived from `AUTH_SECRET` if unset, but set it so rotating `AUTH_SECRET` doesn't lock mailboxes. |

Mailbox credentials themselves are entered in the app (Settings → Email accounts), not in env.

## Email AI (Anthropic)

| Variable | Example | Why |
| --- | --- | --- |
| `AI_PROVIDER` | `auto` | `auto` uses Claude when a key is present, else offline rules. `anthropic` forces Claude (fails without key). `rules` forces offline. |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | From console.anthropic.com. Costs money per email classified (cents). |
| `AI_MODEL` | `claude-opus-5` | Model id. |
| `AI_LEAD_CONFIDENCE_THRESHOLD` | `0.75` | Auto-create leads at or above this; below goes to Needs review. Raise to `0.9` to be cautious. |

## Operations

| Variable | Example | Why |
| --- | --- | --- |
| `HEALTH_TOKEN` | `openssl rand -hex 16` | Lets an uptime monitor read the detailed `/api/health` with `Authorization: Bearer <token>`. Without it monitors still get `{ok, db}`. |
| `PORT` | `3000` | Injected by the host. |
| `NODE_ENV` | `production` | Set by the Docker image. |
| `PROCESS_TYPE` | `web` / `worker` | Which process the container runs (Docker entrypoint). |
| `APP_VERSION` | git sha | Optional; shown on System status. Railway/Render commit vars are picked up automatically. |

## First-run only

Not needed once the first admin exists. Either open `/setup` after deploying (recommended) or seed:

| Variable | Why |
| --- | --- |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | Used by `node scripts/seed.mjs` when the users table is empty. |

## Local development / tests only

`IMAP_TLS_REJECT_UNAUTHORIZED`, `SMTP_TLS_REJECT_UNAUTHORIZED` (`false` for self-signed test servers), `DOVECOT_TEST_PORT`, `E2E_*`. Never set these in production.

## Go-live checklist

- [ ] `AUTH_SECRET` and `ENCRYPTION_KEY` are unique random values (not the `.env.example` text).
- [ ] `DATABASE_URL` points at a managed Postgres with automatic daily backups turned on.
- [ ] `APP_URL` is the HTTPS domain; the host terminates TLS (cookies are `Secure` in production).
- [ ] `APP_TIMEZONE=Pacific/Auckland`.
- [ ] `INGEST_IN_PROCESS=true` on exactly one running instance.
- [ ] `ANTHROPIC_API_KEY` set and `AI_PROVIDER=auto` (or `rules` until you have reviewed the smoke test).
- [ ] `HEALTH_TOKEN` set and an uptime monitor polling `/api/health` every 5 minutes.
- [ ] Opened `/setup` and completed the checklist; the seed variables are removed afterwards.
