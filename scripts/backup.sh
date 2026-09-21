#!/usr/bin/env bash
# pg_dump the CRM database to a timestamped, compressed file.
# Usage: scripts/backup.sh <DATABASE_URL> [output-dir]
set -euo pipefail
URL="${1:?DATABASE_URL required}"
OUT="${2:-./backups}"
mkdir -p "$OUT"
STAMP="$(date -u +%Y-%m-%dT%H%M)"
FILE="$OUT/getsecure-$STAMP.dump"
pg_dump --format=custom --no-owner --no-privileges --file "$FILE" "$URL"
echo "wrote $FILE ($(du -h "$FILE" | cut -f1))"
# Keep the newest 30 dumps in this folder.
ls -1t "$OUT"/getsecure-*.dump 2>/dev/null | tail -n +31 | xargs -r rm -f
