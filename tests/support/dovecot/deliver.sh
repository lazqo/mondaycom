#!/usr/bin/env bash
# Deliver an .eml file into the test user's Maildir INBOX (simulates a new email arriving).
# Usage: tests/support/dovecot/deliver.sh path/to/message.eml
set -euo pipefail
ROOT="${DOVECOT_TEST_ROOT:-/tmp/dv}"
USER="${DOVECOT_TEST_USER:-crm@test.local}"
NEW="$ROOT/mail/$USER/new"
sudo_cmd=""; [ "$(id -u)" -ne 0 ] && sudo_cmd="sudo"
$sudo_cmd mkdir -p "$NEW"
name="$(date +%s.%N).$$.$RANDOM"
$sudo_cmd cp "$1" "$NEW/$name"
$sudo_cmd chown 65534:65534 "$NEW/$name"
echo "$NEW/$name"
