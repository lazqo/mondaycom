/**
 * Jev, in shadow mode. For each inspected email or conversation Jev gives a bounded
 * classification (intent, type, urgency, quote readiness, call vs quote vs ask, objection type,
 * site-visit probability, confidence). It is stored next to what the deterministic rules said and,
 * later, what Chris actually decided, so the two can be compared before Jev is trusted with
 * anything.
 *
 * Jev never drives an action, never designs or prices CCTV, never picks a drive or a supplier, and
 * never sends anything. It is off unless JEV_SHADOW=on and an Anthropic API key is set.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { jevObservations } from "@/db/schema";
import type { InspectorInput, PlannedAction, Understanding } from "./types";

export const jevSchema = z.object({
  intent: z.enum(["new_enquiry", "quote_request", "site_visit_request", "booking_request", "question", "quote_change", "acceptance", "objection", "service_issue", "follow_up", "information", "not_relevant"]),
  conversation_type: z.enum(["new_lead", "existing_customer", "existing_job", "supplier", "spam_or_marketing", "other"]),
  urgency: z.enum(["low", "normal", "high", "urgent"]),
  quote_readiness: z.enum(["ready", "needs_info", "needs_site_visit", "not_applicable"]),
  next_move: z.enum(["quote", "ask", "call", "site_visit", "none"]),
  objection_type: z.enum(["none", "price", "timing", "competitor", "undecided", "scope", "other"]),
  site_visit_probability: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type JevOutput = z.infer<typeof jevSchema>;

export interface JevClassifier {
  readonly model: string;
  classify(input: InspectorInput): Promise<JevOutput>;
}

const SYSTEM = `You are Jev, a shadow classifier for Get Secure, a New Zealand security installer (CCTV, alarms, access control, intercoms). You read one customer email or one recorded conversation and classify it. Your answer is only compared with the business's own rules; it never triggers an action.

Classify only what the text supports:
- intent: the customer's main purpose.
- conversation_type: new lead, existing customer, existing job (a fault or follow-up on installed work), supplier, spam/marketing, or other.
- urgency: from the customer's own words (a break-in or "ASAP" is urgent; "no rush" is low).
- quote_readiness: "ready" if a residential CCTV quote could be prepared from what is known, "needs_info" if something essential is missing, "needs_site_visit" if the job should be seen first (commercial CCTV always does), otherwise "not_applicable".
- next_move: the single best next step for Get Secure.
- objection_type: the customer's main hesitation, or "none".
- site_visit_probability: how likely a site visit is the right next step.
- confidence: how sure you are overall.
- reason: one short sentence.

Do not design systems, choose products or prices, or suggest discounts.`;

export class AnthropicJev implements JevClassifier {
  private client: Anthropic;
  constructor(
    readonly model: string,
    apiKey?: string,
  ) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async classify(input: InspectorInput): Promise<JevOutput> {
    const body =
      input.sourceType === "recording"
        ? `Recorded conversation "${input.title}" on ${input.at.toISOString()}:\n\n${input.text.slice(0, 30000)}`
        : `${input.direction === "outbound" ? "Email sent by Get Secure" : `Email from ${input.from.name ?? ""} <${input.from.email ?? ""}>`} on ${input.at.toISOString()}\nSubject: ${input.title}\n\n${input.text.slice(0, 12000)}${input.context.length ? `\n\nEarlier in the thread:\n${input.context.map((c) => `--- ${c.from}, ${c.at} ---\n${c.text}`).join("\n")}` : ""}`;
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 2048,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: body }],
      output_config: { format: betaZodOutputFormat(jevSchema), effort: "low" },
    });
    if (response.stop_reason === "refusal") throw new Error(`Jev declined (${response.stop_details?.category ?? "unspecified"})`);
    if (!response.parsed_output) throw new Error("Jev returned no classification");
    return response.parsed_output;
  }
}

let override: JevClassifier | null | undefined;
/** For tests: use a fake Jev (or null to switch it off). */
export function setJev(j: JevClassifier | null | undefined) {
  override = j;
}

export function getJev(): JevClassifier | null {
  if (override !== undefined) return override;
  if (process.env.JEV_SHADOW !== "on" || !process.env.ANTHROPIC_API_KEY) return null;
  return new AnthropicJev(process.env.JEV_MODEL || "claude-opus-5-5", process.env.ANTHROPIC_API_KEY);
}

/** The deterministic rules' answer to the same questions, for comparison. */
export function deterministicView(u: Understanding, actions: PlannedAction[]): Omit<JevOutput, "conversation_type" | "confidence" | "reason"> & { actions: string[] } {
  const t = actions.map((a) => a.type);
  const nextMove = t.includes("PROPOSE_SITE_VISIT") ? "site_visit" : t.includes("PREPARE_QUOTE") || t.includes("PREPARE_REVISED_QUOTE") ? "quote" : t.includes("CALL_CUSTOMER") ? "call" : t.includes("DRAFT_EMAIL") ? "ask" : "none";
  return {
    intent: u.primaryIntent,
    urgency: u.urgency,
    quote_readiness: t.includes("PROPOSE_SITE_VISIT") ? "needs_site_visit" : t.includes("PREPARE_QUOTE") ? "ready" : u.missing.some((m) => m.blocking) ? "needs_info" : "not_applicable",
    next_move: nextMove,
    objection_type: u.objections[0]?.kind ?? "none",
    site_visit_probability: t.includes("PROPOSE_SITE_VISIT") ? 1 : 0,
    actions: t,
  };
}

/** Run Jev beside the rules and store both. Never throws; never changes anything else. */
export async function shadow(inspectionId: string, input: InspectorInput, u: Understanding, actions: PlannedAction[]): Promise<void> {
  const jev = getJev();
  if (!jev) return;
  const started = Date.now();
  const deterministic = deterministicView(u, actions);
  try {
    const output = await jev.classify(input);
    await db.insert(jevObservations).values({ inspectionId, model: jev.model, output, deterministic, durationMs: Date.now() - started });
  } catch (err) {
    await db.insert(jevObservations).values({ inspectionId, model: jev.model, output: null, deterministic, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started }).catch(() => {});
  }
}

/** Store what Chris actually decided, next to Jev's and the rules' answers. */
export async function recordDecision(inspectionId: string, patch: Record<string, unknown>): Promise<void> {
  const rows = await db.query.jevObservations.findMany({ where: eq(jevObservations.inspectionId, inspectionId) });
  for (const r of rows) await db.update(jevObservations).set({ chrisDecision: { ...(r.chrisDecision ?? {}), ...patch }, decidedAt: new Date() }).where(eq(jevObservations.id, r.id));
}
