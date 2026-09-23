// Put every website enquiry on its own lead and take the website's sending address off customers.
// Run once after updating. It shows what it would do first; nothing changes without --apply:
//
//   cd /opt/getsecure
//   docker compose -f docker-compose.prod.yml exec -T web node_modules/.bin/tsx scripts/repair-website-leads.ts
//   docker compose -f docker-compose.prod.yml exec -T web node_modules/.bin/tsx scripts/repair-website-leads.ts --apply
//
// Safe to run again: anything already correct is left alone, and nothing is deleted.
import "dotenv/config";
import { repairWebsiteEnquiries } from "@/lib/email/website-repair";

async function main() {
  const apply = process.argv.includes("--apply");
  const { lines, changes } = await repairWebsiteEnquiries({ apply });
  for (const line of lines) console.log(line);
  if (!apply && changes) console.log(`\n${changes} change(s) above. Nothing has been changed yet. Run again with --apply to make them.`);
  if (apply && changes) console.log(`\nDone: ${changes} change(s) made.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
