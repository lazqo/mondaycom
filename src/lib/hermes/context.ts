/**
 * The context pack Hermes reads for one email or conversation, and the Inspector prompt.
 *
 * The pack is data, built by the CRM: the source (with the website form's fields if it is one, and
 * the transcript turns), earlier messages, who it might be (the identity candidates and the
 * evidence for each), and, when the CRM already knows who it is, their record, open tasks,
 * commitments, quotes, visits, jobs, the latest Business Brain outcome and the recent timeline.
 * It goes through crm-read.ts, so it never carries supplier, cost or credential data.
 */
import type { IdentityResult, InspectorInput } from "@/lib/inspector/types";
import { getSecureSpeaker } from "@/lib/inspector/text";
import { TZ } from "@/lib/inspector/dates";
import { hermesResultJsonSchema, HERMES_INSPECTOR_VERSION } from "./contract";
import type { HermesMessage } from "./runtime";
import { readBrainOutcome, readCommitments, readCustomer, readFacts, readLead, readOpenTasks, readQuotes, readTimeline, readVisitsAndJobs } from "./crm-read";

export type HermesContextPack = Awaited<ReturnType<typeof buildContextPack>>["pack"];

/** Where an email came from, in words (a website form says which page). */
function originOf(input: InspectorInput): string {
  if (input.sourceType === "recording") return "Plaud recording of a conversation (call or site visit)";
  if (input.form) {
    const page = input.title.match(/\b([A-Za-z ]+ Landing)\b/i)?.[1] ?? input.title.match(/\[([^\]]+)\]/)?.[1] ?? null;
    return `Get Secure website form submission${page ? ` (${page.trim()} page)` : ""}`;
  }
  return input.direction === "outbound" ? "Email sent by Get Secure" : "Email received";
}

export async function buildContextPack(input: InspectorInput, opts: { identity: IdentityResult; leadId: string | null; contactId: string | null; staffNames: string[]; now?: Date }) {
  const now = opts.now ?? new Date();
  const gs = input.utterances.length ? getSecureSpeaker(input.utterances, opts.staffNames) : null;
  const scope = { leadId: opts.leadId, contactId: opts.contactId };
  const known = !!(opts.leadId || opts.contactId);
  const [lead, customer, tasks, commitments, quotes, visitsJobs, brain, timeline, factsOnRecord] = known
    ? await Promise.all([
        opts.leadId ? readLead(opts.leadId) : null,
        opts.contactId ? readCustomer(opts.contactId) : null,
        readOpenTasks(scope),
        readCommitments(scope),
        readQuotes(scope),
        readVisitsAndJobs(scope),
        opts.leadId ? readBrainOutcome(opts.leadId) : null,
        readTimeline(scope, 15),
        readFacts(scope),
      ])
    : [null, null, [], [], [], { siteVisits: [], jobs: [] }, null, [], []];

  const candidates = opts.identity.candidates.slice(0, 5).map((c) => ({
    key: c.leadId ? `lead:${c.leadId}` : `customer:${c.contactId}`,
    label: c.label,
    evidence: c.signals.map((s) => s.detail),
    score: c.score,
  }));

  const pack = {
    now: { iso: now.toISOString(), local: now.toLocaleString("en-NZ", { timeZone: TZ, dateStyle: "full", timeStyle: "short" }), timeZone: TZ },
    business: { name: "Get Secure", what: "New Zealand (Auckland) security installer: CCTV, alarms, access control, intercoms.", staff: opts.staffNames },
    source: {
      type: input.sourceType,
      id: input.sourceId,
      origin: originOf(input),
      direction: input.direction,
      at: input.at.toISOString(),
      title: input.title,
      from: input.from,
      form: input.form ?? null,
      text: input.text.slice(0, 12000),
      transcript: input.utterances.length
        ? { getSecureSpeakerGuess: gs, turns: input.utterances.slice(0, 400).map((u) => ({ speaker: u.speaker, at: u.at, text: u.text })) }
        : null,
    },
    earlierInThread: input.context,
    identity: {
      status: opts.identity.status,
      decidedBy: "the CRM's identity rules (phone, email, thread, appointment, quote number; never a name alone)",
      reason: opts.identity.reason,
      candidates,
    },
    crm: known
      ? { lead, customer, openTasks: tasks, outstandingCommitments: commitments, quotes, ...visitsJobs, latestBusinessBrainRun: brain, factsOnRecord, recentTimeline: timeline }
      : null,
  };

  const refs = {
    source: { type: input.sourceType, id: input.sourceId },
    leadId: opts.leadId,
    contactId: opts.contactId,
    candidateKeys: candidates.map((c) => c.key),
    earlierMessages: input.context.length,
    openTaskIds: (tasks as { id: string }[]).map((t) => t.id),
    commitmentIds: (commitments as { id: string }[]).map((c) => c.id),
    quoteIds: (quotes as { id: string }[]).map((q) => q.id),
    brainRunAt: brain?.ranAt ?? null,
    timelineItems: (timeline as unknown[]).length,
  };
  return { pack, refs };
}

const SYSTEM = `You are Hermes, acting as the Lead + Conversation Inspector inside Get Secure's CRM. Get Secure is an Auckland security installer (CCTV, alarms, access control, intercoms); Chris runs it.

For the one email or conversation in the context pack, work out what it means in context, as an experienced person in the business would, and recommend the single best next step. Use the whole context: where it came from (a website form on the CCTV landing page is a sales enquiry even if nobody writes "please quote"), the thread, the CRM record, open tasks, commitments, quotes and history. Do not rely on keywords.

How the CRM uses your answer:
- You recommend; the CRM's validator applies hard rules you cannot override, and the Business Brain is the authority on CCTV design, products and pricing. Chris approves anything that reaches a customer.
- Never invent prices, products, discounts, dates or commitments. A reply draft must not contain a price, a discount, or a promised date or time; say that a quote or a visit will follow instead.
- Facts: only what the source itself says (or the form fields). Quote the exact words as evidence. Do not restate what the CRM already holds as a new fact.
- Missing information: list only what genuinely blocks progress (a quote, a visit, a booking). A blank CRM field is not a reason to ask. For residential CCTV the Business Brain needs: home or business, how many cameras (or which areas), single or double storey, and for an upgrade the existing cabling. Address, budget, phone and app viewing do not block a quote.
- Commercial CCTV always needs a site visit first. A customer asking for a visit gets one proposed.
- Commitments: anything Get Secure (owner "get_secure") or the customer (owner "customer") said they would do, with the time words used ("tonight", "tomorrow", "Friday").
- Identity is decided by the CRM, never by a name alone. You may say which candidate you think it is, or "new".
- recommended_action is one of: RUN_BUSINESS_BRAIN, PREPARE_QUOTE (the Brain runs and prepares the quote and reply for Chris), ASK_CUSTOMER (only the blocking questions), PROPOSE_SITE_VISIT, DRAFT_REPLY (a reply for Chris to approve), CREATE_INTERNAL_TASK, FOLLOW_UP, WAITING_ON_CUSTOMER (the customer said they will send or do something next), NEEDS_REVIEW (you are unsure or it needs Chris), NO_ACTION (genuinely nothing to do: spam, a thank-you, a notification). A real enquiry is never NO_ACTION.
- run_business_brain: true when the Brain should design/price from what is known.
- reason: one or two plain sentences a person can check. No hidden reasoning, no essays.
- confidence: 0 to 1, honest.

During this inspection do not call any CRM tool that changes anything; reading is fine. Reply with ONLY one JSON object matching the schema below. No prose, no code fence.`;

export function buildMessages(pack: HermesContextPack): HermesMessage[] {
  return [
    { role: "system", content: `${SYSTEM}\n\nContract version: ${HERMES_INSPECTOR_VERSION}\nJSON Schema:\n${JSON.stringify(hermesResultJsonSchema())}` },
    { role: "user", content: `Context pack:\n${JSON.stringify(pack)}` },
  ];
}

/** When the first reply could not be used: one more chance, with the problem stated. */
export function repairMessages(messages: HermesMessage[], badReply: string, problem: string): HermesMessage[] {
  return [
    ...messages,
    { role: "assistant", content: badReply.slice(0, 8000) },
    { role: "user", content: `That reply could not be used: ${problem}. Reply again with ONLY the JSON object that matches the schema.` },
  ];
}
