/**
 * Check the live Hermes against the Inspector acceptance scenarios, without touching the CRM.
 *
 *   docker compose -f docker-compose.prod.yml exec app pnpm hermes:check
 *
 * Each scenario goes to the configured Hermes (HERMES_API_URL / HERMES_API_KEY) exactly as the
 * Inspector would send it, then through the same validator. It prints what Hermes recommended, how
 * sure it was, its reason, and what the CRM would do, and exits non-zero if a scenario's expectation
 * is not met. Nothing is written: no lead, task, quote, draft or audit row.
 */
import { askHermes } from "@/lib/hermes/inspector";
import { getHermes, hermesMinConfidence } from "@/lib/hermes/runtime";
import { validateHermes, type Validation } from "@/lib/inspector/validate";
import { parseTranscript } from "@/lib/inspector/text";
import { parseWebsiteLead } from "@/lib/email/website-lead";
import type { HermesResult } from "@/lib/hermes/contract";
import type { IdentityResult, InspectorInput } from "@/lib/inspector/types";
import type { Known } from "@/lib/inspector/missing";

const AT = new Date();
const matched: IdentityResult = { status: "matched", chosen: { leadId: null, contactId: null, jobId: null, label: "Test customer", score: 0.95, signals: [{ kind: "thread", detail: "the email thread", weight: 0.95 }] }, candidates: [], confidence: 0.95, reason: "the email thread" };
const nameOnly: IdentityResult = { status: "needs_review", chosen: null, candidates: [{ leadId: "00000000-0000-0000-0000-00000000000a", contactId: null, jobId: null, label: "Hemi Walker", score: 0.2, signals: [{ kind: "name", detail: "name Hemi Walker", weight: 0.2 }] }], confidence: 0.2, reason: "Only name evidence." };

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

type Scenario = { name: string; input: InspectorInput; identity: IdentityResult; known?: Known; expect: (h: HermesResult, v: Validation) => string | null };
const plan = (v: Validation) => v.plan.map((p) => p.type);

const SCENARIOS: Scenario[] = [
  {
    name: "1. CCTV landing-page lead",
    input: email(
      "New Lead · CCTV Landing\n\nISAPELA MASOE\n\nPhone 021 088 5669 Email isapela@example.com ServiceCCTV Installation\n\nREQUEST SUMMARY\n\nPropertyResidential HomeStoreysDouble storeyCameras2Current SetupNew InstallationTimelineAs Soon As PossibleAddress7 Solo Place, Manurewa\n\nSent from the Get Secure website.",
      "New Lead · CCTV Landing",
      { name: "Get Secure Website", email: "noreply@updates.getsecure.co.nz", phone: null },
    ),
    identity: matched,
    expect: (h) => (["information", "not_relevant"].includes(h.intent) ? `intent "${h.intent}"` : !["PREPARE_QUOTE", "RUN_BUSINESS_BRAIN"].includes(h.recommended_action) ? `recommended ${h.recommended_action}` : null),
  },
  {
    name: "2. Vague residential CCTV email",
    input: email("Hi there, how much for some security cameras?", "Cameras"),
    identity: matched,
    expect: (h, v) => {
      if (h.recommended_action !== "ASK_CUSTOMER" && !plan(v).includes("DRAFT_EMAIL")) return `recommended ${h.recommended_action}`;
      const bad = h.missing.filter((m) => m.blocking && /budget|address|phone|viewing/i.test(`${m.field} ${m.label}`));
      return bad.length ? `asks non-blocking: ${bad.map((m) => m.label).join(", ")}` : null;
    },
  },
  {
    name: "3. Commercial CCTV",
    input: email("We need CCTV for our warehouse at 5 Allens Road, East Tamaki. Around 10 cameras.", "Warehouse CCTV"),
    identity: matched,
    expect: (_h, v) => (plan(v).includes("PROPOSE_SITE_VISIT") ? null : `final plan ${plan(v).join(", ")}`),
  },
  {
    name: "4. Ambiguous identity (name only)",
    input: call("Speaker 1: Hi it's Chris from Get Secure.\nSpeaker 2: Hi, Hemi Walker here. We want 4 cameras for the house, single storey.", "Site chat"),
    identity: nameOnly,
    expect: (_h, v) => (v.reviewKind === "identity" && plan(v).every((t) => ["NEEDS_REVIEW", "LINK_RECORDING"].includes(t)) ? null : `plan ${plan(v).join(", ")}`),
  },
  {
    name: "5. Conflicting address",
    input: email("Sorry, the address is actually 14 Kauri Street, Grey Lynn.", "Re: CCTV quote"),
    identity: matched,
    known: { site_address: "12 Kauri Street, Grey Lynn" },
    expect: (h, v) => (v.understanding.facts.some((f) => f.key === "site_address" && /14 Kauri/.test(String(f.value))) ? null : `facts: ${JSON.stringify(h.facts.map((f) => [f.key, f.value]))}`),
  },
  {
    name: "6. Customer commitment",
    input: call("[00:00 - 00:06] Speaker 1: Hi, it's Chris from Get Secure.\n[00:06 - 00:20] Speaker 2: Hi Chris, it's Mere. We're after 4 cameras for the house.\n[00:31 - 00:40] Speaker 2: Perfect, I'll send the photos tomorrow."),
    identity: matched,
    expect: (_h, v) => {
      const c = v.understanding.commitments.find((x) => x.owner === "customer");
      return c?.dueAt ? null : `customer commitment: ${JSON.stringify(c ?? null)}`;
    },
  },
  {
    name: "7. Get Secure commitment",
    input: call("[00:00 - 00:06] Speaker 1: Hi, it's Chris from Get Secure.\n[00:06 - 00:20] Speaker 2: Hi Chris, it's Mere. We're after 4 cameras for the house, single storey.\n[00:20 - 00:31] Speaker 1: Great, I'll send the quote tonight."),
    identity: matched,
    expect: (_h, v) => {
      const c = v.understanding.commitments.find((x) => x.owner === "get_secure");
      return c?.dueText && /tonight/i.test(c.dueText) && c.dueAt ? null : `our commitment: ${JSON.stringify(c ?? null)}`;
    },
  },
  {
    name: "8. Newsletter (genuinely nothing to do)",
    input: email("Our October newsletter: new products, webinars and offers. Unsubscribe here.", "October newsletter", { name: "Supplier News", email: "news@example.com", phone: null }),
    identity: matched,
    expect: (h) => (["NO_ACTION", "NEEDS_REVIEW"].includes(h.recommended_action) ? null : `recommended ${h.recommended_action}`),
  },
];

async function main() {
  const runtime = getHermes();
  if (!runtime) {
    console.error("Hermes is not configured: set HERMES_API_URL and HERMES_API_KEY.");
    process.exit(2);
  }
  console.log(`Hermes: ${runtime.name} · model ${runtime.model}\n`);
  let failed = 0;
  for (const s of SCENARIOS) {
    const out = await askHermes(s.input, { identity: s.identity, leadId: null, contactId: null, staffNames: ["Chris"] });
    if (out.status !== "ok" || !out.result) {
      failed++;
      console.log(`✘ ${s.name}\n    Hermes ${out.status}: ${out.error}\n`);
      continue;
    }
    const h = out.result;
    const v = validateHermes(h, { input: s.input, identity: s.identity, known: s.known ?? {}, crm: { leadId: null, contactId: null, hasOpenBrainQuote: false, hasSentQuote: false, recordingLinked: false, customerEmail: null, customerPhone: null }, minConfidence: hermesMinConfidence(), rules: null });
    const problem = s.expect(h, v);
    if (problem) failed++;
    console.log(`${problem ? "✘" : "✓"} ${s.name}  (${Math.round(out.durationMs / 100) / 10}s)`);
    console.log(`    Hermes: ${h.intent} → ${h.recommended_action} · ${Math.round(h.confidence * 100)}% · ${h.reason}`);
    console.log(`    CRM would: ${plan(v).join(", ") || "nothing"}${v.headline.changedBy ? ` (changed by ${v.headline.changedBy})` : ""}`);
    for (const c of [...v.hard, ...v.business]) console.log(`    rule: ${c.message}`);
    if (problem) console.log(`    expected otherwise: ${problem}`);
    console.log("");
  }
  console.log(failed ? `${failed} of ${SCENARIOS.length} scenarios need attention.` : `All ${SCENARIOS.length} scenarios behave as expected.`);
  process.exit(failed ? 1 : 0);
}

void main();
