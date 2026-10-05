import { defineConfig, devices } from "@playwright/test";

// The app renders "today" in APP_TIMEZONE; run the test process and the browser in the same zone.
const TZ = process.env.APP_TIMEZONE ?? "Pacific/Auckland";
process.env.TZ = TZ;

const PORT = process.env.E2E_PORT ?? "3100";
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL,
    timezoneId: TZ,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Allow pointing at a pre-installed browser (e.g. PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium).
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
      },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm next start -p ${PORT}`,
        // The supplier pricing connector logs in to the IT Plus stand-in from global-setup, never the real site.
        // Plaud is read through a stand-in CLI whose recordings the Inspector e2e test writes.
        env: {
          ITPLUS_BASE_URL: "http://127.0.0.1:3199",
          SUPPLIER_SYNC_DELAY_MS: "0",
          PLAUD_ENABLED: "true",
          PLAUD_CLI: `${process.cwd()}/tests/support/fake-plaud.mjs`,
          FAKE_PLAUD_STATE: `${process.cwd()}/test-results/e2e-plaud.json`,
          // Hermes is the stand-in API server from tests/support/hermes-mock.ts (TEST key).
          HERMES_API_URL: "http://127.0.0.1:3198",
          HERMES_API_KEY: "e2e-hermes-key-not-a-secret",
          HERMES_TIMEOUT_MS: "10000",
        },
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
