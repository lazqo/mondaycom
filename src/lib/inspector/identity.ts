/**
 * Who an email or conversation is about, from several independent signals. A name on its own is
 * never enough: it can raise a candidate, but a match needs a strong signal (the thread, a phone
 * number, an email address, a calendar appointment, a quote number, or Chris filing it). When the
 * evidence is weak or two candidates are close, the answer is NEEDS_REVIEW. Pure.
 */
import type { IdentityCandidate, IdentityResult, IdentitySignal } from "./types";

export const SIGNAL_WEIGHTS: Record<IdentitySignal["kind"], number> = {
  linked: 1,
  thread: 0.95,
  email: 0.9,
  phone: 0.9,
  quote_ref: 0.85,
  job_ref: 0.5,
  calendar: 0.7,
  address: 0.5,
  company: 0.35,
  name: 0.2,
};
// A job number names the work, not the person writing about it (a supplier, a property manager, the
// customer's accounts team): it places the message in that work, never files the sender as the customer.
const STRONG: IdentitySignal["kind"][] = ["linked", "thread", "email", "phone", "quote_ref", "calendar"];
export const MATCH_THRESHOLD = 0.75;
export const MATCH_MARGIN = 0.25;

/** Independent evidence combines: 1 − Π(1 − w), using the strongest signal of each kind once. */
export function scoreSignals(signals: IdentitySignal[]): number {
  const best = new Map<string, number>();
  for (const s of signals) best.set(s.kind, Math.max(best.get(s.kind) ?? 0, s.weight));
  let miss = 1;
  for (const w of best.values()) miss *= 1 - w;
  return Math.round((1 - miss) * 1000) / 1000;
}

/** Merge raw signals per candidate (same lead or same customer) and score them. */
export function mergeCandidates(raw: { leadId: string | null; contactId: string | null; jobId: string | null; label: string; signal: IdentitySignal }[]): IdentityCandidate[] {
  const map = new Map<string, IdentityCandidate>();
  for (const r of raw) {
    const key = r.leadId ? `lead:${r.leadId}` : `contact:${r.contactId}`;
    const c = map.get(key) ?? { leadId: r.leadId, contactId: r.contactId, jobId: r.jobId, label: r.label, score: 0, signals: [] };
    c.contactId ??= r.contactId;
    c.jobId ??= r.jobId;
    if (!c.signals.some((s) => s.kind === r.signal.kind && s.detail === r.signal.detail)) c.signals.push(r.signal);
    map.set(key, c);
  }
  // A customer candidate and a lead of the same customer are the same person: fold the customer's
  // signals into the lead.
  for (const c of [...map.values()]) {
    if (c.leadId || !c.contactId) continue;
    const lead = [...map.values()].find((x) => x.leadId && x.contactId === c.contactId);
    if (lead) {
      for (const s of c.signals) if (!lead.signals.some((x) => x.kind === s.kind && x.detail === s.detail)) lead.signals.push(s);
      map.delete(`contact:${c.contactId}`);
    }
  }
  const out = [...map.values()];
  for (const c of out) c.score = scoreSignals(c.signals);
  return out.sort((a, b) => b.score - a.score);
}

export function decideIdentity(candidates: IdentityCandidate[], opts: { allowNew: boolean }): IdentityResult {
  const [top, second] = candidates;
  if (!top) {
    return opts.allowNew
      ? { status: "new", chosen: null, candidates: [], confidence: 0, reason: "No existing lead or customer matches; a new enquiry." }
      : { status: "needs_review", chosen: null, candidates: [], confidence: 0, reason: "Nothing identifies who this is: no phone, email, appointment or thread link matched." };
  }
  // Already filed by the CRM (the email thread) or by Chris: that link stands. Other candidates
  // are listed so a shared phone number or similar can be noticed, but they do not override it.
  if (top.signals.some((s) => s.kind === "thread" || s.kind === "linked")) {
    const others = candidates.slice(1).filter((c) => c.score >= MATCH_THRESHOLD);
    return { status: "matched", chosen: top, candidates, confidence: top.score, reason: `Matched on ${top.signals.map((s) => s.detail).join(", ")}.${others.length ? ` Note: ${others.map((c) => `${c.label} (${c.signals.map((s) => s.detail).join(", ")})`).join("; ")} also matched.` : ""}` };
  }
  const strong = top.signals.some((s) => STRONG.includes(s.kind));
  // A phone number or email address said or written outranks a runner-up that is only "during an
  // appointment" or a name: the words name the person; the calendar only suggests them.
  const DIRECT: IdentitySignal["kind"][] = ["phone", "email", "thread", "linked"];
  const outranks = top.signals.some((s) => DIRECT.includes(s.kind)) && !!second && !second.signals.some((s) => DIRECT.includes(s.kind) || s.kind === "quote_ref");
  const clear = !second || top.score - second.score >= MATCH_MARGIN || outranks;
  if (top.score >= MATCH_THRESHOLD && strong && clear) {
    return { status: "matched", chosen: top, candidates, confidence: top.score, reason: `Matched on ${top.signals.map((s) => s.detail).join(", ")}.` };
  }
  const why = !strong
    ? `Only ${top.signals.map((s) => s.kind).join(" and ")} evidence: not enough to file it against ${top.label} without Chris.`
    : !clear
      ? `Two possible matches are too close (${top.label} ${top.score.toFixed(2)} vs ${second!.label} ${second!.score.toFixed(2)}).`
      : `Confidence ${top.score.toFixed(2)} is below ${MATCH_THRESHOLD}.`;
  return { status: "needs_review", chosen: null, candidates, confidence: top.score, reason: why };
}
