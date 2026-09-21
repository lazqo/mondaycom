"use server";

import { readdirSync, readFileSync } from "node:fs";
import { requireAdmin } from "@/lib/auth";
import { parseRawEmail, stripQuotedReply } from "@/lib/email/parse";
import { getClassifier } from "@/lib/ai";
import { ok, fail, type ActionResult } from "@/lib/action-result";

type SmokeRow = { label: string; isLead: boolean | null; confidence: number | null; fields: string; error?: string };

/** Classify the bundled sample enquiries with the active provider. Never touches the database. */
export async function runAiSmokeTest(): Promise<ActionResult<SmokeRow[]>> {
  await requireAdmin();
  const dir = "tests/fixtures/emails";
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".eml")).sort();
  } catch {
    return fail("Sample enquiries are not available in this deployment");
  }
  const classifier = getClassifier();
  const rows: SmokeRow[] = [];
  for (const f of files) {
    const p = await parseRawEmail(readFileSync(`${dir}/${f}`));
    try {
      const r = await classifier.classify({
        from: p.from,
        to: p.to.map((t) => t.address),
        subject: p.subject,
        receivedAt: p.date.toISOString(),
        text: stripQuotedReply(p.text),
        attachments: p.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
      });
      const x = r.result;
      rows.push({ label: p.subject, isLead: x.is_lead, confidence: x.confidence, fields: [x.contact_name, x.phone, x.service, x.site_address, x.urgency].filter(Boolean).join(" · ") });
    } catch (err) {
      rows.push({ label: p.subject, isLead: null, confidence: null, fields: "", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return ok(rows);
}
