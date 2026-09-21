#!/usr/bin/env bash
# Create /opt/getsecure/.env from the template, with strong secrets generated on this machine.
#
#   bash deploy/init-env.sh hermes.aucklandsecuritysystems.co.nz
#
# Safe to read: it never prints the secrets. Refuses to overwrite an existing .env, because
# regenerating AUTH_SECRET signs everyone out and regenerating ENCRYPTION_KEY makes the stored
# Titan mailbox password unreadable.
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: bash deploy/init-env.sh <domain>" >&2
  echo "Example: bash deploy/init-env.sh hermes.aucklandsecuritysystems.co.nz" >&2
  exit 1
fi
case "$DOMAIN" in
  http*|*/*) echo "Give the bare domain, not a URL: hermes.aucklandsecuritysystems.co.nz" >&2; exit 1 ;;
  *.*) : ;;
  *) echo "'$DOMAIN' does not look like a domain name." >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
TEMPLATE="$ROOT/deploy/env.example"

if [ -e "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists. Not touching it." >&2
  echo "To start over, move it aside first: mv .env .env.old" >&2
  exit 1
fi
[ -f "$TEMPLATE" ] || { echo "Missing $TEMPLATE" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is not installed: apt install -y openssl" >&2; exit 1; }

# Create the file with locked-down permissions before anything secret goes in it.
umask 077
cp "$TEMPLATE" "$ENV_FILE"

set_var() {
  # Replace `NAME=` (or NAME=anything) with NAME=<value>. `|` delimits because base64 contains `/`;
  # base64 and hex never contain `|`, `&` or `\`, so the replacement needs no further escaping.
  local name="$1" value="$2"
  sed -i "s|^${name}=.*|${name}=${value}|" "$ENV_FILE"
}

set_var DOMAIN "$DOMAIN"
set_var APP_URL "https://$DOMAIN"
set_var POSTGRES_PASSWORD "$(openssl rand -base64 32)"
set_var AUTH_SECRET "$(openssl rand -base64 32)"
set_var ENCRYPTION_KEY "$(openssl rand -base64 32)"
set_var HEALTH_TOKEN "$(openssl rand -hex 16)"

chmod 600 "$ENV_FILE"

# Verify every required value is now non-empty, without printing any of them.
missing=""
for name in DOMAIN APP_URL POSTGRES_PASSWORD AUTH_SECRET ENCRYPTION_KEY HEALTH_TOKEN; do
  value="$(grep -E "^${name}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
  [ -n "$value" ] || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "Something went wrong; these are still empty:$missing" >&2
  exit 1
fi

cat <<EOF
Wrote $ENV_FILE (permissions 600), for https://$DOMAIN

Secrets generated: POSTGRES_PASSWORD, AUTH_SECRET, ENCRYPTION_KEY, HEALTH_TOKEN.

Before you go further, copy AUTH_SECRET and ENCRYPTION_KEY into your password manager.
A database backup cannot be restored without them.

    grep -E '^(AUTH_SECRET|ENCRYPTION_KEY)=' .env

Then start the stack:

    docker compose -f docker-compose.prod.yml up -d --build
EOF
