#!/usr/bin/env bash
# Nightly database backup with a size limit on the server: one pg_dump, checked, and only the
# newest copies kept. Copy the dumps off the VPS as well (docs/DEPLOYMENT_HANDOFF.md section 11).
#
#   crontab -e:
#   0 3 * * * /opt/getsecure/deploy/backup.sh >> /var/log/crm-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUPS=/opt/getsecure-backups
KEEP="${KEEP_NIGHTLY_BACKUPS:-14}"
mkdir -p "$BACKUPS"
DUMP="$BACKUPS/getsecure-$(date -u +%Y-%m-%dT%H%M).dump"

docker compose -f docker-compose.prod.yml exec -T db pg_dump --format=custom --no-owner --no-privileges -U getsecure getsecure > "$DUMP"
if [ ! -s "$DUMP" ]; then
  rm -f "$DUMP"
  echo "$(date -u +%FT%TZ) backup FAILED: empty dump" >&2
  exit 1
fi
# Keep the newest $KEEP nightly backups (pre-update backups are managed by deploy/update.sh).
ls -1t "$BACKUPS"/getsecure-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
echo "$(date -u +%FT%TZ) backup ok: $DUMP ($(du -h "$DUMP" | cut -f1)); kept the newest $KEEP"
