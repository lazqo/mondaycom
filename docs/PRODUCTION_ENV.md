# Production environment checklist

Every variable the app reads, what it is for, and whether staging needs it. Set these on the
hosting service — on a VPS that is `/opt/getsecure/.env`, read by `docker-compose.prod.yml`. Never commit
real values. `pnpm env:check` validates a local `.env` against this list.

## Required

| Variable | Example | Why |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://user:pass@host:5432/getsecure?sslmode=require` | PostgreSQL 16. Holds everything: customers, leads, emails, attachments, job photos. Managed hosts inject this. |
| `AUTH_SECRET` | `openssl rand -base64 32` | Signs login cookies. Changing it signs everyone out. Keep it out of logs. |
| `APP_URL` | `https://hermes.aucklandsecuritysystems.co.nz` | Public URL, used in staff notification emails and links. |
| `APP_TIMEZONE` | `Pacific/Auckland` | "Today", follow-up dates, business hours and reminder timing all use this. |

## Email ingestion (Titan)

| Variable | Example | Why |
| --- | --- | --- |
| `INGEST_IN_PROCESS` | `true` | Run the IMAP watcher inside the web app (single service). Set `false` if you run a separate worker (`PROCESS_TYPE=worker`). Never both against one mailbox. |
| `INGEST_POLL_SECONDS` | `120` | Backstop poll interval; IMAP IDLE reacts sooner. |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` | Encrypts mailbox passwords at rest. Optional: derived from `AUTH_SECRET` if unset, but set it so rotating `AUTH_SECRET` doesn't lock mailboxes. |

Mailbox credentials themselves are entered in the app (Settings → Email accounts), not in env.

## Lead classification

Hermes reads every email and conversation. There is no separate classifier, Anthropic account or API key.

| Variable | Example | Why |
| --- | --- | --- |
| `HERMES_API_URL` | `http://host.docker.internal:8642/p/inspector` | Hermes Agent's API server, on the restricted `inspector` profile (CRM tools only, no terminal or file access). With this and `HERMES_API_KEY` unset, Hermes is not connected and every new email and conversation waits in the Inspector for Chris. See section 17 of `docs/DEPLOYMENT_HANDOFF.md`. |
| `HERMES_API_KEY` | `openssl rand -hex 32` | The inspector profile's `API_SERVER_KEY` (in `~/.hermes/profiles/inspector/.env`). |
| `HERMES_MCP_TOKEN` | `openssl rand -hex 32` | Turns on `/api/mcp`, the CRM's tools for Hermes (read, and prepare/propose only). At least 24 characters. Unset = the endpoint is off. |
| `HERMES_MODEL` | `hermes-agent` | Optional: the model/profile name Hermes exposes. |
| `HERMES_TIMEOUT_MS` | `120000` | Optional: how long to wait for Hermes before falling back to review. |
| `HERMES_MIN_CONFIDENCE` | `0.6` | Optional floor for every threshold on the autonomy dial. Normally unset: Settings → Hermes sets the dial. |
| `HERMES_RESEARCH_API_URL` | `http://host.docker.internal:8642/p/research` | Optional: Hermes's separate **research** profile (web access and the CRM's supplier tools; never customer email). Unset = research is off (questions are recorded, not answered). |
| `HERMES_RESEARCH_API_KEY` | `openssl rand -hex 32` | The research profile's `API_SERVER_KEY` (in `~/.hermes/profiles/research/.env`). |
| `HERMES_RESEARCH_MCP_TOKEN` | `openssl rand -hex 32` | The research profile's bearer token for `/api/mcp`: it sees only the supplier and candidate-update tools. At least 24 characters, different from `HERMES_MCP_TOKEN`. |
| `HERMES_RESEARCH_MODEL` / `HERMES_RESEARCH_TIMEOUT_MS` | `hermes-agent` / `180000` | Optional. |

Note: a forwarded enquiry's sender is the forwarder, not the customer — see section 9 of
`docs/DEPLOYMENT_HANDOFF.md`.

## Operations

| Variable | Example | Why |
| --- | --- | --- |
| `HEALTH_TOKEN` | `openssl rand -hex 16` | Lets an uptime monitor read the detailed `/api/health` with `Authorization: Bearer <token>`. Without it monitors still get `{ok, db}`. |
| `PORT` | `3000` | Injected by the host. |
| `NODE_ENV` | `production` | Set by the Docker image. |
| `PROCESS_TYPE` | `web` / `worker` | Which process the container runs (Docker entrypoint). |
| `APP_VERSION` | git sha | Optional; shown on System status. |

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
- [ ] No `AI_PROVIDER`, `ANTHROPIC_API_KEY` or `JEV_*` variables: they are gone. Hermes is set up per section 17 of `docs/DEPLOYMENT_HANDOFF.md`.
- [ ] `HEALTH_TOKEN` set and an uptime monitor polling `/api/health` every 5 minutes.
- [ ] Opened `/setup` and completed the checklist; the seed variables are removed afterwards.
