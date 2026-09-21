#!/bin/sh
# Container entrypoint. PROCESS_TYPE=web (default) runs migrations then the Next.js server;
# PROCESS_TYPE=worker runs the email ingestion worker (no migrations, no HTTP).
set -e
case "${PROCESS_TYPE:-web}" in
  worker)
    exec node_modules/.bin/tsx src/worker/index.ts
    ;;
  *)
    node scripts/migrate.mjs
    exec node_modules/.bin/next start -p "${PORT:-3000}"
    ;;
esac
