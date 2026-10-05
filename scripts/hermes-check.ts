/**
 * Check the live Hermes against the Inspector's invariants, without touching the CRM.
 *
 *   docker compose -f docker-compose.prod.yml exec web pnpm hermes:check
 *
 * Each situation (a website form, a vague email, an unknown sender at a known site, an ambiguous
 * name, a supplier statement…) goes to the configured Hermes exactly as the Inspector would send it,
 * then through the same validator. The situations are not business rules: what is checked is the
 * set of general invariants in src/lib/hermes/invariants.ts (customer-facing work stays gated, the
 * Business Brain keeps its authority, structured evidence survives, identity blocks only what needs
 * it, research stays isolated, review is exceptional). A failure prints the exact invariant that
 * broke and why. A few "judgement" lines (is a supplier statement a lead?) are reported separately:
 * they check Hermes's reading, not the CRM.
 *
 * Nothing is written: no lead, task, quote, draft or audit row.
 */
import { askHermes } from "@/lib/hermes/inspector";
import { buildContextPack } from "@/lib/hermes/context";
import { getHermes } from "@/lib/hermes/runtime";
import { AUTONOMY_DEFAULTS } from "@/lib/hermes/autonomy";
import { checkInvariants } from "@/lib/hermes/invariants";
import { validateHermes, type ValidateContext } from "@/lib/inspector/validate";
import { parseTranscript } from "@/lib/inspector/text";
import { parseWebsiteLead } from "@/lib/email/website-lead";
import type { HermesResult } from "@/lib/hermes/contract";
import type { IdentityResult, InspectorInput } from "@/lib/inspector/types";
import type { Known } from "@/lib/inspector/types";

const AT = new Date();
const LEAD = "00000000-0000-0000-0000-0000000000a1";
const matched: IdentityResult = { status: "matched", chosen: { leadId: LEAD, contactId: null, jobId: null, label: "Test customer", score: 0.95, signals: [{ kind: "thread", detail: "the email thread", weight: 0.95 }] }, candidates: [], confidence: 0.95, reason: "the email thread" };
const nobody: IdentityResult = { status: "needs_review", chosen: null, candidates: [], confidence: 0, reason: "Nothing identifies who this is." };

function email(text: string, subject = "Enquiry", from = { name: "Test Customer", email: "test.customer@example.com", phone: null as string | null }): InspectorInput {
  const web = parseWebsiteLead({ subject, text, fromAddress: from.email });
  return {
    sourceType: "email",
    sourceId: "00000000-0000-0000-0000-000000000001",
    direction: "inbound",
    at: AT,
    title: subject,
    text,
    utterances: [],
    from: web ? { name: web.extraction.contact_name, email: web.extraction.email, phone: web.extraction.phone } : from,
    form: web ? { fields: web.fields, name: web.extraction.contact_name, email: web.extraction.email, phone: web.extraction.phone, service: web.extraction.service, address: web.extraction.site_address } : null,
    context: [],
    linked: { leadId: null, contactId: null, jobId: null, how: null },
  };
}
function call(transcript: string, title = "Call"): InspectorInput {
  return { ...email(transcript, title), sourceType: "recording", direction: "conversation", from: { name: null, email: null, phone: null }, utterances: parseTranscript(transcript), form: null };
}

type Situation = {
  name: string;
  input: InspectorInput;
  identity: IdentityResult;
  known?: Known;
  crm?: Partial<ValidateContext["crm"]>;
  /** A known site/job this source names: the CRM's evidence check accepts it when Hermes chooses it. */
  site?: { ref: string; label: string };
  /** Hermes's reading (not a CRM rule), reported separately. */
  judgement?: (h: HermesResult) => string | null;
};

const SITUATIONS: Situation[] = [
  {
    name: "Complete website form (structured fields)",
    input: email(
      "New Lead · CCTV Landing\n\nISAPELA MASOE\n\nPhone 021 088 5669 Email isapela@example.com ServiceCCTV Installation\n\nREQUEST SUMMARY\n\nPropertyResidential HomeStoreysDouble storeyCameras4Current SetupNew InstallationTimelineAs Soon As PossibleAddress7 Solo Place, Manurewa\n\nSent from the Get Secure website.",
      "New Lead · CCTV Landing",
      { name: "Get Secure Website", email: "noreply@updates.getsecure.co.nz", phone: null },
    ),
    identity: matched,
    judgement: (h) => (["information", "not_relevant"].includes(h.intent) ? `read as ${h.intent}` : null),
  },
  { name: "Vague residential CCTV email", input: email("Hi there, how much for some security cameras?", "Cameras"), identity: matched },
  { name: "Commercial CCTV email", input: email("We need CCTV for our warehouse at 5 Allens Road, East Tamaki. Around 10 cameras.", "Warehouse CCTV"), identity: matched },
  {
    name: "Ambiguous identity (a name only) wanting a quote",
    input: call("Speaker 1: Hi it's Chris from Get Secure.\nSpeaker 2: Hi, Hemi Walker here. We want 4 cameras for the house, single storey.", "Site chat"),
    identity: { status: "needs_review", chosen: null, candidates: [{ leadId: "00000000-0000-0000-0000-00000000000a", contactId: null, jobId: null, label: "Hemi Walker", score: 0.2, signals: [{ kind: "name", detail: "name Hemi Walker", weight: 0.2 }] }], confidence: 0.2, reason: "Only name evidence." },
  },
  { name: "Conflicting address", input: email("Sorry, the address is actually 14 Kauri Street, Grey Lynn.", "Re: CCTV quote"), identity: matched, known: { site_address: "12 Kauri Street, Grey Lynn" } },
  { name: "Conversation with commitments", input: call("[00:00 - 00:06] Speaker 1: Hi, it's Chris from Get Secure.\n[00:06 - 00:20] Speaker 2: Hi Chris, it's Mere. We're after 4 cameras for the house, single storey.\n[00:20 - 00:31] Speaker 1: Great, I'll send the quote tonight.\n[00:31 - 00:40] Speaker 2: Perfect, I'll send the photos tomorrow."), identity: matched },
  { name: "Newsletter", input: email("Our October newsletter: new products, webinars and offers. Unsubscribe here.", "October newsletter", { name: "Supplier News", email: "news@example.com", phone: null }), identity: nobody, judgement: (h) => (h.lead_decision === "lead" ? "a newsletter read as a lead" : null) },
  { name: "Enquiry inside an admin-looking email", input: email("Thanks for your order confirmation. While I have you, could I get a quote for 3 cameras for our house? Single storey.", "About your order"), identity: matched, judgement: (h) => (h.recommended_action === "NO_ACTION" ? "a quote request read as nothing to do" : null) },
  {
    name: "Unknown sender about a known site",
    input: email("Hi, the keypad at 138 Wiri Station Road is beeping again and won't arm. Zavier", "Keypad", { name: "Zavier", email: "zavier@example.com", phone: null }),
    identity: { status: "needs_review", chosen: null, candidates: [{ leadId: "00000000-0000-0000-0000-00000000000b", contactId: null, jobId: null, label: "Wiri Depot (138 Wiri Station Road)", score: 0.5, signals: [{ kind: "address", detail: "address 138 Wiri Station Road", weight: 0.5 }] }], confidence: 0.5, reason: "Only address evidence." },
    site: { ref: "lead:00000000-0000-0000-0000-00000000000b", label: "Wiri Depot (138 Wiri Station Road)" },
  },
  { name: "Supplier statement", input: email("Dear customer, please find attached your statement of account for October 2026. Balance due: $1,840.25 by 20 November. Dicker Data Accounts Receivable", "Statement of account - October 2026", { name: "Dicker Data Accounts", email: "ar@dickerdata.example", phone: null }), identity: nobody, judgement: (h) => (h.lead_decision === "lead" ? "a statement read as a lead" : null) },
  { name: "Provider statement", input: email("Your Alarm Watch monitoring statement for October is attached. Monitored sites: 14. Amount due $612.50.", "Alarm Watch monthly statement", { name: "Alarm Watch Billing", email: "billing@alarmwatch.example", phone: null }), identity: nobody, judgement: (h) => (h.lead_decision === "lead" ? "a statement read as a lead" : null) },
  { name: "Technical question needing research", input: email("Our old Hikvision DS-7608NI-K2 recorder has died. Can our existing Hikvision cameras work with a new recorder, and which one would you put in?", "Recorder died"), identity: matched },
  { name: "After a quote was sent", input: email("Thanks for the quote. Bit more than we hoped, could you do anything on it?", "Re: Quote Q-1042"), identity: matched, crm: { hasSentQuote: true } },
];

async function main() {
  const runtime = getHermes();
  if (!runtime) {
    console.error("Hermes is not configured: set HERMES_API_URL and HERMES_API_KEY.");
    process.exit(2);
  }
  console.log(`Hermes: ${runtime.name} · model ${runtime.model}\n`);
  let failed = 0;
  let judgements = 0;
  for (const s of SITUATIONS) {
    const opts = { identity: s.identity, leadId: s.identity.chosen?.leadId ?? null, contactId: null, staffNames: ["Chris"] };
    const pack = await buildContextPack(s.input, opts).then((p) => p.pack).catch(() => null);
    const out = await askHermes(s.input, opts);
    if (out.status !== "ok" || !out.result) {
      failed++;
      console.log(`✘ ${s.name}\n    Hermes ${out.status}: ${out.error}\n`);
      continue;
    }
    const h = out.result;
    const chosen = h.operational_context.ref ?? (h.identity.suggestion === "candidate" ? h.identity.candidate_key : null);
    const context = s.site && chosen ? { ref: chosen, label: s.site.label, leadId: chosen === s.site.ref ? chosen.split(":")[1] : null, jobId: null, contactId: null, accepted: chosen === s.site.ref, why: chosen === s.site.ref ? "the message names the site" : "not the site the message names" } : null;
    const ctx: ValidateContext = {
      input: s.input,
      identity: s.identity,
      known: s.known ?? {},
      crm: { leadId: s.identity.chosen?.leadId ?? null, contactId: null, hasOpenBrainQuote: false, hasSentQuote: false, recordingLinked: false, customerEmail: null, customerPhone: null, ...(s.crm ?? {}) },
      autonomy: AUTONOMY_DEFAULTS,
      citable: s.identity.chosen?.leadId ? [`lead:${s.identity.chosen.leadId}`] : [],
      context,
    };
    const v = validateHermes(h, ctx);
    const results = checkInvariants({ hermes: h, validation: v, ctx, pack });
    const broken = results.filter((r) => !r.ok);
    const judged = s.judgement?.(h) ?? null;
    if (broken.length) failed++;
    if (judged) judgements++;
    console.log(`${broken.length ? "✘" : "✓"} ${s.name}  (${Math.round(out.durationMs / 100) / 10}s, ${results.length} invariants)`);
    console.log(`    Hermes: ${h.business_context} · lead: ${h.lead_decision} · ${h.intent} → ${h.recommended_action} · ${Math.round(h.confidence * 100)}%${chosen ? ` · context ${chosen}` : ""} · ${h.reason}`);
    console.log(`    CRM would: ${v.plan.map((p) => `${p.type}${p.mode === "approval" ? " (for Chris)" : ""}`).join(", ") || "nothing"}`);
    for (const r of broken) console.log(`    ✘ INVARIANT ${r.key}: ${r.title}\n        broken: ${r.detail}`);
    for (const d of v.decisions.filter((x) => !x.allowed)) console.log(`    guardrail refused ${d.action} (${d.rule})`);
    if (v.rejectedFacts.length) console.log(`    facts not used: ${v.rejectedFacts.map((r) => `${r.key}=${String(r.value)} (${r.reason})`).join("; ")}`);
    if (judged) console.log(`    ? judgement: ${judged}`);
    console.log("");
  }
  console.log(failed ? `${failed} of ${SITUATIONS.length} situations broke an invariant.` : `All invariants held in all ${SITUATIONS.length} situations.`);
  if (judgements) console.log(`${judgements} judgement note(s) to review (Hermes's reading; not a CRM failure).`);
  process.exit(failed ? 1 : 0);
}

void main();
