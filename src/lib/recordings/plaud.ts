/**
 * Reads voice recordings from Plaud through its official CLI.
 *
 * The CLI is used rather than the HTTP API because its OAuth token is already on the server (see
 * scripts/plaud-login.sh) and Plaud's developer API is a different product aimed at partners
 * uploading their own audio, not at reading your own account's recordings.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type PlaudRecording = {
  externalId: string;
  title: string;
  /** YYYY-MM-DD as the CLI prints it; the recording's own date, not when we imported it. */
  date: string | null;
  durationSeconds: number | null;
};

function cliPath(): string {
  return process.env.PLAUD_CLI ?? "/opt/plaud-cli/node_modules/.bin/plaud";
}

export function plaudConfigured(): boolean {
  return (process.env.PLAUD_ENABLED ?? "").toLowerCase() === "true";
}

/** "5m37s" / "45s" / "1h02m" -> seconds. */
export function parseDuration(text: string): number | null {
  const m = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Parse the table `plaud recent` prints:
 *
 *   of_71fa29bc…  Consultation: Greyland Firehouse CCTV System Assessment  2026-09-21  5m37s
 *
 * Columns are separated by two or more spaces, and the title itself may contain single spaces,
 * colons and hyphens.
 */
export function parseRecentOutput(stdout: string): PlaudRecording[] {
  const out: PlaudRecording[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("of_")) continue;
    const parts = trimmed.split(/\s{2,}/).filter(Boolean);
    if (parts.length < 2) continue;
    const [externalId, title, ...rest] = parts;
    const date = rest.find((p) => /^\d{4}-\d{2}-\d{2}$/.test(p)) ?? null;
    const duration = rest.map((p) => parseDuration(p)).find((d) => d !== null) ?? null;
    out.push({ externalId, title: title.trim(), date, durationSeconds: duration });
  }
  return out;
}

/** Strip the CLI's header so only the spoken lines are stored. */
export function cleanTranscript(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => !/^Transcript:/i.test(l.trim()))
    .join("\n")
    .trim();
}

async function plaud(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await run(cliPath(), args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

export async function listRecent(days = 7): Promise<PlaudRecording[]> {
  return parseRecentOutput(await plaud(["recent", "-d", String(days)]));
}

export async function fetchTranscript(externalId: string): Promise<string> {
  return cleanTranscript(await plaud(["transcript", externalId], 120_000));
}
