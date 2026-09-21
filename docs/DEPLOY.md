# Deploying a staging environment

The app is a single Docker image (see `Dockerfile`). On start it runs pending migrations, then serves
Next.js on `$PORT`. It needs a PostgreSQL 16 database and two secrets. Any host that runs Docker
images with a Postgres add-on works; two one-click options are pre-configured.

## Option A — Railway (recommended)

1. Create a project at https://railway.com → **Deploy from GitHub repo** → pick `lazqo/mondaycom`
   and the branch you want on staging. Railway detects `railway.json` and builds the `Dockerfile`.
2. In the project, **+ New → Database → PostgreSQL**.
3. On the web service → **Variables**, add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference the Postgres service)
   - `AUTH_SECRET` = output of `openssl rand -base64 32`
   - `APP_TIMEZONE` = `Pacific/Auckland`
   - `INGEST_IN_PROCESS` = `true` (email ingestion runs inside the web service)
   - `ANTHROPIC_API_KEY` = your key (optional; without it the offline rules classifier is used)
   - `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` (used once, see step 5)
4. **Settings → Networking → Generate Domain**. Set `APP_URL` to that URL.
5. First-time only — create the admin user. Either open the service's shell (Railway CLI:
   `railway run node scripts/seed.mjs`) or run locally against the staging database:
   ```bash
   DATABASE_URL='<staging url>?sslmode=require' SEED_ADMIN_EMAIL=you@getsecure.co.nz \
   SEED_ADMIN_PASSWORD='choose-a-strong-one' node scripts/seed.mjs
   ```
   Add `--sample` to also insert example leads.
6. Open the domain, sign in, and check `/api/health` returns `{"ok":true,"db":"up"}`.

Every push to the connected branch redeploys; migrations run automatically on boot.

## Option B — Render (Blueprint)

1. https://dashboard.render.com → **New → Blueprint** → connect the repo. `render.yaml` defines the
   web service **and** the Postgres database, and generates `AUTH_SECRET`.
2. When prompted, enter `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`.
3. After the first deploy, open the service **Shell** and run `node scripts/seed.mjs` once.

## Option C — any VPS with Docker

```bash
docker build -t get-secure-crm .
docker run -d --name crm -p 3000:3000 \
  -e DATABASE_URL='postgres://user:pass@host:5432/getsecure' \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e APP_URL='https://crm.example.com' -e APP_TIMEZONE='Pacific/Auckland' \
  get-secure-crm
docker exec -e SEED_ADMIN_EMAIL=you@getsecure.co.nz -e SEED_ADMIN_PASSWORD='…' crm node scripts/seed.mjs
```

Put a TLS-terminating proxy (Caddy, nginx) in front of port 3000.

## Checks after deploy

- `GET /api/health` → `{"ok":true,"db":"up"}`
- Sign in → Leads board loads → create a lead → refresh → it is still there.
- Users → add a second user → sign in as them in a private window.

## Notes

- Session cookies are marked `secure` in production, so the app must be served over HTTPS.
- The Docker image is not built in CI yet (CI runs lint, typecheck, unit and e2e tests). If a host
  fails to build the image, run `docker build .` locally to reproduce.
- Email ingestion runs inside the web process when `INGEST_IN_PROCESS=true`. To run it separately,
  deploy the same image a second time with `PROCESS_TYPE=worker` and set `INGEST_IN_PROCESS=false`
  on the web service. Never run both at once against the same mailbox.
- After deploying, connect the Titan mailbox: see `docs/runbooks/titan-mailbox.md`.
