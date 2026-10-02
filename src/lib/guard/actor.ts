/**
 * Who is acting, and what they are allowed to do to customers.
 *
 * SYSTEM RULE: no AI agent (Hermes), automation, scheduled task or decision model may contact a
 * customer or commit Get Secure commercially. Only a signed-in person can, and anything the system
 * prepared needs an approver (Chris) first. This is enforced here, in code, at every function
 * that reaches a customer, not left to a prompt.
 *
 * An agent can read, run assessments and create drafts. That is the whole of its reach: there is
 * no send capability to grant it.
 */

export type Actor =
  | { kind: "human"; userId: string; name: string; canApprove: boolean }
  | { kind: "agent"; agent: string }
  | { kind: "system"; process: string };

/** Everything that reaches a customer or binds Get Secure. */
export const CUSTOMER_FACING_ACTIONS = [
  "send_email",
  "send_quote",
  "confirm_site_visit",
  "confirm_installation_date",
  "promise_product",
  "promise_price",
  "accept_or_decline_terms",
  "apply_discount",
  "commercial_commitment",
] as const;
export type CustomerFacingAction = (typeof CUSTOMER_FACING_ACTIONS)[number];

/**
 * What an agent may do. Deliberately has no customer-facing entry; a test asserts that, so adding
 * one breaks the build.
 */
export const AGENT_CAPABILITIES = [
  "read_leads",
  "read_customers",
  "read_timeline",
  "read_catalogue",
  "read_assessments",
  "run_assessment",
  "create_email_draft",
  "create_quote_draft",
  "propose_booking",
  "propose_bom",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailError";
  }
}

export function actorLabel(actor: Actor): string {
  return actor.kind === "human" ? "user" : actor.kind === "agent" ? `agent:${actor.agent}` : `system:${actor.process}`;
}

export function humanFromUser(user: { id: string; name: string; canApprove?: boolean | null }): Actor {
  return { kind: "human", userId: user.id, name: user.name, canApprove: !!user.canApprove };
}

/** Only a signed-in person may reach a customer. Agents, automations and scheduled tasks never can. */
export function assertMayActOnCustomer(actor: Actor, action: CustomerFacingAction): asserts actor is Extract<Actor, { kind: "human" }> {
  if (actor.kind !== "human") {
    throw new GuardrailError(`${actorLabel(actor)} may not ${action.replace(/_/g, " ")}: customer-facing actions need a person, and Chris's approval for anything the system prepared.`);
  }
}

/** Approving something the system prepared: a person with approval rights (Chris). */
export function assertApprover(actor: Actor): asserts actor is Extract<Actor, { kind: "human" }> {
  if (actor.kind !== "human" || !actor.canApprove) {
    throw new GuardrailError(`${actor.kind === "human" ? actor.name : actorLabel(actor)} cannot approve customer-facing actions.`);
  }
}

export function assertAgentMay(actor: Actor, capability: AgentCapability | CustomerFacingAction): void {
  if (actor.kind !== "agent") return;
  if (!(AGENT_CAPABILITIES as readonly string[]).includes(capability)) {
    throw new GuardrailError(`agent:${actor.agent} has no "${capability}" capability.`);
  }
}
