/**
 * Facts with provenance. A fact read from a source is compared with what the CRM already holds:
 * - nothing there yet → applied (filled in), recorded with its source;
 * - the same value → nothing new;
 * - a different value → a conflict for Chris; the CRM value is never silently overwritten.
 * Low-confidence facts are proposed, not applied.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, facts, leads } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { CONTACT_COLUMNS, LEAD_COLUMNS, serviceKey } from "./sources";
import type { ExtractedFact, FactKey, InspectorInput } from "./types";

export const APPLY_CONFIDENCE = 0.7;

const norm = (k: string, v: unknown) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (k === "phone") return s.replace(/\D/g, "").replace(/^64/, "0");
  if (k === "service") return serviceKey(s);
  if (k === "site_address") return s.split(",")[0].replace(/\s+/g, " ");
  return s.replace(/\s+/g, " ");
};

export type FactDiff = { fact: ExtractedFact; outcome: "new" | "same" | "conflict" | "low_confidence"; current: string | number | boolean | null };

/** The CRM's current value for a fact key on this lead/customer. */
async function currentValue(key: FactKey, leadId: string | null, contactId: string | null): Promise<string | number | boolean | null> {
  if (leadId && LEAD_COLUMNS[key]) {
    const l = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    const v = l?.[LEAD_COLUMNS[key]!];
    if (v) return v as string;
  } else if (!leadId && contactId && CONTACT_COLUMNS[key]) {
    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
    const v = c?.[CONTACT_COLUMNS[key]!];
    if (v) return v as string;
  }
  const applied = await db.query.facts.findFirst({
    where: and(leadId ? eq(facts.leadId, leadId) : eq(facts.contactId, contactId!), eq(facts.key, key), eq(facts.state, "applied")),
    orderBy: [desc(facts.createdAt)],
  });
  return applied ? applied.value : null;
}

export async function diffFacts(list: ExtractedFact[], leadId: string | null, contactId: string | null): Promise<FactDiff[]> {
  if (!leadId && !contactId) return list.map((fact) => ({ fact, outcome: "new", current: null }));
  const out: FactDiff[] = [];
  for (const fact of list) {
    const current = await currentValue(fact.key, leadId, contactId);
    if (current === null || current === "") out.push({ fact, outcome: fact.confidence < APPLY_CONFIDENCE ? "low_confidence" : "new", current });
    else if (fact.key === "contact_name" && norm(fact.key, current).startsWith(norm(fact.key, fact.value).split(" ")[0])) out.push({ fact, outcome: "same", current });
    else if (fact.key === "service" ? norm("service", current).includes(norm("service", fact.value)) || norm("service", fact.value) === norm("service", current) : norm(fact.key, current) === norm(fact.key, fact.value)) out.push({ fact, outcome: "same", current });
    else out.push({ fact, outcome: "conflict", current });
  }
  return out;
}

/** Store the facts with provenance; fill blank CRM fields; flag conflicts. */
export async function storeFacts(diffs: FactDiff[], subject: { leadId: string | null; contactId: string | null; jobId: string | null }, input: InspectorInput, inspectionId: string): Promise<{ applied: number; conflicts: number; proposed: number }> {
  let applied = 0;
  let conflicts = 0;
  let proposed = 0;
  const leadPatch: Record<string, string> = {};
  const contactPatch: Record<string, string> = {};
  for (const d of diffs) {
    if (d.outcome === "same") continue;
    const state = d.outcome === "new" ? "applied" : d.outcome === "conflict" ? "conflict" : "proposed";
    await db.insert(facts).values({
      key: d.fact.key,
      value: d.fact.value,
      display: d.fact.display,
      evidence: d.fact.evidence,
      leadId: subject.leadId,
      contactId: subject.contactId,
      jobId: subject.jobId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceAt: input.at,
      inspectionId,
      confidence: d.fact.confidence.toFixed(3),
      state,
      currentValue: d.outcome === "conflict" ? d.current : null,
      appliedAt: state === "applied" ? new Date() : null,
    });
    if (state === "applied") {
      applied++;
      if (subject.leadId && LEAD_COLUMNS[d.fact.key]) leadPatch[LEAD_COLUMNS[d.fact.key]!] = d.fact.key === "service" ? String(d.fact.display) : String(d.fact.value);
      else if (!subject.leadId && subject.contactId && CONTACT_COLUMNS[d.fact.key]) contactPatch[CONTACT_COLUMNS[d.fact.key]!] = String(d.fact.value);
    } else if (state === "conflict") conflicts++;
    else proposed++;
  }
  if (subject.leadId && Object.keys(leadPatch).length) {
    await db.update(leads).set({ ...leadPatch, updatedAt: new Date() }).where(eq(leads.id, subject.leadId));
    await logActivity({ entity: "lead", entityId: subject.leadId, actorId: null, action: "facts_applied", detail: { fields: Object.keys(leadPatch), source: input.sourceType, sourceId: input.sourceId, inspectionId } });
  }
  if (!subject.leadId && subject.contactId && Object.keys(contactPatch).length) {
    await db.update(contacts).set({ ...contactPatch, updatedAt: new Date() }).where(eq(contacts.id, subject.contactId));
  }
  return { applied, conflicts, proposed };
}

/** Chris resolves a conflicting or proposed fact. */
export async function decideFact(factId: string, decision: "apply" | "reject", actorId: string): Promise<void> {
  const f = await db.query.facts.findFirst({ where: eq(facts.id, factId) });
  if (!f) throw new Error("Fact not found");
  if (decision === "reject") {
    await db.update(facts).set({ state: "rejected", decidedById: actorId }).where(eq(facts.id, factId));
    return;
  }
  const key = f.key as FactKey;
  if (f.leadId && LEAD_COLUMNS[key]) {
    await db.update(leads).set({ [LEAD_COLUMNS[key]!]: key === "service" ? f.display : String(f.value), updatedAt: new Date() }).where(eq(leads.id, f.leadId));
    await logActivity({ entity: "lead", entityId: f.leadId, actorId, action: "fact_applied", detail: { key, value: f.value, previous: f.currentValue, factId } });
  } else if (!f.leadId && f.contactId && CONTACT_COLUMNS[key]) {
    await db.update(contacts).set({ [CONTACT_COLUMNS[key]!]: String(f.value), updatedAt: new Date() }).where(eq(contacts.id, f.contactId));
  }
  // The newly applied value supersedes earlier applied values for the same key.
  await db
    .update(facts)
    .set({ state: "superseded" })
    .where(and(f.leadId ? eq(facts.leadId, f.leadId) : eq(facts.contactId, f.contactId!), eq(facts.key, key), eq(facts.state, "applied")));
  await db.update(facts).set({ state: "applied", appliedAt: new Date(), decidedById: actorId }).where(eq(facts.id, factId));
}
