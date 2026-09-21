// Starts an SMTP sink so "reply from the CRM" has somewhere to deliver during e2e runs.
import { rmSync } from "node:fs";
import { startSmtpSink } from "../support/smtp-sink";

export const SMTP_SINK_PORT = 2525;
export const SMTP_OUT_DIR = "test-results/smtp-out";

export default async function globalSetup() {
  rmSync(SMTP_OUT_DIR, { recursive: true, force: true });
  const sink = await startSmtpSink(SMTP_SINK_PORT, SMTP_OUT_DIR);
  return async () => {
    await sink.stop();
  };
}
