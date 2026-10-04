/**
 * Where an enquiry stands in the CRM, and which commitments that downstream record proves were
 * kept. Pure: the CRM state is gathered in sources.ts.
 *
 * A commitment is only treated as kept when a later CRM event clearly proves that specific
 * commitment happened: "book the installation visit" by the installation job having been done
 * after it was said; "come out for a site visit" or "the customer will be available" by the visit
 * (or the job) having taken place; "go ahead with the quote" by the quote being accepted or a job
 * created; "send the quote" by a quote being sent. Anything else (send the camera plan, send photos,
 * pay) is never inferred: it stays outstanding until someone marks it done.
 */

export type LifecycleEvent = {
  kind: "job_done" | "job_invoiced" | "job_attended" | "job_created" | "job_scheduled" | "visit_held" | "quote_accepted" | "quote_sent";
  /** ISO time it happened. */
  at: string;
  /** How Chris reads it: "J-1008 completed on 12 Aug 2026". */
  label: string;
};

export type OutstandingCommitment = {
  id: string;
  owner: string;
  action: string;
  actionKey: string;
  dueText: string | null;
  /** When it was said (the conversation's time), ISO; null when unknown. */
  at: string | null;
};

export type Lifecycle = {
  /** Downstream evidence that the matter has moved on (job done or scheduled, visit held, quote accepted with work). */
  progressed: string[];
  /** Everything downstream the CRM can show, with when it happened (for commitments). */
  events: LifecycleEvent[];
  /** Open tasks on this lead, customer or job: already somebody's to-do. */
  openTasks: string[];
  /** Commitments still outstanding in the CRM for this lead or customer. */
  outstanding: OutstandingCommitment[];
  /** Commitments from this very source that the CRM shows as done or cancelled, as "owner:action_key" (how they are stored). */
  settledFromSource: string[];
};

/** The job (or visit) actually took place. */
const OCCURRED: LifecycleEvent["kind"][] = ["job_done", "job_invoiced", "job_attended", "visit_held"];
const INSTALLED: LifecycleEvent["kind"][] = ["job_done", "job_invoiced", "job_attended"];

const INSTALL = /\b(install|installation|installing|fit|fitting|the job|the work)\b/;
const ARRANGE_OR_ATTEND = /\b(book|booking|schedule|arrange|organi[sz]e|attend|come|pop|be there|start|do)\b/;
const VISIT = /\b(site visit|visit|come (out|round|over|back|by)|pop (out|round|over|by)|be there|attend|look at (the )?(site|property|house|place))\b/;
const AVAILABLE = /\b(available|be (home|there|in|around|on site)|let (us|you|them|him|her|chris|the [a-z]+) in|give (us |you |them )?access|meet (us|you|them|chris))\b/;
const PROCEED = /\b(go ahead|proceed|accept|approve|sign (off|it|the)|confirm (the )?(quote|order|job|booking|install)|book (it|us|the job|the work|the install(ation)?) in)\b/;
const SEND_QUOTE = /\b(send|email|get)\b.*\bquote\b/;

/**
 * The later CRM event that proves this commitment was kept, or null. Requires knowing when it was
 * said, and only counts events after that.
 */
export function satisfiedBy(c: { owner: string; action: string; actionKey: string; at: string | null }, events: LifecycleEvent[]): LifecycleEvent | null {
  if (!c.at) return null;
  const said = c.at;
  const after = (kinds: LifecycleEvent["kind"][]) => events.filter((e) => kinds.includes(e.kind) && e.at >= said).sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
  const text = c.action.toLowerCase();
  // Booking / attending the installation: the installation took place.
  if (INSTALL.test(text) && (ARRANGE_OR_ATTEND.test(text) || c.actionKey === "visit")) return after(INSTALLED);
  // A visit (booking it, coming out, attending): the visit or the job took place.
  if (c.actionKey === "visit" || VISIT.test(text)) return after(OCCURRED);
  // The customer will be available / let us in: the visit or the job took place.
  if (c.owner === "customer" && AVAILABLE.test(text)) return after(OCCURRED);
  // Going ahead: the quote was accepted or a job was created.
  if (PROCEED.test(text)) return after(["quote_accepted", "job_created"]);
  // Sending the quote: a quote was sent.
  if (c.actionKey === "send_quote" && SEND_QUOTE.test(text)) return after(["quote_sent", "quote_accepted"]);
  return null;
}
