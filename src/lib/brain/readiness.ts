/**
 * Is this assessment a real quote yet? One checklist of everything Get Secure must have entered
 * and approved for the price to stand: approved current supplier prices, an approved recording
 * profile with design bitrates, storage sized from it, an approved exact installation package with
 * every value, the markup Chris decided, the tier and products approved, and the sizing rules the
 * storage relies on. Each item says where to fix it. Nothing here fills a value in.
 */
import { TRUSTED_STATUSES, type UpgradePlan, type CameraDesign, type Costing, type KnowledgeStatus, type LabourResult, type Policies, type Product, type StorageResult } from "./types";

export type ReadinessItem = { key: string; label: string; ok: boolean; detail: string; fix: string | null };
export type Readiness = { ready: boolean; items: ReadinessItem[] };

const trusted = (s: KnowledgeStatus | null | undefined) => !!s && TRUSTED_STATUSES.includes(s);
const name = (p: { manufacturer: string; model: string }) => `${p.manufacturer} ${p.model}`;

/** Rules whose values decide this quote's storage, freshness or accessories. */
const SIZING_RULES = ["storageHeadroomPct", "hddUsableFraction", "priceAgingDays", "priceStaleDays", "junctionBoxSurfaces", "gstRate"] as const;

export function quoteReadiness(x: {
  cameras: Product[];
  nvr: Product | null;
  drive: Product | null;
  profile: { name: string; status: KnowledgeStatus } | null;
  designs: CameraDesign[];
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

  const noDesign = x.designs.filter((d) => d.designBitrateMbps == null || !d.bitrateApproved).map((d) => `${d.model} (${d.resolutionMp} MP)`);
  items.push({
    key: "recording_profile",
    label: "Approved recording profile with a design bitrate for each camera",
    ok: !!x.profile && trusted(x.profile.status) && !noDesign.length && x.designs.length > 0,
    detail: !x.profile
      ? "No recording profile for this job."
      : [
          `${x.profile.name}: ${trusted(x.profile.status) ? "approved" : x.profile.status.replace(/_/g, " ")}`,
          ...(noDesign.length ? [`no approved design bitrate for ${[...new Set(noDesign)].join(", ")}`] : x.designs.map((d) => `${d.model} ${d.designBitrateMbps} Mbps`)),
        ].join("; "),
    fix: "Settings → Business Brain → Recording profiles: codec, frame rate, a design bitrate rule covering these cameras, then approve.",
  });

  items.push({
    key: "storage",
    label: "Storage sized from the design bitrate and meeting the retention target",
    ok: x.storage.status === "meets_target" && !!x.storage.drives,
    detail:
      x.storage.status === "cannot_calculate"
        ? "Cannot be sized until the recording profile has approved design bitrates."
        : `${x.storage.requiredGb != null ? `needs ${(x.storage.requiredGb / 1000).toFixed(2)} TB` : ""}${x.storage.drives ? `; selected ${x.storage.drives.count} × ${name(x.storage.drives.product)}` : "; no drive with an approved price is large enough"}${x.storage.expectedRetentionDays != null ? ` (about ${x.storage.expectedRetentionDays} days)` : ""}; ${x.storage.status.replace(/_/g, " ")}`,
    fix: x.storage.drives ? null : "Price and approve a surveillance drive of the needed capacity (Supplier pricing → Refresh one product).",
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

  const rules = SIZING_RULES.filter((k) => x.policies[k] && !trusted(x.policies[k].status));
  items.push({
    key: "rules",
    label: "Rules this quote relies on are approved",
    ok: !rules.length,
    detail: rules.length ? rules.map((k) => `${k} = ${JSON.stringify(x.policies[k].value)} (${x.policies[k].status.replace(/_/g, " ")})`).join("; ") : "Storage headroom, usable drive capacity, price freshness, junction-box and GST rules are approved.",
    fix: rules.length ? "Settings → Business Brain → Rules: confirm or change each, then approve." : null,
  });

  return { ready: c.complete && items.every((i) => i.ok), items };
}
