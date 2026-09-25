#!/usr/bin/env bash
# Start a throwaway CalDAV server (Radicale) for tests, standing in for the Titan calendar.
# Requires Radicale (pip install radicale; set RADICALE_PYTHON to a venv's python if it lives in one).
# Usage: tests/support/caldav/start.sh [port]   (default 5232)
# Creates one user with one calendar and prints the calendar's URL.
set -euo pipefail
PORT="${1:-5232}"
ROOT="${CALDAV_TEST_ROOT:-/tmp/radicale}"
USER="${CALDAV_TEST_USER:-crm@test.local}"
PASS="${CALDAV_TEST_PASS:-calendar-password}"
CAL="${CALDAV_TEST_CALENDAR:-work}"

if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "radicale already running on $PORT" >&2
else
  rm -rf "$ROOT"
  mkdir -p "$ROOT/collections"
  echo "$USER:$PASS" > "$ROOT/users"
  cat > "$ROOT/config" <<CONF
[server]
hosts = 127.0.0.1:$PORT
[auth]
type = htpasswd
htpasswd_filename = $ROOT/users
htpasswd_encryption = plain
[storage]
filesystem_folder = $ROOT/collections
[logging]
level = warning
CONF
  nohup "${RADICALE_PYTHON:-python3}" -m radicale --config "$ROOT/config" > "$ROOT/radicale.log" 2>&1 &
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done
fi

# The calendar itself (Titan comes with one; Radicale starts empty). 201 = created, 405 = exists.
curl -s -o /dev/null -w '' -u "$USER:$PASS" -X MKCALENDAR "http://127.0.0.1:$PORT/$USER/$CAL/" \
  -H 'Content-Type: application/xml' \
  --data '<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Work</D:displayname></D:prop></D:set></C:mkcalendar>' || true
echo "http://127.0.0.1:$PORT/$USER/$CAL/"
