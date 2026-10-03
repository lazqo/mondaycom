/**
 * The customer-facing content of a proposal, built from an approved quote. Everything printed comes
 * from the quote Chris approved (its lines, quantities, prices, notes) plus each product's
 * customer-facing catalogue content. Only named customer fields are read: supplier, SKU, cost,
 * markup, margin, labour hours and rate, and allowances never reach this data, so they cannot reach
 * the PDF.
 *
 * Built to be reused for alarms, access control and intercom later: the presentation is driven by
 * the service kind, product cards and generic note sections, not by CCTV-specific fields.
 */
import { computeTotals } from "@/lib/quotes";
import type { QuoteLineItem } from "@/db/schema";
import type { ProposalSettings } from "./settings";

export const RECORDING_DURATION_NOTE = "Recording duration depends on camera settings, recording configuration and scene activity.";

/** Categories shown as product cards unless the product says otherwise. Small accessories and consumables are lines only. */
export const CARD_CATEGORIES = ["camera", "nvr", "hdd", "kit", "poe_switch", "alarm_panel", "keypad", "intercom", "access_controller"];

export type ProposalKind = "cctv";

export type ProposalProduct = {
  productId: string;
  category: string;
  name: string;
  /** Manufacturer and model, printed small. */
  model: string;
  quantity: number;
  description: string | null;
  highlights: string[];
  featureNotes: string | null;
  imageId: string | null;
};

export type ProposalData = {
  kind: ProposalKind;
  heading: string;
  quoteNumber: string;
  quoteTitle: string;
  /** ISO date the proposal is dated (the approval date). */
  date: string;
  validUntil: string | null;
  customer: { name: string; site: string | null };
  summary: string;
  coverage: string[];
  products: ProposalProduct[];
  /** Every quote line, with the product's friendly name where there is one. */
  items: { description: string; quantity: number }[];
  installation: { description: string; includes: string[] } | null;
  totals: { subtotalExGst: number; gst: number; totalIncGst: number; gstRatePct: number };
  notes: { heading: string; items: string[] }[];
  warranty: string[];
  nextSteps: string | null;
  company: { name: string; legalName: string; phone: string; email: string; website: string; address: string; gstNumber: string };
  /** Set on a preview of a quote that is not approved yet. */
  draft: boolean;
};

/** What the builder may read from a product: its identity and customer-facing content only. */
export type ProposalProductSource = {
  id: string;
  manufacturer: string;
  model: string;
  category: string;
  specs?: Record<string, unknown> | null;
  quoteDisplayName: string | null;
  quoteDescription: string | null;
  quoteHighlights: string[];
  quoteFeatureNotes: string | null;
  quoteImageId: string | null;
  quoteShowCard: boolean | null;
};

/** What the builder may read from a snapshot line: which product a customer line is, nothing else. */
type SnapshotLine = { customerDescription?: string; productId?: string | null; kind?: string; internalOnly?: boolean };

export type ProposalQuoteSource = {
  number: number;
  title: string;
  lineItems: QuoteLineItem[];
  taxRate: string | number;
  subtotal: string | number;
  total: string | number;
  notes: string | null;
  approvedAt: Date | string | null;
  internalCosting: unknown;
  /** This quote's validity: null/undefined = the standard, 0 = none, n = n days. */
  validityDays?: number | null;
};

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean);

/** Turn the quote's notes ("Assumptions:\n- …\n\nExclusions:\n- …") into headed sections. */
export function noteSections(notes: string | null): { heading: string; items: string[] }[] {
  const out: { heading: string; items: string[] }[] = [];
  let cur: { heading: string; items: string[] } | null = null;
  for (const raw of (notes ?? "").split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    const head = /^([A-Z][^:]{1,40}):$/.exec(t);
    if (head) {
      cur = { heading: head[1], items: [] };
      out.push(cur);
    } else if (/^[-•*]\s+/.test(t) && cur) {
      cur.items.push(t.replace(/^[-•*]\s+/, ""));
    } else {
      cur = null;
      const other = out.find((s) => s.heading === "Please note") ?? (out.push({ heading: "Please note", items: [] }), out[out.length - 1]);
      other.items.push(t);
    }
  }
  return out.filter((s) => s.items.length);
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
const listText = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function buildProposalData(input: {
  quote: ProposalQuoteSource;
  products: ProposalProductSource[];
  customer: { name: string; site: string | null };
  coverage?: string[];
  settings: ProposalSettings;
  kind?: ProposalKind;
  draft?: boolean;
  now?: Date;
}): ProposalData {
  const { quote, settings } = input;
  const byId = new Map(input.products.map((p) => [p.id, p]));
  const snapLines = (((input.quote.internalCosting as { lines?: SnapshotLine[] } | null)?.lines ?? []) as SnapshotLine[]).filter((l) => !l.internalOnly);

  // Match each approved quote line to the snapshot line it came from (by its customer description),
  // to know which product it is. A line Chris added or reworded simply has no product.
  const pool = [...snapLines];
  const matched = quote.lineItems.map((li) => {
    const i = pool.findIndex((s) => s.customerDescription === li.description);
    const s = i >= 0 ? pool.splice(i, 1)[0] : null;
    const product = s?.productId ? (byId.get(s.productId) ?? null) : null;
    return { li, product, kind: s?.kind ?? null };
  });

  const friendly = (p: ProposalProductSource) => p.quoteDisplayName?.trim() || `${p.manufacturer} ${p.model}`;
  const products: ProposalProduct[] = [];
  for (const { li, product: p } of matched) {
    if (!p) continue;
    const card = p.quoteShowCard ?? CARD_CATEGORIES.includes(p.category);
    if (!card) continue;
    const existing = products.find((x) => x.productId === p.id);
    if (existing) {
      existing.quantity += Number(li.quantity);
      continue;
    }
    products.push({
      productId: p.id,
      category: p.category,
      name: friendly(p),
      model: `${p.manufacturer} ${p.model}`,
      quantity: Number(li.quantity),
      description: p.quoteDescription?.trim() || null,
      highlights: p.quoteHighlights.map((h) => h.trim()).filter(Boolean).slice(0, 4),
      featureNotes: p.quoteFeatureNotes?.trim() || null,
      imageId: p.quoteImageId,
    });
  }

  const items = matched.map(({ li, product }) => ({ description: product?.quoteDisplayName?.trim() || li.description, quantity: Number(li.quantity) }));

  const install = matched.find((m) => m.kind === "labour" || /^installation/i.test(m.li.description));
  const installation = install ? { description: install.li.description, includes: lines(settings.installationIncludes) } : null;

  // Totals from the approved lines; they must agree with what was approved.
  const t = computeTotals(quote.lineItems, Number(quote.taxRate));
  if (Math.abs(Number(t.total) - Number(quote.total)) > 0.005) throw new Error("The quote's total does not match its lines. Re-approve the quote.");
  const totals = { subtotalExGst: Number(t.subtotal), gst: Number(t.tax), totalIncGst: Number(t.total), gstRatePct: Number(quote.taxRate) };

  const notes = noteSections(quote.notes);
  const kind = input.kind ?? "cctv";
  if (kind === "cctv" && !(quote.notes ?? "").toLowerCase().includes("recording duration depends")) notes.push({ heading: "Recording", items: [RECORDING_DURATION_NOTE] });

  // A plain summary, true to the approved lines.
  const count = (cat: string) => products.filter((p) => p.category === cat).reduce((n, p) => n + p.quantity, 0);
  const cams = count("camera");
  const nvr = products.find((p) => p.category === "nvr");
  const hdd = products.find((p) => p.category === "hdd");
  const tb = Number((byId.get(hdd?.productId ?? "")?.specs as { capacityTb?: number } | undefined)?.capacityTb ?? 0);
  const coverage = (input.coverage ?? []).map((a) => a.trim()).filter(Boolean);
  const parts = [
    cams ? `a ${cams}-camera security system` : "the security system below",
    coverage.length ? `covering the ${listText(coverage.map((c) => c.toLowerCase()))}` : null,
    nvr ? `recording to a ${nvr.name}${tb ? ` with ${tb} TB of storage` : ""}` : null,
  ].filter(Boolean);
  const summary = `We recommend ${parts.join(", ")}. ${installation ? "It is professionally installed, cabled and commissioned by Get Secure." : ""}`.trim();

  const date = new Date(quote.approvedAt ?? input.now ?? new Date());
  const days = quote.validityDays != null ? quote.validityDays : settings.validityDays;
  const validUntil = days && days > 0 ? new Date(date.getTime() + days * 86400000).toISOString() : null;

  return {
    kind,
    heading: kind === "cctv" ? "Security Camera Proposal" : "Security Proposal",
    quoteNumber: `Q-${quote.number}`,
    quoteTitle: quote.title,
    date: date.toISOString(),
    validUntil,
    customer: input.customer,
    summary,
    coverage,
    products,
    items,
    installation,
    totals,
    notes,
    warranty: lines(settings.warranty).map(sentence),
    nextSteps: settings.nextSteps.trim() || null,
    company: { name: settings.companyName, legalName: settings.legalName, phone: settings.phone, email: settings.email, website: settings.website, address: settings.address, gstNumber: settings.gstNumber },
    draft: !!input.draft,
  };
}
