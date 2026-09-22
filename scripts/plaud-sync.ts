// Pull new Plaud recordings into the CRM. Safe to run repeatedly: already-imported recordings are
// skipped. Intended for cron, for example every 15 minutes:
//
//   cd /opt/getsecure && docker compose -f docker-compose.prod.yml exec -T web \
//     node_modules/.bin/tsx scripts/plaud-sync.ts
//
// (A block comment cannot hold a cron expression: the "*/" in it would end the comment.)
import "dotenv/config";
import { importRecentRecordings } from "@/lib/recordings/import";
import { plaudConfigured } from "@/lib/recordings/plaud";

async function main() {
  if (!plaudConfigured()) {
    console.log("PLAUD_ENABLED is not true; nothing to do.");
    return;
  }
  const days = Number(process.argv[2] ?? 7);
  const s = await importRecentRecordings({ days, log: (m) => console.log(m) });
  console.log(`checked ${s.checked} · imported ${s.imported} · filed automatically ${s.attached} · waiting for you ${s.review}`);
  for (const e of s.errors) console.error(`error: ${e}`);
  if (s.errors.length && s.imported === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
