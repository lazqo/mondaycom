#!/usr/bin/env bash
# Log the Plaud CLI in from a server with no browser.
#
#   bash scripts/plaud-login.sh
#
# Why this is needed: `plaud login` starts a listener on localhost:8199, then asks the operating
# system to open a browser. On a headless server that launch is fire-and-forget, so the CLI never
# learns it failed and never prints the sign-in URL — it just waits two minutes and gives up.
#
# This script captures the URL, shows it to you, and then delivers the browser's callback to the
# waiting listener on this machine, so no SSH tunnel or second terminal is needed.
set -uo pipefail

DIR="${PLAUD_CLI_DIR:-/opt/plaud-cli}"
PORT=8199
TIMEOUT_HINT="2 minutes"

command -v node >/dev/null || { echo "node is not installed. apt install -y nodejs" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is not installed. apt install -y curl" >&2; exit 1; }

if command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "Port ${PORT} is already in use. Another plaud login may still be running." >&2
  echo "Find it with:  ss -ltnp | grep ${PORT}" >&2
  exit 1
fi

echo "Installing the Plaud CLI into ${DIR} ..."
mkdir -p "$DIR" && cd "$DIR" || exit 1
npm install @plaud-ai/cli --silent --no-fund --no-audit >/dev/null 2>&1 || {
  echo "npm install failed. Run it by hand to see why:  cd $DIR && npm install @plaud-ai/cli" >&2
  exit 1
}

LAUNCHER="$DIR/node_modules/open/xdg-open"
[ -f "$LAUNCHER" ] || { echo "Unexpected CLI layout: $LAUNCHER is missing." >&2; exit 1; }

URLFILE="$DIR/.auth-url"
rm -f "$URLFILE"
# Replace the bundled browser launcher with one that records the URL instead. The CLI spawns it
# with stdio ignored, so it must write to a file rather than print.
[ -f "$LAUNCHER.orig" ] || cp "$LAUNCHER" "$LAUNCHER.orig"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
printf '%s\n' "\$1" > "$URLFILE"
EOF
chmod +x "$LAUNCHER"

echo "Starting sign-in ..."
"$DIR/node_modules/.bin/plaud" login > "$DIR/login.log" 2>&1 &
LOGIN_PID=$!

for _ in $(seq 1 40); do
  [ -s "$URLFILE" ] && break
  kill -0 "$LOGIN_PID" 2>/dev/null || break
  sleep 0.5
done

if [ ! -s "$URLFILE" ]; then
  echo "Could not capture the sign-in URL. The CLI said:" >&2
  cat "$DIR/login.log" >&2
  kill "$LOGIN_PID" 2>/dev/null
  exit 1
fi

cat <<BANNER

──────────────────────────────────────────────────────────────────────────────
 1. Open this URL in the browser on your own computer:

$(cat "$URLFILE")

 2. Sign in to Plaud and approve.

 3. Your browser will then fail to load a "localhost:${PORT}" page. That is
    expected — that address is this server, not your laptop. Copy the whole
    URL out of the browser's address bar.

 4. Paste it below and press Enter. You have about ${TIMEOUT_HINT}.
──────────────────────────────────────────────────────────────────────────────

BANNER

printf 'Paste the localhost:%s URL here: ' "$PORT"
read -r CALLBACK_URL

case "$CALLBACK_URL" in
  http://localhost:${PORT}/*|http://127.0.0.1:${PORT}/*) : ;;
  *)
    echo "That does not look like the callback URL. It should start with http://localhost:${PORT}/" >&2
    kill "$LOGIN_PID" 2>/dev/null
    exit 1
    ;;
esac

# Hand the callback to the listener running on this machine.
curl -s -o /dev/null "$CALLBACK_URL" || true

# Give the CLI a moment to finish the exchange, rather than blocking on its full timeout.
STATUS=1
for _ in $(seq 1 40); do
  if ! kill -0 "$LOGIN_PID" 2>/dev/null; then
    wait "$LOGIN_PID"
    STATUS=$?
    break
  fi
  sleep 0.5
done
if kill -0 "$LOGIN_PID" 2>/dev/null; then
  echo
  echo "The sign-in did not complete. The callback was probably expired or already used." >&2
  echo "Run this script again and paste the URL more quickly." >&2
  kill "$LOGIN_PID" 2>/dev/null
  mv -f "$LAUNCHER.orig" "$LAUNCHER" 2>/dev/null
  exit 1
fi

# Put the real launcher back so nothing else is affected.
mv -f "$LAUNCHER.orig" "$LAUNCHER" 2>/dev/null
rm -f "$URLFILE"

echo
if [ "$STATUS" -eq 0 ] && [ -f "$HOME/.plaud/tokens.json" ]; then
  echo "Signed in. Token saved to $HOME/.plaud/tokens.json"
  echo
  echo "Try it:"
  echo "  $DIR/node_modules/.bin/plaud recent"
else
  echo "Sign-in did not complete. The CLI said:" >&2
  cat "$DIR/login.log" >&2
  exit 1
fi
