import "server-only";
/**
 * The inbox, triaged: every inbound email with Hermes's category and the state of play
 * (src/lib/inbox/triage.ts), filtered by tab, with the tab counts.
 */
import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { emails, inspections, inspectorActions } from "@/db/schema";
import { INBOX_TABS, inTab, triageEmail, type InboxTab, type Triage, type TriageAction, type TriageInspection } from "@/lib/inbox/triage";

const SCAN = 1500;

async function triageFor(emailIds: string[]): Promise<Map<string, { inspection: TriageInspection; actions: TriageAction[] }>> {
  if (!emailIds.length) return new Map();
  const rows = await db.query.inspections.findMany({
    where: and(eq(inspections.sourceType, "email"), inArray(inspections.sourceId, emailIds)),
    columns: { id: true, sourceId: true, status: true, reviewKind: true, reviewedById: true, summary: true, hermes: true, createdAt: true },
    orderBy: [desc(inspections.createdAt)],
  });
  // The latest reading of each email is the one that stands.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.sourceId)) latest.set(r.sourceId, r);
  const insIds = [...latest.values()].map((r) => r.id);
  const acts = insIds.length ? await db.query.inspectorActions.findMany({ where: inArray(inspectorActions.inspectionId, insIds), columns: { id: true, inspectionId: true, type: true, status: true, reason: true, payload: true, result: true }, orderBy: [inspectorActions.createdAt] }) : [];
  const byIns = new Map<string, TriageAction[]>();
  for (const x of acts) (byIns.get(x.inspectionId) ?? byIns.set(x.inspectionId, []).get(x.inspectionId)!).push({ id: x.id, type: x.type, status: x.status, reason: x.reason, payload: x.payload, result: x.result });
  const out = new Map<string, { inspection: TriageInspection; actions: TriageAction[] }>();
  for (const [emailId, r] of latest) out.set(emailId, { inspection: { status: r.status, reviewKind: r.reviewKind, reviewedById: r.reviewedById, summary: r.summary, hermes: (r.hermes as TriageInspection["hermes"]) ?? null }, actions: byIns.get(r.id) ?? [] });
  return out;
}

export async function listTriagedInbox(opts: { tab: InboxTab; q?: string; limit?: number }) {
  const conds: SQL[] = [eq(emails.direction, "inbound")];
  if (opts.q?.trim()) {
    const term = `%${opts.q.trim()}%`;
    conds.push(or(ilike(emails.subject, term), ilike(emails.fromAddress, term), ilike(emails.fromName, term), ilike(emails.textBody, term))!);
  }
  const rows = await db.query.emails.findMany({
    where: and(...conds),
    columns: { id: true, threadId: true, fromName: true, fromAddress: true, subject: true, snippet: true, receivedAt: true, classification: true, classificationError: true, hasAttachments: true, headers: true, leadId: true, contactId: true },
    with: {
      lead: { columns: { id: true, name: true, status: true } },
      contact: { columns: { id: true, name: true } },
      thread: { columns: { id: true, messageCount: true, leadId: true, contactId: true, jobId: true }, with: { job: { columns: { id: true, number: true } } } },
    },
    orderBy: [desc(emails.receivedAt)],
    limit: SCAN,
  });
  const t = await triageFor(rows.map((r) => r.id));
  const triaged = rows.map((e) => {
    const x = t.get(e.id);
    const triage = triageEmail({ ...e, headers: e.headers ?? {}, job: e.thread.job }, x?.inspection ?? null, x?.actions ?? []);
    return { ...e, triage };
  });
  const counts: Record<string, number> = {};
  for (const tab of INBOX_TABS) counts[tab.key] = 0;
  for (const r of triaged) for (const tab of INBOX_TABS) if (inTab(r.triage, tab.key)) counts[tab.key]++;
  return { rows: triaged.filter((r) => inTab(r.triage, opts.tab)).slice(0, opts.limit ?? 200), counts, scanned: rows.length, capped: rows.length === SCAN };
}
export type TriagedRow = Awaited<ReturnType<typeof listTriagedInbox>>["rows"][number];

/** One email's triage, for the thread page. */
export async function triageForEmail(emailId: string): Promise<Triage | null> {
  const e = await db.query.emails.findFirst({ where: eq(emails.id, emailId), columns: { id: true, fromName: true, fromAddress: true, subject: true, classification: true, classificationError: true, headers: true }, with: { lead: { columns: { name: true } }, contact: { columns: { name: true } }, thread: { columns: { id: true }, with: { job: { columns: { number: true } } } } } });
  if (!e) return null;
  const t = (await triageFor([e.id])).get(e.id);
  return triageEmail({ ...e, headers: e.headers ?? {}, job: e.thread.job }, t?.inspection ?? null, t?.actions ?? []);
}
