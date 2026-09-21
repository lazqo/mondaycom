// Prints which production variables are set, missing, or still hold example values.
// Usage: pnpm env:check   (reads .env if present, plus the real environment)
import { existsSync } from "node:fs";
if (existsSync(".env")) (await import("dotenv")).config();

const rows = [
  ["DATABASE_URL", true, (v) => (/^postgres(ql)?:\/\//.test(v) ? null : "must start with postgres://")],
  ["AUTH_SECRET", true, (v) => (v.length < 32 ? "use at least 32 random characters" : /change-me|dev-secret|example/i.test(v) ? "still the example value" : null)],
  ["APP_URL", true, (v) => (v.startsWith("https://") ? null : "should be https:// in production")],
  ["APP_TIMEZONE", true, (v) => (v === "Pacific/Auckland" ? null : `set to ${v}; expected Pacific/Auckland`)],
  ["ENCRYPTION_KEY", false, (v) => (v.length < 32 ? "use at least 32 random characters" : null)],
  ["INGEST_IN_PROCESS", false, (v) => (["true", "false", "1", "0"].includes(v) ? null : "true or false")],
  ["INGEST_POLL_SECONDS", false, null],
  ["AI_PROVIDER", false, (v) => (["auto", "anthropic", "rules"].includes(v) ? null : "auto | anthropic | rules")],
  ["ANTHROPIC_API_KEY", false, (v) => (v.startsWith("sk-ant-") ? null : "does not look like an Anthropic key")],
  ["AI_MODEL", false, null],
  ["AI_LEAD_CONFIDENCE_THRESHOLD", false, (v) => (Number(v) >= 0 && Number(v) <= 1 ? null : "0–1")],
  ["HEALTH_TOKEN", false, null],
];
let problems = 0;
for (const [name, required, check] of rows) {
  const v = process.env[name];
  let status;
  if (!v) status = required ? "MISSING" : "not set (optional)";
  else {
    const issue = check ? check(v) : null;
    status = issue ? `WARN: ${issue}` : "ok";
  }
  if (status === "MISSING" || status.startsWith("WARN")) problems++;
  console.log(`${name.padEnd(30)} ${status}`);
}
if ((process.env.AI_PROVIDER ?? "auto") === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY".padEnd(30) + "MISSING (AI_PROVIDER=anthropic requires it)");
  problems++;
}
console.log(problems ? `\n${problems} item(s) need attention. See docs/PRODUCTION_ENV.md` : "\nAll good.");
process.exit(problems ? 1 : 0);
