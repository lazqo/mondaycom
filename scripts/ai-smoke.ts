// Classify the bundled realistic enquiries (or the latest N real inbound emails with --recent N) with
// the configured AI provider and print the extracted fields. Writes nothing to the database.
// Usage: pnpm ai:smoke            (fixtures)
//        pnpm ai:smoke -- --recent 10
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { parseRawEmail, stripQuotedReply } from "@/lib/email/parse";
import { getClassifier, type ClassificationInput } from "@/lib/ai";

async function inputsFromFixtures(): Promise<{ label: string; input: ClassificationInput }[]> {
  const dir = "tests/fixtures/emails";
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    const p = await parseRawEmail(readFileSync(`${dir}/${f}`));
    out.push({
      label: f,
      input: { from: p.from, to: p.to.map((t) => t.address), subject: p.subject, receivedAt: p.date.toISOString(), text: stripQuotedReply(p.text), attachments: p.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })) },
    });
  }
  return out;
}

async function inputsFromRecent(n: number): Promise<{ label: string; input: ClassificationInput }[]> {
  const { db } = await import("@/db");
  const rows = await db.query.emails.findMany({
    where: (e, { eq }) => eq(e.direction, "inbound"),
    orderBy: (e, { desc }) => [desc(e.receivedAt)],
    limit: n,
    with: { attachments: { columns: { filename: true, contentType: true, size: true } } },
  });
  return rows.map((e) => ({
    label: `${e.receivedAt.toISOString().slice(0, 10)} ${e.fromAddress} — ${e.subject}`,
    input: { from: { name: e.fromName, address: e.fromAddress }, to: e.to.map((t) => t.address), subject: e.subject, receivedAt: e.receivedAt.toISOString(), text: stripQuotedReply(e.textBody ?? ""), attachments: e.attachments },
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--recent");
  const items = i >= 0 ? await inputsFromRecent(Number(args[i + 1] ?? 10)) : await inputsFromFixtures();
  const classifier = getClassifier();
  console.log(`Provider: ${classifier.name}\n`);
  let totalIn = 0;
  let totalOut = 0;
  for (const { label, input } of items) {
    const started = Date.now();
    try {
      const r = await classifier.classify(input);
      const x = r.result;
      totalIn += r.usage?.inputTokens ?? 0;
      totalOut += r.usage?.outputTokens ?? 0;
      console.log(`${x.is_lead ? "LEAD    " : "NOT LEAD"} ${(x.confidence * 100).toFixed(0).padStart(3)}%  ${label}`);
      console.log(`         name=${x.contact_name ?? "—"} | company=${x.company ?? "—"} | phone=${x.phone ?? "—"} | service=${x.service ?? "—"} | site=${x.site_address ?? "—"} | urgency=${x.urgency}`);
      console.log(`         ${x.summary}`);
      console.log(`         next: ${x.next_action}  (${r.model ?? r.provider}, ${Date.now() - started} ms)\n`);
    } catch (err) {
      console.log(`ERROR    ${label}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (totalIn || totalOut) console.log(`Tokens: ${totalIn} in / ${totalOut} out`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
