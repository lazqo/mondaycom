#!/usr/bin/env bash
# Update production to the latest pushed code, safely:
#   1. show what is running now, and stop if the server has local edits
#   2. back up the database (pg_dump) before anything changes
#   3. pull, rebuild and restart the app (migrations run on container start)
#   4. wait for the app to be healthy, show the migration log, and print the deployed commit
#
# Run on the VPS:   cd /opt/getsecure && ./deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"
BACKUPS=/opt/getsecure-backups

echo "== Running now: $(git rev-parse --short HEAD) ($(git log -1 --format=%s)) on branch $(git rev-parse --abbrev-ref HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "!! The server has local changes to tracked files; not updating. Review them first:"
  git status --short --untracked-files=no
  exit 1
fi

mkdir -p "$BACKUPS"
DUMP="$BACKUPS/pre-update-$(date -u +%Y-%m-%dT%H%M).dump"
echo "== Backing up the database to $DUMP"
$COMPOSE exec -T db pg_dump --format=custom --no-owner --no-privileges -U getsecure getsecure > "$DUMP"
ls -lh "$DUMP"

echo "== Pulling"
git pull --ff-only
APP_VERSION="$(git rev-parse --short HEAD)"
export APP_VERSION
echo "== Building and restarting $APP_VERSION ($(git log -1 --format=%s))"
$COMPOSE up -d --build

echo "== Waiting for the app to come up (migrations run first)"
for _ in $(seq 1 80); do
  if $COMPOSE exec -T web node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo "== Healthy"
    break
  fi
  sleep 3
done

echo "== Migration log"
$COMPOSE logs web --since 15m 2>&1 | grep -iE "migrat|error" | tail -20 || true

echo "== Health"
$COMPOSE exec -T web node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>r.text()).then(t=>console.log(t))"

echo "== Deployed $APP_VERSION. If anything is wrong, restore with section 13 of docs/DEPLOYMENT_HANDOFF.md using $DUMP."
