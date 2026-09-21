#!/usr/bin/env bash
# Start a throwaway Dovecot IMAP server for tests. Requires dovecot-imapd (apt-get install dovecot-imapd).
# Usage: tests/support/dovecot/start.sh [port]   (default 1143). Prints the mail dir for the test user.
set -euo pipefail
PORT="${1:-1143}"
ROOT="${DOVECOT_TEST_ROOT:-/tmp/dv}"
RUN="${DOVECOT_TEST_RUN:-/tmp/dv-run}"   # unix socket paths must stay short
USER="${DOVECOT_TEST_USER:-crm@test.local}"
PASS="${DOVECOT_TEST_PASS:-crm-password}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$RUN/master.pid" ] && kill -0 "$(cat "$RUN/master.pid")" 2>/dev/null; then
  echo "dovecot already running (pid $(cat "$RUN/master.pid"))" >&2
else
  sudo_cmd=""; [ "$(id -u)" -ne 0 ] && sudo_cmd="sudo"
  $sudo_cmd rm -rf "$ROOT" "$RUN"
  $sudo_cmd mkdir -p "$ROOT/mail/$USER" "$RUN"
  sed -e "s|__ROOT__|$ROOT|g" -e "s|__RUN__|$RUN|g" -e "s|__PORT__|$PORT|g" "$HERE/dovecot.conf.template" | $sudo_cmd tee "$ROOT/dovecot.conf" >/dev/null
  echo "$USER:{PLAIN}$PASS:65534:65534::$ROOT/mail/$USER" | $sudo_cmd tee "$ROOT/users" >/dev/null
  $sudo_cmd chown -R 65534:65534 "$ROOT/mail"
  $sudo_cmd chmod 755 "$ROOT" "$ROOT/mail"
  $sudo_cmd chmod 644 "$ROOT/users" "$ROOT/dovecot.conf"
  $sudo_cmd dovecot -c "$ROOT/dovecot.conf"
  sleep 1
fi
echo "$ROOT/mail/$USER"
