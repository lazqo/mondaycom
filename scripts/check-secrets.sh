#!/usr/bin/env bash
# Fails if anything that looks like a real secret is tracked by git.
# Run locally with `pnpm secrets:check`; CI runs it on every push.
set -uo pipefail
fail=0

note() { echo "SECRET CHECK FAILED: $*"; fail=1; }

# 1. No .env file may be tracked. .env.example (placeholders only) is the one allowed exception.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ "$f" = ".env.example" ] && continue
  note "$f is tracked by git. Environment files hold real credentials and must stay untracked."
done < <(git ls-files | grep -E '(^|/)\.env' || true)

# 2. No private keys, API keys or mailbox passwords in tracked files.
#    .env.example and the docs are allowed to show the *shape* of a key (sk-ant-..., <token>).
patterns='sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{36}'
if hits=$(git grep -nIE "$patterns" -- . ':(exclude)scripts/check-secrets.sh' 2>/dev/null) && [ -n "$hits" ]; then
  note "a credential-shaped string is committed:"
  echo "$hits"
fi

# 3. Secret-ish values in .env.example must be recognisable placeholders, not real values.
if [ -f .env.example ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    value="${line#*=}"
    [ "${#value}" -lt 16 ] && continue
    if ! printf '%s' "$value" | grep -qiE 'change-me|example|placeholder|your-|sk-ant-\.\.\.|random-string|\.\.\.'; then
      note ".env.example line '${line%%=*}' looks like a real value, not a placeholder."
    fi
  done < <(grep -E '^(ANTHROPIC_API_KEY|AUTH_SECRET|ENCRYPTION_KEY|[A-Z_]*PASSWORD|[A-Z_]*SECRET|[A-Z_]*TOKEN)=' .env.example || true)
fi

if [ "$fail" -eq 0 ]; then echo "Secret check passed: no credentials are tracked by git."; fi
exit "$fail"
