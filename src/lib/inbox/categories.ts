/**
 * The inbox's categories and tabs, and the shape of a triaged email: shared by the server (which
 * works the triage out) and the client components that show it. No node-only imports here.
 */
export type EmailCategory = "customer" | "work" | "supplier" | "provider" | "accounting" | "marketing" | "internal" | "other" | "reading";

export const CATEGORY_META: Record<EmailCategory, { label: string; bg: string; text: string; hint: string }> = {
  customer: { label: "Customer", bg: "bg-[#00c875]", text: "text-white", hint: "a customer or prospect" },
  work: { label: "Existing work", bg: "bg-[#579bfc]", text: "text-white", hint: "an existing site, job or service issue" },
  supplier: { label: "Supplier", bg: "bg-[#a25ddc]", text: "text-white", hint: "a supplier or vendor" },
  provider: { label: "Provider", bg: "bg-[#7f5f01]", text: "text-white", hint: "a service or monitoring provider" },
  accounting: { label: "Accounting", bg: "bg-[#ff9900]", text: "text-white", hint: "a statement, invoice, remittance or payment" },
  marketing: { label: "Marketing", bg: "bg-gray-300", text: "text-gray-800", hint: "newsletters, promotions, bulk mail" },
  internal: { label: "Internal", bg: "bg-gray-500", text: "text-white", hint: "internal or admin mail" },
  other: { label: "Other", bg: "bg-gray-200", text: "text-gray-700", hint: "auto-replies, bounces, the rest" },
  reading: { label: "Reading", bg: "bg-gray-200", text: "text-gray-700", hint: "with Hermes now" },
};

/** The inbox's tabs: every category, plus what needs Chris. */
export type InboxTab = "all" | "attention" | EmailCategory;
export const INBOX_TABS: { key: InboxTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs attention" },
  { key: "customer", label: "Customers" },
  { key: "work", label: "Existing work" },
  { key: "supplier", label: "Suppliers" },
  { key: "provider", label: "Providers" },
  { key: "accounting", label: "Accounting" },
  { key: "marketing", label: "Marketing" },
  { key: "internal", label: "Internal" },
  { key: "other", label: "Other" },
];
/** The old filter keys still land somewhere sensible. */
export const LEGACY_TABS: Record<string, InboxTab> = { needs_review: "attention", error: "attention", lead: "customer", existing: "work", not_lead: "all" };


export type Triage = {
  category: EmailCategory;
  /** One line: the state of play. */
  headline: string;
  /** Why, or what Hermes did, in a few words. */
  detail: string | null;
  /** attention: waits on Chris; done: Hermes did something; quiet: nothing to do; info: in progress. */
  tone: "attention" | "done" | "quiet" | "info";
  /** The classic review: lead or not, decided from the row. */
  needsReview: boolean;
  /** A proposal, reply or quote waiting; direct when accepting needs no choice (no time slots). */
  decision: { actionId: string; type: string; label: string; direct: boolean } | null;
  /** A question Hermes asked: answered on Home. */
  question: string | null;
};

/** Which tab a triaged email belongs to (besides "all"). */
export function inTab(t: Triage, tab: InboxTab): boolean {
  if (tab === "all") return true;
  if (tab === "attention") return t.tone === "attention";
  return t.category === tab;
}
