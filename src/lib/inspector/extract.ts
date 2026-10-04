/**
 * What an email or conversation says, read with explicit rules. Every fact keeps the sentence it
 * came from, so a reviewer can see why the Inspector thinks it. Pure: no database.
 *
 * This deliberately does not design or price anything: the Business Brain does that.
 */
import { findTimePhrase, resolveDue } from "./dates";
import { emailsIn, getSecureSpeaker, phonesIn, sentences, toNumber } from "./text";
import type { Commitment, ExtractedFact, InspectorInput, Intent, PropertyType, ServiceType, Understanding, Urgency } from "./types";

export type ExtractContext = {
  /** First names of Get Secure staff, to tell who is speaking. */
  staffNames: string[];
  /** The lead already has a quote / a sent quote / an open job. */
  hasQuote: boolean;
  hasSentQuote: boolean;
  hasOpenJob: boolean;
  /** Already a known lead/customer (not a brand-new enquiry). */
  known: boolean;
};

type Sentence = { text: string; speaker: "get_secure" | "customer" | "unknown"; speakerName: string | null };

const SERVICE_RULES: [ServiceType, RegExp][] = [
  ["cctv", /\b(cctv|cameras?|surveillance|nvr|dvr|security cam(era)?s?|footage)\b/i],
  ["alarm", /\b(alarms?|intruder|burglar alarm|sensors?|siren|monitoring|keypad|panic button)\b/i],
  ["access_control", /\b(access control|swipe card|fobs?|card readers?|door access|maglock)\b/i],
  ["intercom", /\b(intercom|video doorbell|doorbell|door station|gate phone)\b/i],
  ["networking", /\b(wi-?fi|data cabling|network cabling|access points?|router)\b/i],
];

const COMMERCIAL = /\b(business|office|offices|shop|store|warehouse|factory|restaurant|cafe|café|premises|commercial|retail|workshop|tenants?|body corporate|apartment block|school|church|clinic|our staff|employees|car ?park|site manager|company)\b/i;
const RESIDENTIAL = /\b(house|home|my place|our place|residential|family|kids|backyard|back yard|bach|townhouse|our property|my property|my wife|my husband|my partner|neighbours?)\b/i;

const AREA_WORDS = ["driveway", "front door", "back door", "backyard", "back yard", "garage", "side gate", "gate", "deck", "carport", "entrance", "car park", "carpark", "reception", "shop floor", "warehouse", "boundary", "pool", "street", "front yard", "letterbox", "shed"];
const BRANDS = ["hikvision", "dahua", "vigi", "tp-link", "hilook", "uniview", "axis", "ajax", "arlo", "ring", "eufy", "swann", "tiandy", "tvt", "hanwha"];

const ADDRESS = /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][a-zA-Z']+\s){1,3}(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Place|Pl|Crescent|Cres|Terrace|Tce|Lane|Ln|Way|Close|Court|Ct|Grove|Parade|Highway|Hwy|Boulevard|Rise|Heights|Mews|Glade|View|Quay)\b(?:,?\s+(?!(?:and|but|in|on|at|for|with)\b)[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)?/;

const INTENT_RULES: [Intent, RegExp][] = [
  ["service_issue", /\b(not working|stopped working|isn'?t working|offline|faulty|fault|broken|no picture|can'?t see (the )?(cameras?|footage)|isn'?t recording|stopped recording|beeping|keeps going off|false alarms?)\b/i],
  ["acceptance", /\b(go ahead|happy to proceed|we'?d like to proceed|please proceed|accept (the|your) quote|quote (is )?accepted|let'?s do it|we'?ll go with (it|the|your|that)|book (us|me|it) in|sounds good,? let'?s|we'?re happy with the quote|confirm(ed)? the quote)\b/i],
  ["site_visit_request", /\b(site visit|come (out|round|over|and (have a )?look)|pop (round|over|out)|have a look at (the|my|our)|someone (to )?come (out|round|and)|inspect (the|my|our))\b/i],
  ["booking_request", /\b(book (in|it|a time)|when can you (come|install|do|start)|are you available|what (day|time)s? suits|can you do (it )?(on )?(monday|tuesday|wednesday|thursday|friday|saturday|this week|next week)|install(ed)? (by|before|next))\b/i],
  ["quote_request", /\b(quote|quotation|price|pricing|cost|how much|estimate|ballpark)\b/i],
  ["follow_up", /\b(following up|just checking|any update|chasing|did you (get|receive)|haven'?t heard|still waiting)\b/i],
];
const NEGATED_ACCEPT = /\b(not (ready|going) to (go ahead|proceed)|won'?t be (going ahead|proceeding)|not proceed)\b/i;

const OBJECTIONS: [Understanding["objections"][number]["kind"], RegExp][] = [
  ["price", /\b(too expensive|a bit (much|steep|pricey)|over (our|my) budget|out of (our|my) (price range|budget)|can'?t afford|cheaper option|more than (we|i) (expected|wanted))\b/i],
  ["competitor", /\b(other quotes?|another quote|cheaper quote|someone else|another company|got a quote from|quoted (us|me) less)\b/i],
  ["timing", /\b(not (right )?now|not ready yet|later in the year|after (christmas|xmas|the holidays)|hold off|on hold)\b/i],
  ["undecided", /\b(think about it|get back to you|discuss (it )?with|talk to my (wife|husband|partner)|check with my (wife|husband|partner|boss|manager)|mull it over|sleep on it)\b/i],
  ["scope", /\b(don'?t need (that|all|so)|do (we|i) really need|too many cameras|only want)\b/i],
];

const COMMITMENT = /\b(i'?ll|i will|i'?m going to|we'?ll|we will|i can|let me)\b\s+(?!know\b|be\b|have a think|think\b)([^.?!]*)/i;
const COMMITMENT_ACTIONS: [Commitment["actionKey"], RegExp, string][] = [
  ["send_quote", /\b(send|email|get|have|put together|draw up|forward)\b[^.?!]*\b(quote|quotation|price|pricing|proposal)\b/i, "Send the quote"],
  ["send_photos", /\b(send|email|text|take|forward|get)\b[^.?!]*\b(photos?|pics?|pictures?|images?|video)\b/i, "Send photos"],
  ["visit", /\b(come (out|round|over|and)|pop (round|over|out|in)|visit|swing by|have a look)\b/i, "Visit the site"],
  ["call", /\b(call|ring|phone|give (you|him|her|them) a (call|ring|bell))\b/i, "Call"],
  ["send_info", /\b(send|email|forward|text)\b[^.?!]*\b(details|info|information|spec|specs|brochure|plans?|floor ?plan|address|measurements?|link)\b/i, "Send information"],
  ["pay", /\b(pay|deposit|transfer|payment)\b/i, "Pay"],
  ["confirm", /\b(confirm|let you know|get back to you|check with)\b/i, "Confirm / get back"],
  ["check", /\b(check|find out|look into|work out|look at)\b/i, "Check"],
];

function words(s: string) {
  return s.length > 220 ? `${s.slice(0, 217)}…` : s;
}

/** Plaud's labels when it does not know who is talking. */
const GENERIC_SPEAKER = /^speaker\s*\d+$/i;

/** "Hi, it's Chris from Get Secure" / "Hemi Walker here": the name each generic speaker gave. */
function introducedNames(utterances: InspectorInput["utterances"]): Map<string, string> {
  const out = new Map<string, string>();
  for (const u of utterances) {
    if (!u.speaker || out.has(u.speaker)) continue;
    const m = /\b(?:this is|it'?s|i'?m|my name is)\s+([A-Z][a-z']+(?:\s[A-Z][a-z']+)?)/.exec(u.text) ?? /(?:^|[.,!]\s*)([A-Z][a-z']+(?:\s[A-Z][a-z']+)?)\s+here\b/.exec(u.text);
    if (m) out.set(u.speaker, m[1].replace(/\s+(from|on|here)$/i, ""));
  }
  return out;
}

/** Sentences with who said them (Get Secure, the customer, or unknown). */
export function speakerSentences(input: InspectorInput, staffNames: string[]): Sentence[] {
  if (input.sourceType === "recording" && input.utterances.length) {
    const gs = getSecureSpeaker(input.utterances, staffNames);
    const named = introducedNames(input.utterances);
    const out: Sentence[] = [];
    for (const u of input.utterances) {
      const who: Sentence["speaker"] = !u.speaker || !gs ? "unknown" : u.speaker === gs ? "get_secure" : "customer";
      const name = u.speaker && GENERIC_SPEAKER.test(u.speaker) ? (named.get(u.speaker) ?? null) : u.speaker;
      for (const t of sentences(u.text)) out.push({ text: t, speaker: who, speakerName: name });
    }
    return out;
  }
  const who: Sentence["speaker"] = input.direction === "outbound" ? "get_secure" : "customer";
  return sentences(input.text).map((t) => ({ text: t, speaker: who, speakerName: input.direction === "outbound" ? null : input.from.name }));
}

export function extract(input: InspectorInput, ctx: ExtractContext): Understanding {
  const ss = speakerSentences(input, ctx.staffNames);
  // Facts about the customer and site come from what the customer says (or anyone, in emails we did not write).
  const customerSide = ss.filter((s) => s.speaker !== "get_secure");
  const all = ss.map((s) => s.text).join(" ");
  const custText = customerSide.map((s) => s.text).join(" ");
  const factText = input.direction === "outbound" ? "" : `${input.title}. ${custText}`;
  const facts: ExtractedFact[] = [];
  const find = (re: RegExp, list: Sentence[] = customerSide) => list.find((s) => re.test(s.text))?.text ?? null;
  const add = (f: ExtractedFact) => {
    if (!facts.some((x) => x.key === f.key)) facts.push({ ...f, evidence: words(f.evidence) });
  };

  // ---- a website enquiry form says it outright ----
  if (input.form) {
    const f = input.form.fields;
    const ev = (label: string) => `${label}: ${f[label]}`;
    const prop = (f["Property"] ?? "").toLowerCase();
    if (/commercial|business|office|shop|warehouse|retail/.test(prop)) add({ key: "property_type", value: "commercial", display: "Commercial", evidence: ev("Property"), confidence: 0.95 });
    else if (/residential|home|house/.test(prop)) add({ key: "property_type", value: "residential", display: "Residential", evidence: ev("Property"), confidence: 0.95 });
    const cams = Number((f["Cameras"] ?? "").match(/\d+/)?.[0] ?? NaN);
    if (Number.isFinite(cams) && cams > 0) add({ key: "camera_count", value: cams, display: `${cams} cameras`, evidence: ev("Cameras"), confidence: 0.95 });
    const st = (f["Storeys"] ?? "").toLowerCase();
    if (/double|two|2/.test(st)) add({ key: "storeys", value: 2, display: "Two storeys", evidence: ev("Storeys"), confidence: 0.95 });
    else if (/single|one|1/.test(st)) add({ key: "storeys", value: 1, display: "Single storey", evidence: ev("Storeys"), confidence: 0.95 });
    const setup = (f["Current Setup"] ?? "").toLowerCase();
    if (/upgrade|replace|existing/.test(setup)) add({ key: "job_type", value: "upgrade", display: "Upgrade of an existing system", evidence: ev("Current Setup"), confidence: 0.9 });
    else if (/new|none|no system/.test(setup)) add({ key: "job_type", value: "new", display: "New installation", evidence: ev("Current Setup"), confidence: 0.9 });
    if (input.form.address) add({ key: "site_address", value: input.form.address, display: input.form.address, evidence: `Address: ${input.form.address}`, confidence: 0.95 });
    if (input.form.phone) add({ key: "phone", value: input.form.phone.replace(/\D/g, "").replace(/^64/, "0"), display: input.form.phone, evidence: `Phone: ${input.form.phone}`, confidence: 0.95 });
    if (input.form.name) add({ key: "contact_name", value: input.form.name, display: input.form.name, evidence: `Name: ${input.form.name}`, confidence: 0.9 });
  }

  // ---- service and property ----
  let service: ServiceType | null = null;
  let best = 0;
  for (const [svc, re] of SERVICE_RULES) {
    const n = ss.filter((s) => re.test(s.text)).length + (re.test(input.title) ? 1 : 0);
    if (n > best) {
      best = n;
      service = svc;
    }
  }
  if (!service && input.form?.service) {
    const hit = SERVICE_RULES.find(([, re]) => re.test(input.form!.service!));
    if (hit) service = hit[0];
  }
  if (service && input.direction !== "outbound") {
    const ev = find(SERVICE_RULES.find((r) => r[0] === service)![1]) ?? input.title;
    add({ key: "service", value: service, display: { cctv: "CCTV", alarm: "Alarm", access_control: "Access control", intercom: "Intercom", networking: "Networking", other: "Other" }[service], evidence: ev, confidence: 0.85 });
  }
  let propertyType: PropertyType | null = (facts.find((f) => f.key === "property_type")?.value as PropertyType | undefined) ?? null;
  const com = find(COMMERCIAL);
  const res = find(RESIDENTIAL);
  if (!propertyType) {
    if (com && (!res || /\b(business|commercial|premises|office|warehouse|shop|company)\b/i.test(com))) propertyType = "commercial";
    else if (res) propertyType = "residential";
  }
  if (propertyType) add({ key: "property_type", value: propertyType, display: propertyType === "commercial" ? "Commercial" : "Residential", evidence: (propertyType === "commercial" ? com : res)!, confidence: 0.8 });

  // ---- contact details ----
  if (input.direction !== "outbound") {
    for (const p of phonesIn(factText)) {
      add({ key: "phone", value: p, display: p, evidence: find(/\d{3}/) ?? p, confidence: 0.9 });
      break;
    }
    const em = emailsIn(factText).find((e) => e !== input.from.email?.toLowerCase());
    if (em) add({ key: "email", value: em, display: em, evidence: find(/@/) ?? em, confidence: 0.85 });
    if (input.sourceType === "email" && input.from.email && !/noreply|no-reply/i.test(input.from.email)) add({ key: "email", value: input.from.email.toLowerCase(), display: input.from.email.toLowerCase(), evidence: `From: ${input.from.email}`, confidence: 0.95 });
    const named = customerSide.map((s) => /\b(?:my name is|this is|it'?s|i'?m) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b(?! from get secure)/.exec(s.text)).find((m) => m && !ctx.staffNames.some((n) => m[1].toLowerCase().startsWith(n.toLowerCase())));
    if (named) add({ key: "contact_name", value: named[1], display: named[1], evidence: named[0], confidence: 0.75 });
    else if (input.sourceType === "email" && input.from.name && !/noreply|website|wordpress/i.test(input.from.name)) add({ key: "contact_name", value: input.from.name, display: input.from.name, evidence: `From: ${input.from.name}`, confidence: 0.7 });
    const company = /\b([A-Z][\w&'-]+(?:\s[A-Z][\w&'-]+){0,3}\s(?:Ltd|Limited|Group|Holdings|Trust|Partners))\b/.exec(custText);
    if (company && !/get secure/i.test(company[1])) add({ key: "company", value: company[1], display: company[1], evidence: find(new RegExp(company[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) ?? company[1], confidence: 0.75 });
    const addr = ADDRESS.exec(factText);
    if (addr) add({ key: "site_address", value: addr[0].trim(), display: addr[0].trim(), evidence: find(new RegExp(addr[0].slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) ?? addr[0], confidence: 0.85 });
  }

  // ---- the system wanted ----
  const requested: Understanding["requested"] = [];
  for (const s of customerSide) {
    const m = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of)\s+(?:(?:new|more|extra|outdoor|indoor|security|cctv|ip|external|additional|hd)\s+){0,2}(cameras?|cams?|sensors?|detectors?|doorbells?|readers?|fobs?)\b/i.exec(s.text);
    if (!m) continue;
    const qty = toNumber(m[1].replace(/^a couple of$/i, "couple"));
    const existing = /\b(already|existing|currently|at the moment|old|we have|we've got|i have|i've got)\b/i.test(s.text) && !/\b(want|need|add|more|extra|another|new|install)\b/i.test(s.text);
    if (/cam/i.test(m[2])) {
      if (existing) add({ key: "existing_system", value: `${qty ?? ""} existing cameras`.trim(), display: `${qty ?? "Some"} existing cameras`, evidence: s.text, confidence: 0.75 });
      else if (qty) add({ key: "camera_count", value: qty, display: `${qty} cameras`, evidence: s.text, confidence: 0.85 });
    }
    if (!existing) requested.push({ item: m[2].toLowerCase().replace(/s$/, "") + "s", quantity: qty, evidence: words(s.text) });
  }
  const storey = find(/\b(single|one|double|two)[- ]stor(e)?y\b|\b(two|2) levels?\b|\bsplit[- ]level\b/i);
  if (storey) {
    const two = /\b(double|two|2)\b|split/i.test(storey);
    add({ key: "storeys", value: two ? 2 : 1, display: two ? "Two storeys" : "Single storey", evidence: storey, confidence: 0.85 });
  }
  const upgrade = find(/\b(upgrade|replace (my|our|the) (old|existing)|existing (system|cameras|cctv|alarm)|old (system|cameras|dvr|nvr)|currently have|we have (some|an old|old)|already have)\b/i);
  const fresh = find(/\b(new (system|install|installation)|don'?t have any|no cameras|first (system|time)|brand new (house|build|home))\b/i);
  const repair = find(INTENT_RULES[0][1]);
  if (repair) add({ key: "job_type", value: "repair", display: "Repair / service", evidence: repair, confidence: 0.8 });
  else if (upgrade) add({ key: "job_type", value: "upgrade", display: "Upgrade of an existing system", evidence: upgrade, confidence: 0.8 });
  else if (fresh) add({ key: "job_type", value: "new", display: "New installation", evidence: fresh, confidence: 0.8 });
  const cab = find(/\b(cat ?5e?|cat ?6a?|ethernet cabl\w*|coax\w*|rg ?59|analogu?e)\b/i);
  if (cab) {
    const coax = /coax|rg ?59|analog/i.test(cab);
    add({ key: "existing_cabling", value: coax ? "coax" : /cat ?6/i.test(cab) ? "cat6" : "cat5e", display: coax ? "Coax (analogue)" : /cat ?6/i.test(cab) ? "Cat6" : "Cat5e", evidence: cab, confidence: 0.8 });
  }
  // Areas to cover: from what the customer wants, not from their own promises ("photos of the garage").
  // Addresses are taken out first, so "12 Kauri Street" is not a camera on the street.
  const wantText = customerSide
    .filter((s) => !COMMITMENT.test(s.text))
    .map((s) => s.text.replace(new RegExp(ADDRESS.source, "g"), " "))
    .join(" ");
  const areas = AREA_WORDS.filter((a) => new RegExp(`\\b${a}\\b`, "i").test(wantText));
  const uniqueAreas = areas.filter((a) => !areas.some((b) => b !== a && b.includes(a)));
  if (uniqueAreas.length) add({ key: "areas", value: uniqueAreas.join(", "), display: uniqueAreas.map((a) => a[0].toUpperCase() + a.slice(1)).join(", "), evidence: find(new RegExp(`\\b${uniqueAreas[0]}\\b`, "i")) ?? uniqueAreas.join(", "), confidence: 0.75 });
  const remote = find(/\b(on|from) my phone\b|\bon (the|an|my) app\b|\bremotely\b|\bview\w* (it )?(from|while) (away|anywhere|work)\b/i);
  if (remote) add({ key: "remote_viewing", value: true, display: "Wants to view on phone/app", evidence: remote, confidence: 0.8 });
  const brand = BRANDS.find((b) => new RegExp(`\\b${b}\\b`, "i").test(custText));
  if (brand) add({ key: "brand", value: brand, display: brand === "tp-link" || brand === "vigi" ? "TP-Link VIGI" : brand[0].toUpperCase() + brand.slice(1), evidence: find(new RegExp(`\\b${brand}\\b`, "i")) ?? brand, confidence: 0.7 });

  // ---- money and time ----
  const budget: Understanding["budget"] = [];
  for (const s of customerSide) {
    if (!/\b(budget|spend|afford|around|under|no more than|up to|max(imum)?|about)\b/i.test(s.text)) continue;
    const m = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\b/i.exec(s.text);
    if (!m) continue;
    const amount = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
    budget.push({ text: m[0], amount, evidence: words(s.text) });
  }
  if (budget.length) add({ key: "budget", value: budget[0].amount ?? budget[0].text, display: `Budget ${budget[0].text}`, evidence: budget[0].evidence, confidence: 0.75 });
  const timing: Understanding["timing"] = [];
  for (const s of customerSide) {
    if (COMMITMENT.test(s.text)) continue; // their own promises are commitments, not timing requests
    const t = /\b(asap|as soon as possible|urgent(ly)?|this week|next week|before (christmas|xmas|the holidays|(monday|tuesday|wednesday|thursday|friday|saturday|sunday))|by (the )?end of (the )?(month|week|year)|next month|within (a|\d+) weeks?|in (january|february|march|april|may|june|july|august|september|october|november|december))\b/i.exec(s.text);
    if (t) timing.push({ text: t[0].toLowerCase(), evidence: words(s.text) });
  }
  if (timing.length) add({ key: "timing", value: timing[0].text, display: `Wanted: ${timing[0].text}`, evidence: timing[0].evidence, confidence: 0.75 });

  // ---- intents ----
  const intents = new Set<Intent>();
  for (const [intent, re] of INTENT_RULES) {
    const hit = customerSide.find((s) => re.test(s.text)) ?? (re.test(input.title) && input.direction !== "outbound" ? { text: input.title } : null);
    if (!hit) continue;
    if (intent === "acceptance" && NEGATED_ACCEPT.test(hit.text)) continue;
    intents.add(intent);
  }
  if (intents.has("site_visit_request") || (facts.find((f) => f.key === "site_address") && intents.has("booking_request"))) {
    const ev = find(INTENT_RULES.find((r) => r[0] === "site_visit_request")![1]);
    if (ev) add({ key: "site_visit_requested", value: true, display: "Asked for a site visit", evidence: ev, confidence: 0.85 });
  }
  if (ctx.hasQuote && customerSide.some((s) => /\b(add|another|extra|one more|remove|instead|change|swap|fewer|less cameras|revise|revised|updated quote|amend)\b/i.test(s.text))) intents.add("quote_change");
  const objections: Understanding["objections"] = [];
  for (const [kind, re] of OBJECTIONS) {
    const hit = customerSide.find((s) => re.test(s.text));
    if (hit) objections.push({ kind, evidence: words(hit.text) });
  }
  if (objections.length) intents.add("objection");
  if (customerSide.some((s) => /\?\s*$/.test(s.text)) && !intents.size) intents.add("question");
  if (!ctx.known && service && input.direction !== "outbound") intents.add("new_enquiry");
  if (!intents.size) intents.add(service || facts.length ? "information" : "not_relevant");
  const ORDER: Intent[] = ["service_issue", "acceptance", "objection", "quote_change", "site_visit_request", "booking_request", "quote_request", "follow_up", "new_enquiry", "question", "information", "not_relevant"];
  const primaryIntent = ORDER.find((i) => intents.has(i))!;

  // ---- decisions and commitments ----
  const decisions: Understanding["decisions"] = [];
  for (const s of ss) {
    if (/\b(we'?ve decided|decided to|we'?ll go with|let'?s go with|go ahead|we'?ll stick with|agreed to|happy with (that|the))\b/i.test(s.text) && !NEGATED_ACCEPT.test(s.text)) decisions.push({ text: words(s.text), evidence: words(s.text) });
  }
  const commitments: Commitment[] = [];
  for (const s of ss) {
    const m = COMMITMENT.exec(s.text);
    if (!m || /\?\s*$/.test(s.text) || /\b(if|unless|maybe|might|could you|can you)\b/i.test(s.text.slice(0, m.index))) continue;
    const rest = m[2];
    const act = COMMITMENT_ACTIONS.find(([, re]) => re.test(rest));
    if (!act) continue;
    const phrase = findTimePhrase(s.text);
    const due = phrase ? resolveDue(phrase, input.at) : null;
    const owner = s.speaker === "unknown" ? "unknown" : s.speaker;
    commitments.push({
      owner,
      ownerName: owner === "get_secure" ? (s.speakerName ?? "Get Secure") : s.speakerName,
      action: actionText(act[0], act[2], rest),
      actionKey: act[0],
      dueAt: due ? due.toISOString() : null,
      dueText: phrase,
      evidence: words(s.text),
      confidence: owner === "unknown" ? 0.5 : phrase ? 0.85 : 0.7,
    });
  }

  // ---- urgency ----
  let urgency: Urgency = "normal";
  if (/\b(urgent|urgently|emergency|break-?in|broken into|burglar(y|ised)|robbed|vandal\w*|immediately|asap|as soon as possible)\b/i.test(custText)) urgency = "urgent";
  else if (/\b(this week|soon|quickly|tomorrow|this weekend)\b/i.test(custText)) urgency = "high";
  else if (/\b(no rush|not urgent|whenever|next year|sometime|no hurry)\b/i.test(custText)) urgency = "low";

  const quoteRefs = [...new Set([...all.matchAll(/\bQ-?(\d{3,6})\b/g)].map((m) => Number(m[1])))];
  return {
    service,
    propertyType,
    intents: [...intents],
    primaryIntent,
    urgency,
    facts,
    requested,
    timing,
    budget,
    objections,
    decisions,
    commitments,
    missing: [],
    quoteRefs,
    summary: "",
  };
}

/** The promise in the words used: "send the quote tonight" → "Send the quote tonight". */
function actionText(key: Commitment["actionKey"], fallback: string, rest: string): string {
  const r = rest.replace(/\s+/g, " ").trim().replace(/[,;:]+$/, "");
  if (key === "other" || r.length < 4) return fallback;
  const short = r.length > 80 ? `${r.slice(0, 77)}…` : r;
  return short.charAt(0).toUpperCase() + short.slice(1);
}
