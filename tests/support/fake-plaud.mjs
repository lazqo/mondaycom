#!/usr/bin/env node
// Stands in for the Plaud CLI in tests. Prints what the real CLI prints for `recent` and
// `transcript [--polished]`, from a JSON file named by FAKE_PLAUD_STATE:
//   { "recordings": [{ "id": "of_…", "title": "…", "date": "2026-09-21", "duration": "5m37s",
//                      "original": "[00:00 - 00:05] Speaker 1: …", "polished": "…" | null }] }
import { readFileSync } from "node:fs";

const state = JSON.parse(readFileSync(process.env.FAKE_PLAUD_STATE, "utf8"));
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "recent") {
  console.log(`\nRecordings in the last 7 days: ${state.recordings.length}\n`);
  for (const r of state.recordings) console.log(`  ${r.id}  ${r.title}  ${r.date}  ${r.duration}`);
} else if (cmd === "transcript") {
  const id = args.find((a) => !a.startsWith("-"));
  const polished = args.includes("--polished");
  const r = state.recordings.find((x) => x.id === id);
  const text = r ? (polished ? r.polished : r.original) : null;
  if (!text) {
    // The real CLI prints a notice and exits normally when a block does not exist yet.
    console.log(polished ? `No "transaction_polish" transcript for this recording. Available: transaction.` : `The "transaction" transcript is not available for this recording.`);
  } else {
    console.log(`\nTranscript: ${r.title}\n`);
    console.log(text);
    console.log();
  }
} else {
  console.error(`fake plaud: unsupported command ${cmd}`);
  process.exit(1);
}
