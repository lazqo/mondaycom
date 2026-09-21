// Ingest one or more .eml files into a mailbox as if they had arrived over IMAP, then classify.
// Usage: pnpm ingest:eml --mailbox <email address or id> file1.eml [file2.eml …]
import "dotenv/config";
import { readFileSync } from "node:fs";
import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes } from "@/db/schema";
import { ingestRawMessage } from "@/lib/email/store";
import { processEmail } from "@/lib/email/pipeline";

async function main() {
  const args = process.argv.slice(2);
  const mbIdx = args.indexOf("--mailbox");
  if (mbIdx === -1 || !args[mbIdx + 1]) throw new Error("--mailbox <email or id> is required");
  const mbKey = args[mbIdx + 1];
  const files = args.filter((a, i) => i !== mbIdx && i !== mbIdx + 1 && !a.startsWith("--"));
  if (files.length === 0) throw new Error("No .eml files given");

  const isUuid = /^[0-9a-f-]{36}$/i.test(mbKey);
  const mailbox = await db.query.mailboxes.findFirst({
    where: isUuid ? eq(mailboxes.id, mbKey) : or(eq(mailboxes.emailAddress, mbKey.toLowerCase()), eq(mailboxes.username, mbKey)),
  });
  if (!mailbox) throw new Error(`Mailbox not found: ${mbKey}`);

  for (const f of files) {
    const raw = readFileSync(f);
    const stored = await ingestRawMessage({ mailboxId: mailbox.id, raw, mailboxAddress: mailbox.emailAddress });
    if (!stored.created) {
      console.log(`${f}: duplicate (${stored.parsed.messageId})`);
      continue;
    }
    const out = await processEmail(stored.emailId);
    console.log(`${f}: ${out.classification}${out.leadId ? ` lead=${out.leadId}` : ""} — ${out.detail}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
