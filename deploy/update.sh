#!/usr/bin/env bash
# Update production to the latest pushed code, safely:
#   1. show what is running now, and stop if the server has local edits
#   2. back up the database (pg_dump) before anything changes
#   3. pull, rebuild and restart the app (migrations run on container start)
#   4. wait for the app to be healthy, show the migration log, and print the deployed commit
#   5. clean up: keep only the newest pre-update backups, and (after a healthy deploy) remove old
#      Docker build cache and unused images, so the disk does not fill up with every update
#
# Run on the VPS:   cd /opt/getsecure && ./deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"
BACKUPS=/opt/getsecure-backups
# How many pre-update backups to keep on the server (copy them off the VPS too: section 11).
KEEP_BACKUPS="${KEEP_UPDATE_BACKUPS:-5}"

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
if [ ! -s "$DUMP" ]; then
  rm -f "$DUMP"
  echo "!! The backup is empty; not updating."
  exit 1
fi
ls -lh "$DUMP"

echo "== Pulling"
git pull --ff-only
APP_VERSION="$(git rev-parse --short HEAD)"
export APP_VERSION
echo "== Building and restarting $APP_VERSION ($(git log -1 --format=%s))"
$COMPOSE up -d --build

echo "== Waiting for the app to come up (migrations run first)"
HEALTHY=0
for _ in $(seq 1 80); do
  if $COMPOSE exec -T web node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo "== Healthy"
    HEALTHY=1
    break
  fi
  sleep 3
done

echo "== Migration log"
$COMPOSE logs web --since 15m 2>&1 | grep -iE "migrat|error" | tail -20 || true

echo "== Health"
$COMPOSE exec -T web node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>r.text()).then(t=>console.log(t))"

echo "== Cleaning up"
# Pre-update backups: keep the newest $KEEP_BACKUPS (this run's is always the newest).
ls -1t "$BACKUPS"/pre-update-*.dump 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f --
echo "   kept the newest $KEEP_BACKUPS pre-update backups in $BACKUPS ($(du -sh "$BACKUPS" | cut -f1) in total)"
if [ "$HEALTHY" = "1" ]; then
  # Only after a healthy deploy: the running images are never touched, only what nothing uses.
  docker image prune -f >/dev/null || true
  # Build cache unused for a day (a quick second deploy the same day still builds fast).
  docker builder prune -af --filter until=24h >/dev/null || true
  echo "   removed unused images and old build cache"
else
  echo "!! The app did not report healthy: Docker images and build cache were left as they are."
fi
df -h / | tail -1 | awk '{print "   disk: " $3 " used, " $4 " free (" $5 ")"}'

echo "== Deployed $APP_VERSION. If anything is wrong, restore with section 13 of docs/DEPLOYMENT_HANDOFF.md using $DUMP."
