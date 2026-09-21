// One sync pass over every active mailbox (useful for cron-style hosting or debugging).
import "dotenv/config";
import { runIngestionOnce } from "@/lib/email/service";

runIngestionOnce(console.log)
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
