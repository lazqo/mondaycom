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

function answer(pack: Pack): Record<string, unknown> | "down" {
  const text = pack.source.text;
  if (/HERMES-DOWN/.test(text)) return "down";
  const form = pack.source.form?.fields;
  if (form?.Cameras) {
    const cams = Number(form.Cameras);
    const two = /double|two/i.test(form.Storeys ?? "");
    return {
      ...base,
      conversation_type: "new_enquiry",
      intent: "new_enquiry",
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
  const corrected = text.match(/the address is actually ([^.]+)\./i);
  if (corrected) {
    return { ...base, conversation_type: "existing_lead", intent: "information", summary: "Corrects the site address.", facts: [{ key: "site_address", value: corrected[1], evidence: `the address is actually ${corrected[1]}`, confidence: 0.95 }], reason: "Address correction." };
  }
  const cams = text.match(/quote for (\d+) cameras/i);
  if (cams) {
    const storey = text.match(/(single|double) storey/i);
    return {
      ...base,
      conversation_type: "new_enquiry",
      intent: "quote_request",
      service: "cctv",
      property_type: /house|home/i.test(text) ? "residential" : null,
      summary: `Residential CCTV enquiry: ${cams[1]} cameras.`,
      facts: [
        { key: "camera_count", value: Number(cams[1]), evidence: cams[0], confidence: 0.95 },
        ...(storey ? [{ key: "storeys", value: storey[1].toLowerCase() === "single" ? 1 : 2, evidence: storey[0], confidence: 0.95 }] : []),
        ...(/house|home/i.test(text) ? [{ key: "property_type", value: "residential", evidence: text.match(/our (house|home)/i)?.[0] ?? "house", confidence: 0.9 }] : []),
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
