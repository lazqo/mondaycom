# Backups, restore and monitoring

## What needs backing up

One thing: the PostgreSQL database. Customers, leads, quotes, jobs, every email (full original
message), attachments, job photos, settings and mailbox credentials (encrypted) are all in it.
The app itself is rebuilt from git. Nothing is stored on the container's disk.

Two secrets must be kept alongside the backup, or restored data is unusable:
`AUTH_SECRET` (login cookies) and `ENCRYPTION_KEY` (mailbox passwords). Store them in a password manager.

## Automatic backups (managed hosting)

- **Railway**: Postgres service → Backups → enable daily; retention 7–30 days. Restores are a button.
- **Render**: managed Postgres includes daily backups on paid plans; Dashboard → Database → Backups.

Turn this on before real data goes in. Check once a month that a backup exists and that a restore
to a scratch database works.

## Manual backup (any host)

```bash
# Full logical dump, compressed. Works against Railway/Render with the external connection string.
scripts/backup.sh "postgres://user:pass@host:5432/getsecure?sslmode=require" ./backups
# → backups/getsecure-2026-09-21T0300.dump
```

Keep at least the last 14 daily dumps somewhere that is not the same host (S3, Backblaze, a NAS).
A cron entry on any machine with `pg_dump` installed is enough:

```
0 3 * * * /path/to/repo/scripts/backup.sh "$DATABASE_URL" /backups >> /var/log/crm-backup.log 2>&1
```

## Restore

```bash
# Into an empty database (create it first). --clean drops objects that exist, safe on a fresh DB.
pg_restore --no-owner --no-privileges --clean --if-exists -d "postgres://…/getsecure" backups/getsecure-2026-09-21T0300.dump
```

Then point `DATABASE_URL` at it, start the app (migrations are idempotent), sign in, open
**System status** and press **Check for new email** on the Email accounts page. Emails that
arrived after the backup are fetched again from Titan (the IMAP cursor is part of the backup, so
anything newer than the dump is re-imported; Message-ID de-duplication prevents doubles).

## Monitoring

- **Health endpoint**: `GET /api/health` returns `200 {ok:true}` or `503` when the database is
  down. Point UptimeRobot / Better Stack / Pingdom at it every 5 minutes.
- **Detailed health**: send `Authorization: Bearer $HEALTH_TOKEN` to get mailbox sync ages, pending
  email counts, reminder-rule run time and AI provider, plus a `warnings` list. Alert on
  `warnings.length > 0` if your monitor can inspect JSON.
- **In app**: Settings → **System status** shows the same for admins.
- **Logs**: the host's log stream shows `[ingest]` lines for every mailbox connection and sync,
  and `automations:` lines when reminders are created. An `[ingest] … error` line repeating every
  few minutes means the mailbox password or Titan third-party access needs attention.

What "healthy" looks like: database up, each active mailbox checked within 30 minutes, fewer
than 20 emails waiting to classify, reminder rules run within the last hour.

## Retention and privacy

Emails and attachments are kept indefinitely. If a customer asks for their data to be removed,
delete the customer record; leads, quotes, jobs, photos and email links cascade. Original emails
stay in the Inbox unless the thread is deleted from the database directly.
