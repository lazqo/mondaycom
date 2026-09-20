# Get Secure CRM

A monday.com-style CRM for Get Secure, built around the core workflow:

**Lead → Customer → Quote → Job → Calendar**

v0.1 ships: login, a Leads board (table with inline editing, grouped by status, plus a drag-and-drop
kanban), lead conversion to customer + job (+ optional draft quote), quotes with line items and GST,
jobs with scheduling onto a built-in calendar, user management, and an activity log. Everything is
persisted in PostgreSQL.

See [docs/PLAN.md](docs/PLAN.md) for the full roadmap and [docs/DEPLOY.md](docs/DEPLOY.md) for staging deployment.

## Stack

Next.js 15 (App Router, server actions) · TypeScript · PostgreSQL 16 + Drizzle ORM · Tailwind v4 · dnd-kit ·
Playwright + Vitest. Single app for now; a worker process for email ingestion is next.

## Local development

```bash
pnpm install
docker compose up -d           # Postgres on localhost:5432 (or use your own)
cp .env.example .env           # then set AUTH_SECRET and SEED_ADMIN_PASSWORD
pnpm db:migrate                # apply SQL migrations in ./drizzle
pnpm db:seed -- --sample       # first admin user + a few example leads
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
| `pnpm test:e2e` | Playwright end-to-end test of the core workflow (needs a migrated + seeded DB and a `pnpm build`) |

## Project layout

```
src/app/            routes (App Router). (app)/ is the authenticated shell; login/ is public
src/actions/        server actions: leads, contacts, quotes, jobs, events, users, auth
src/queries/        read queries used by pages
src/components/     UI: leads board (table/kanban/cells), calendar, forms, layout, primitives
src/db/             Drizzle schema + client
src/lib/            auth (JWT cookie sessions), env validation, constants, helpers
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
