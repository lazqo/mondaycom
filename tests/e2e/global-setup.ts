// Starts an SMTP sink so "reply from the CRM" has somewhere to deliver during e2e runs, and a
// stand-in for the IT Plus website so the supplier pricing connector has something to log in to.
import { rmSync } from "node:fs";
import { startSmtpSink } from "../support/smtp-sink";
import { startItPlusMock } from "../support/itplus-mock";

export const ITPLUS_MOCK_PORT = 3199;
/** TEST login for the IT Plus stand-in (never a real account). */
export const ITPLUS_MOCK_LOGIN = { username: "e2e-trade@getsecure.test", password: "e2e-Only-Password-1" };

export const SMTP_SINK_PORT = 2525;
export const SMTP_OUT_DIR = "test-results/smtp-out";

export default async function globalSetup() {
  rmSync(SMTP_OUT_DIR, { recursive: true, force: true });
  const sink = await startSmtpSink(SMTP_SINK_PORT, SMTP_OUT_DIR);
  const itplus = await startItPlusMock(
    {
      ...ITPLUS_MOCK_LOGIN,
      mode: "normal",
      log: [],
      // TEST VALUES, not IT Plus prices.
      products: [{ sku: "S455-2.8", slug: "tp-link-vigi-insight-s455-2-8mm", name: "TP-Link VIGI InSight S455 2.8MM", type: "bundle", trade: 151.3, publicPrice: 157.7, stock: "In stock" }],
    },
    ITPLUS_MOCK_PORT,
  );
  return async () => {
    await sink.stop();
    await itplus.close();
  };
}
