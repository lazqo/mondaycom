/**
 * A stand-in for Hermes Agent's API server (OpenAI-compatible POST /v1/chat/completions), for e2e
 * tests. It reads the CRM's context pack and answers the way the Inspector contract allows, from a
 * few simple cues, so the browser tests can follow the whole real HTTP path. It is not a model:
 * how well the real Hermes understands language is checked with `pnpm hermes:check`.
 *
 * TEST KEY only; never a real credential.
 */
import { createServer, type Server } from "node:http";

export const HERMES_MOCK_PORT = 3198;
export const HERMES_MOCK_KEY = "e2e-hermes-key-not-a-secret";

type Pack = {
  source: { type: string; text: string; title: string; form: { fields: Record<string, string> } | null; transcript: { turns: { speaker: string | null; text: string }[] } | null };
  identity: { status: string; candidates: { key: string; label: string }[] };
  crm: { lead: { id: string } | null } | null;
  answersFromChris?: { key: string; answer: string }[];
};

const base = {
  conversation_type: "other",
  intent: "information",
  service: null,
  property_type: null,
  summary: "Nothing to act on.",
  facts: [],
  objections: [],
  commitments: [],
  urgency: "normal",
  missing: [],
  recommended_action: "NO_ACTION",
  run_business_brain: false,
  task: null,
  reply_draft: null,
  identity: { suggestion: "unknown", candidate_key: null, reason: "" },
  conflicts: [],
  confidence: 0.9,
  reason: "Stand-in Hermes.",
  advisories: [],
};

/** A street address after "at", as written ("27 Kauri Grove, Albany"). */
const siteIn = (text: string) => text.match(/\bat (\d+[A-Za-z]? [A-Z][a-z']+(?: [A-Z][a-z']+)* (?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Place|Pl|Crescent|Cres|Grove|Lane|Way|Terrace)(?:, [A-Z][a-z]+(?: [A-Z][a-z]+)?)?)/)?.[1] ?? null;
/** An NZ mobile number as written ("021 555 0311"). */
const phoneIn = (text: string) => text.match(/\b0\d\d? ?\d{3,4} ?\d{3,4}\b/)?.[0] ?? null;
const contactFacts = (text: string) => [
  ...((s) => (s ? [{ key: "site_address", value: s, evidence: s, confidence: 0.95 }] : []))(siteIn(text)),
  ...((p) => (p ? [{ key: "phone", value: p, evidence: p, confidence: 0.95 }] : []))(phoneIn(text)),
];

function answer(pack: Pack): Record<string, unknown> | "down" {
  const text = pack.source.text;
  // Hermes decides whether it is a lead: a new enquiry from someone with no lead yet is one.
  const enquiry = pack.crm?.lead ? "existing" : "lead";
  if (/HERMES-DOWN/.test(text)) return "down";
  const form = pack.source.form?.fields;
  if (form?.Cameras) {
    const cams = Number(form.Cameras);
    const two = /double|two/i.test(form.Storeys ?? "");
    return {
      ...base,
      conversation_type: "new_enquiry",
      intent: "new_enquiry",
      lead_decision: enquiry,
      service: "cctv",
      property_type: "residential",
      summary: `New residential CCTV enquiry from the CCTV landing page: ${cams} cameras, ${two ? "two-storey" : "single-storey"}, new installation.`,
      facts: [
        { key: "property_type", value: "residential", evidence: `Property: ${form.Property}`, confidence: 0.97 },
        { key: "camera_count", value: cams, evidence: `Cameras: ${form.Cameras}`, confidence: 0.97 },
        { key: "storeys", value: two ? 2 : 1, evidence: `Storeys: ${form.Storeys}`, confidence: 0.95 },
      ],
      recommended_action: "PREPARE_QUOTE",
      run_business_brain: true,
      confidence: 0.94,
      reason: "New CCTV landing-page enquiry with the core residential quote requirements supplied.",
    };
  }
  const turns = pack.source.transcript?.turns ?? [];
  if (turns.length) {
    const ours = turns.find((t) => /I'll send the quote tonight/i.test(t.text));
    const theirs = turns.find((t) => /I'll send the photos/i.test(t.text));
    const named = turns.map((t) => t.text.match(/it's ([A-Z][a-z]+) on/)?.[1]).find(Boolean) ?? null;
    if (ours || theirs) {
      return {
        ...base,
        conversation_type: "existing_lead",
        intent: "follow_up",
        service: "cctv",
        summary: "Call about the cameras: Chris will send the quote tonight; the customer will send photos.",
        commitments: [
          ...(ours ? [{ owner: "get_secure", owner_name: "Chris", action: "Send the quote", action_key: "send_quote", due_text: "tonight", due_at: null, evidence: "I'll send the quote tonight" }] : []),
          ...(theirs ? [{ owner: "customer", owner_name: named, action: "Send the photos of the eaves", action_key: "send_photos", due_text: "tomorrow", due_at: null, evidence: theirs.text.match(/I'll send the photos[^.]*/)![0] }] : []),
        ],
        recommended_action: "WAITING_ON_CUSTOMER",
        reason: "Waiting on the customer's photos; Chris promised the quote tonight.",
      };
    }
    const candidate = pack.identity.candidates[0];
    return {
      ...base,
      conversation_type: "existing_lead",
      intent: "quote_change",
      service: "cctv",
      summary: "Wants a driveway camera added.",
      identity: candidate ? { suggestion: "candidate", candidate_key: candidate.key, reason: `Introduces themself as ${candidate.label}.` } : base.identity,
      recommended_action: "CREATE_INTERNAL_TASK",
      task: { title: "Add a driveway camera to the design", due: null, detail: null },
      reason: "Customer asked for an extra camera.",
    };
  }
  // A clear alarm enquiry: a lead, with what the email gives (the phone and the site, verbatim).
  const alarm = text.match(/want an? (Ajax alarm)[^.]*\./i);
  if (alarm) {
    return {
      ...base,
      conversation_type: "new_enquiry",
      intent: "quote_request",
      business_context: "customer_prospect",
      lead_decision: enquiry,
      service: "alarm",
      property_type: "residential",
      summary: "Ajax alarm enquiry for a new build; wants a rough cost and timing.",
      facts: [
        { key: "service", value: alarm[1], evidence: alarm[0], confidence: 0.95 },
        ...contactFacts(text),
        { key: "property_type", value: "residential", evidence: "building a new house", confidence: 0.9 },
      ],
      recommended_action: "CREATE_INTERNAL_TASK",
      task: { title: "Ring about the Ajax alarm for the new build", due: "today", detail: null },
      confidence: 0.92,
      reason: "A clear alarm enquiry with the site and a phone number.",
    };
  }
  // Too little to go on: Hermes thinks it may be a lead but is not sure, so Chris decides.
  if (/do you guys do houses/i.test(text)) {
    return { ...base, conversation_type: "new_enquiry", intent: "question", business_context: "customer_prospect", lead_decision: "lead", summary: "Asks whether Get Secure covers West Auckland houses and a rough price; no detail.", recommended_action: "NEEDS_REVIEW", review_question: "Is this worth a reply asking what they need?", confidence: 0.45, reason: "Might be an enquiry, but nothing says what for." };
  }
  // Which panel to fit: Hermes cannot know, so it asks once; with the answer it carries on.
  if (/which (alarm )?panel/i.test(text)) {
    const panel = (pack.answersFromChris ?? []).find((a) => a.key === "panel_brand")?.answer;
    return panel
      ? { ...base, conversation_type: "existing_lead", intent: "service_issue", summary: `Fit a ${panel} panel.`, recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Order the ${panel} panel`, due: "today", detail: null }, reason: "Chris said which panel." }
      : { ...base, conversation_type: "existing_lead", intent: "service_issue", summary: "Wants a new alarm panel; which one is Chris's call.", recommended_action: "CREATE_INTERNAL_TASK", task: { title: "Ring about the new panel", due: "today", detail: null }, questions: [{ key: "panel_brand", question: "Which alarm panel do we fit now?", kind: "choice", options: ["Ajax", "Paradox"], why: "The order depends on it.", unblocks: [], learn: true }], reason: "Need to know the panel." };
  }
  // A visit request with timing words: proposed with free slots; booked only when Chris accepts.
  if (/come (out )?and (have a )?look/i.test(text)) {
    const timing = text.match(/next week|this week|tomorrow|(?:on )?(?:monday|tuesday|wednesday|thursday|friday)(?: morning| afternoon)?/i)?.[0] ?? null;
    return { ...base, conversation_type: "existing_lead", intent: "site_visit_request", summary: "Asks for someone to come and look.", facts: timing ? [{ key: "timing", value: timing, evidence: timing, confidence: 0.9 }] : [], recommended_action: "PROPOSE_SITE_VISIT", reason: "Customer asked for a visit." };
  }
  const corrected = text.match(/the address is actually ([^.]+)\./i);
  if (corrected) {
    return { ...base, conversation_type: "existing_lead", intent: "information", summary: "Corrects the site address.", facts: [{ key: "site_address", value: corrected[1], evidence: `the address is actually ${corrected[1]}`, confidence: 0.95 }], reason: "Address correction." };
  }
  // A CCTV quote request: how many cameras, the kind of place, the site and the phone number.
  const cams = /quote/i.test(text) ? text.match(/(\d+) cameras/i) : null;
  if (cams) {
    const storey = text.match(/(single|double) storey/i);
    const home = text.match(/\b(our|my) (house|home)\b/i);
    const business = text.match(/\b(cafe|shop|office|warehouse|restaurant|store)\b/i);
    const property = home ? "residential" : business ? "commercial" : null;
    return {
      ...base,
      conversation_type: "new_enquiry",
      intent: "quote_request",
      business_context: "customer_prospect",
      lead_decision: enquiry,
      service: "cctv",
      property_type: property,
      summary: `${property === "commercial" ? "Commercial" : "Residential"} CCTV enquiry: ${cams[1]} cameras.`,
      facts: [
        { key: "camera_count", value: Number(cams[1]), evidence: cams[0], confidence: 0.95 },
        ...(storey ? [{ key: "storeys", value: storey[1].toLowerCase() === "single" ? 1 : 2, evidence: storey[0], confidence: 0.95 }] : []),
        ...(home ? [{ key: "property_type", value: "residential", evidence: home[0], confidence: 0.9 }] : []),
        ...(business ? [{ key: "property_type", value: "commercial", evidence: business[0], confidence: 0.9 }] : []),
        ...contactFacts(text),
      ],
      recommended_action: "PREPARE_QUOTE",
      run_business_brain: true,
      confidence: 0.92,
      reason: "A residential CCTV quote request with what the Brain needs.",
    };
  }
  return base;
}

export function startHermesMock(port = HERMES_MOCK_PORT): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/v1/chat/completions")) return void res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${HERMES_MOCK_KEY}`) return void res.writeHead(401).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const msgs = JSON.parse(body).messages as { role: string; content: string }[];
        const pack = JSON.parse(msgs[1].content.replace(/^Context pack:\n/, "")) as Pack;
        const out = answer(pack);
        if (out === "down") return void res.writeHead(503).end("Service unavailable");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "hermes-agent", choices: [{ message: { role: "assistant", content: JSON.stringify(out) } }] }));
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
