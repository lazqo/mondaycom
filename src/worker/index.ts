// Standalone email ingestion worker: `pnpm worker` (or PROCESS_TYPE=worker in the Docker image).
import "dotenv/config";
import { startIngestionLoop } from "@/lib/email/service";

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const stop = startIngestionLoop(log);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`received ${sig}, stopping`);
    stop();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
