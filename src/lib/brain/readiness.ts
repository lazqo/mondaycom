/**
 * Is this assessment a real quote yet? One checklist of everything Get Secure must have entered
 * and approved for the price to stand: approved current supplier prices, the HDD (from the kit,
 * Chris's choice or the fallback), the recorder passing its checks, an approved exact installation
 * package with every value, the markup Chris decided, the tier and products approved, and the rules
 * the quote relies on. Each item says where to fix it. Nothing here fills a value in.
 */
import { TRUSTED_STATUSES, type CctvKit, type UpgradePlan, type Costing, type KnowledgeStatus, type LabourResult, type NvrEvaluation, type Policies, type Product, type StorageResult } from "./types";

export type ReadinessItem = { key: string; label: string; ok: boolean; detail: string; fix: string | null };
export type Readiness = { ready: boolean; items: ReadinessItem[] };

const trusted = (s: KnowledgeStatus | null | undefined) => !!s && TRUSTED_STATUSES.includes(s);
const name = (p: { manufacturer: string; model: string }) => `${p.manufacturer} ${p.model}`;

/** Rules whose values decide this quote's freshness, accessories or GST. */
const QUOTE_RULES = ["priceAgingDays", "priceStaleDays", "junctionBoxSurfaces", "gstRate"] as const;

export function quoteReadiness(x: {
  cameras: Product[];
  nvr: Product | null;
  drive: Product | null;
  nvrEvaluation: NvrEvaluation | null;
  kit: CctvKit | null;
  storage: StorageResult;
  labour: LabourResult;
  costing: Costing;
  policies: Policies;
  commercial: boolean;
  upgrade?: UpgradePlan | null;
}): Readiness {
  const items: ReadinessItem[] = [];
  const c = x.costing;

  const hw = c.lines.filter((l) => l.kind === "hardware");
  const unpricedHw = c.unpriced.filter((u) => !/^RES_|labour|installation|package|material/i.test(u));
  const stale = c.refreshRequired.map((r) => `${r.model} (${r.freshness})`);
  items.push({
    key: "supplier_prices",
    label: "Approved, current supplier price for every hardware line",
    ok: hw.length > 0 && !unpricedHw.length && !stale.length && hw.every((l) => l.priced),
    detail: [
      ...unpricedHw,
      ...stale.map((s) => `Refresh: ${s}`),
      ...(unpricedHw.length || stale.length ? [] : hw.map((l) => `${l.model ?? l.customerDescription}: ${l.supplier ?? "?"} ${l.supplierSku ?? ""} (${l.freshness ?? "?"})`)),
    ].join("; ") || "No hardware selected.",
    fix: "Settings → Business Brain → Supplier pricing: refresh, then approve the price.",
  });

  const st = x.storage;
  const d = st.drives?.product;
  const from = st.selection === "override" ? "chosen by Chris" : st.selection === "kit" ? "kit default" : st.selection === "fallback" ? "fallback by camera count" : "not selected";
  items.push({
    key: "storage",
    label: "HDD selected",
    ok: !!d,
    detail: d ? `${st.installedTb} TB ${name(d)} (${from})` : st.notes.join(" "),
    fix: d ? null : "Choose the HDD on the assessment, or set the kit's default HDD (Settings → Business Brain → Kits).",
  });

  const ev = x.nvrEvaluation;
  items.push({
    key: "recorder",
    label: "Recorder passes its checks",
    ok: !!ev && ev.pass,
    detail: !ev
      ? "No recorder selected."
      : ev.pass
        ? `${name(ev.product)}: ${ev.checks.filter((c) => c.unverified).length ? `passes; not verifiable from specifications: ${ev.checks.filter((c) => c.unverified).map((c) => c.name).join(", ")}` : "passes every check"}`
        : `${name(ev.product)} fails: ${ev.checks.filter((c) => !c.pass).map((c) => `${c.name} (${c.detail})`).join("; ")}`,
    fix: ev && !ev.pass ? "Choose another recorder (fix the kit) or change the HDD." : null,
  });

  items.push({
    key: "kit",
    label: "Approved kit",
    ok: true,
    detail: x.kit ? `${x.kit.name}${x.kit.key ? ` (${x.kit.key})` : ""}` : "No approved kit for this camera count and tier: products chosen from the catalogue. Add a kit to fix the configuration and its default HDD.",
    fix: null,
  });

  if (x.upgrade) {
    const u = x.upgrade;
    items.push({
      key: "existing_system",
      label: "Existing system assessed for the upgrade",
      ok: !u.unresolved && !u.decisions.length,
      detail: [u.summary, ...u.decisions.map((d) => `Decision needed: ${d}`)].join(" "),
      fix: u.unresolved || u.decisions.length ? "On the assessment: existing cable type and condition, camera positions (and the coax decision)." : null,
    });
  }

  const pkg = x.labour.package;
  items.push({
    key: "installation_package",
    label: "Exact installation package, every value entered, approved",
    ok: !!pkg && !x.labour.customInstallation && !(x.labour.missing ?? []).length && trusted(pkg.status),
    detail: !pkg
      ? x.labour.customInstallation
        ? "No exact package for this camera count/storey: custom installation."
        : "No installation package."
      : [`${pkg.key ?? pkg.name}: ${trusted(pkg.status) ? "approved" : pkg.status.replace(/_/g, " ")}`, ...(x.labour.missing ?? [])].join("; "),
    fix: "Settings → Business Brain → Installation & materials: labour hours, material cost, complexity allowance (0 if none), customer sell allowance, then approve.",
  });

  const markupOk = c.markupSource === "override" || trusted(x.policies.suggestedMarkupPct.status);
  items.push({
    key: "markup",
    label: "Hardware markup decided by Chris",
    ok: markupOk,
    detail: c.markupSource === "override" ? `${c.markupPct}% entered for this quote.` : `${c.markupPct}% is the ${trusted(x.policies.suggestedMarkupPct.status) ? "approved" : "provisional"} suggestion.`,
    fix: markupOk ? null : "Enter the exact markup for this quote (Markup override on the assessment), or approve the markup rule.",
  });

  if (!x.commercial) {
    const tierPending = x.cameras.filter((p) => p.tierStatus && !trusted(p.tierStatus));
    items.push({
      key: "tier",
      label: "Camera tier approved for this market",
      ok: x.cameras.length > 0 && !tierPending.length,
      detail: tierPending.length ? `${[...new Set(tierPending.map((p) => `${name(p)} (${p.tier ?? "no tier"}, ${String(p.tierStatus).replace(/_/g, " ")})`))].join("; ")}` : `${[...new Set(x.cameras.map((p) => `${name(p)}: ${p.tier ?? "no tier"}`))].join("; ")}`,
      fix: tierPending.length ? "Settings → Business Brain → Products & prices: open the camera, set its tier status to Get Secure approved." : null,
    });
  }

  const products = [...x.cameras, x.nvr, x.drive].filter((p): p is Product => !!p);
  const unapproved = [...new Map(products.filter((p) => !trusted(p.status)).map((p) => [p.id, p])).values()];
  items.push({
    key: "products",
    label: "Products verified or approved",
    ok: !unapproved.length && products.length > 0,
    detail: unapproved.length ? unapproved.map((p) => `${name(p)} (${p.status.replace(/_/g, " ")})`).join("; ") : "Selected products are manufacturer-verified or approved.",
    fix: unapproved.length ? "Settings → Business Brain → Products & prices: review and approve." : null,
  });

  const rules = QUOTE_RULES.filter((k) => x.policies[k] && !trusted(x.policies[k].status));
  items.push({
    key: "rules",
    label: "Rules this quote relies on are approved",
    ok: !rules.length,
    detail: rules.length ? rules.map((k) => `${k} = ${JSON.stringify(x.policies[k].value)} (${x.policies[k].status.replace(/_/g, " ")})`).join("; ") : "Price freshness, junction-box and GST rules are approved.",
    fix: rules.length ? "Settings → Business Brain → Rules: confirm or change each, then approve." : null,
  });

  return { ready: c.complete && items.every((i) => i.ok), items };
}
