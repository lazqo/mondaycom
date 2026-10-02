/**
 * Recorder selection. A recorder is never chosen on channel count alone: it must also pass
 * incoming bandwidth, PoE (per port and in total), storage, features and, across brands, ONVIF.
 */
import type { CameraProduct, Check, NvrEvaluation, NvrProduct, Policies, Product, PropertyType, Tier } from "./types";
import { TRUSTED_STATUSES } from "./types";
import { chooseDrives } from "./storage";

export function isNvr(p: Product): p is NvrProduct {
  return p.category === "nvr";
}

const norm = (s: string) => s.trim().toLowerCase();

export type NvrContext = {
  cameras: CameraProduct[];
  channelsNeeded: number;
  requiredGb: number | null;
  requiredFeatures: string[];
  audio: boolean;
  alarmIo: boolean;
  products: Product[];
  policies: Policies;
};

/** Do these two products share an ONVIF profile both claim (S for streaming, T for H.265/advanced)? */
export function onvifCompatible(a: { onvifProfiles?: string[] }, b: { onvifProfiles?: string[] }): string[] {
  const x = new Set((a.onvifProfiles ?? []).map((p) => p.toUpperCase()));
  return (b.onvifProfiles ?? []).map((p) => p.toUpperCase()).filter((p) => x.has(p) && (p === "S" || p === "T"));
}

export function validateNvr(nvr: NvrProduct, ctx: NvrContext): NvrEvaluation {
  const checks: Check[] = [];
  const n = ctx.cameras.length;

  checks.push({ name: "channels", pass: n <= nvr.channels && ctx.channelsNeeded <= nvr.channels, detail: `${n} camera(s), ${ctx.channelsNeeded} channel(s) needed, recorder has ${nvr.channels}` });

  const bitrates = ctx.cameras.map((c) => c.expectedBitrateMbps);
  if (bitrates.some((b) => b == null)) {
    checks.push({ name: "bandwidth", pass: false, detail: "A camera has no expected bitrate in the catalogue, so incoming bandwidth cannot be verified" });
  } else {
    const total = (bitrates as number[]).reduce((s, b) => s + b, 0);
    checks.push({ name: "bandwidth", pass: total <= nvr.incomingMbps, detail: `${total.toFixed(1)} Mbps from cameras, recorder accepts ${nvr.incomingMbps} Mbps` });
  }

  if (nvr.poePorts > 0) {
    const watts = ctx.cameras.slice(0, nvr.poePorts).map((c) => c.poeWatts);
    if (watts.some((w) => w == null)) {
      checks.push({ name: "poe", pass: false, detail: "A camera has no PoE power figure, so the PoE budget cannot be verified" });
    } else {
      const ws = watts as number[];
      const perPort = nvr.poePerPortW ?? Infinity;
      const budget = nvr.poeBudgetW ?? Infinity;
      const over = ws.filter((w) => w > perPort);
      const total = ws.reduce((s, w) => s + w, 0);
      const pass = over.length === 0 && total <= budget;
      checks.push({
        name: "poe",
        pass,
        detail: over.length
          ? `${over.length} camera(s) draw more than the ${perPort} W per port`
          : `${total.toFixed(1)} W across ${ws.length} port(s), budget ${nvr.poeBudgetW ?? "not stated"} W`,
      });
    }
    if (n > nvr.poePorts) checks.push({ name: "poe_ports", pass: true, detail: `${n - nvr.poePorts} camera(s) beyond the recorder's ${nvr.poePorts} PoE ports need a PoE switch` });
  } else {
    checks.push({ name: "poe", pass: true, detail: "Recorder has no PoE ports: an external PoE switch powers the cameras" });
  }

  if (ctx.requiredGb == null) {
    checks.push({ name: "storage", pass: false, detail: "Storage requirement unknown" });
  } else {
    const drives = chooseDrives(ctx.requiredGb, nvr, ctx.products, ctx.policies);
    checks.push({
      name: "storage",
      pass: !!drives,
      detail: drives
        ? `${drives.count} x ${drives.product.capacityTb} TB holds the ${Math.round(ctx.requiredGb)} GB needed`
        : `cannot hold ${Math.round(ctx.requiredGb)} GB (${nvr.hddBays} bay(s), ${nvr.maxHddTb} TB per drive, ${nvr.maxTotalTb} TB total)`,
    });
  }

  const features = new Set(nvr.features.map(norm));
  const lacking = ctx.requiredFeatures.filter((f) => !features.has(norm(f)));
  if (ctx.audio && !nvr.audio) lacking.push("audio");
  if (ctx.alarmIo && !nvr.alarmIo) lacking.push("alarm I/O");
  checks.push({ name: "features", pass: lacking.length === 0, detail: lacking.length ? `lacks ${lacking.join(", ")}` : "required features supported" });

  const foreign = ctx.cameras.filter((c) => norm(c.manufacturer) !== norm(nvr.manufacturer));
  if (foreign.length) {
    const unsupported = foreign.filter((c) => onvifCompatible(c, nvr).length === 0);
    checks.push({
      name: "interoperability",
      pass: unsupported.length === 0,
      detail: unsupported.length
        ? `${unsupported.map((c) => `${c.manufacturer} ${c.model}`).join(", ")} and ${nvr.manufacturer} share no ONVIF Profile S/T`
        : `mixed brands share ONVIF ${onvifCompatible(foreign[0], nvr).join("/")}; proprietary analytics still to be verified`,
    });
  }

  return { product: nvr, pass: checks.every((c) => c.pass), checks };
}

/** Channels to plan for: Get Secure's residential sizing, or current plus future for commercial. */
export function channelsNeeded(count: number, propertyType: PropertyType | null, futureCameras: number | null | undefined, policies: Policies): { channels: number; expansion: number; notes: string[] } {
  const notes: string[] = [];
  if (propertyType === "commercial") {
    const future = futureCameras ?? 0;
    if (futureCameras == null) notes.push("Future camera count unknown: expansion capacity to be set at the site visit.");
    return { channels: count + future, expansion: future, notes };
  }
  const small = policies.residentialSmallRecorderChannels.value;
  if (count <= small.maxCameras) {
    notes.push(`${count} camera(s): ${small.channels}-channel recorder per Get Secure policy; not upsized for expansion without a reason.`);
    return { channels: small.channels, expansion: 0, notes };
  }
  return { channels: count, expansion: 0, notes };
}

export function selectNvr(
  nvrs: NvrProduct[],
  ctx: NvrContext & { propertyType: PropertyType | null; tier: Tier | null; exactChannels: number | null },
): { selected: NvrProduct | null; evaluated: NvrEvaluation[]; storageShortfall: boolean; notes: string[] } {
  const notes: string[] = [];
  const makers = new Map<string, number>();
  for (const c of ctx.cameras) makers.set(norm(c.manufacturer), (makers.get(norm(c.manufacturer)) ?? 0) + 1);
  const mainMaker = [...makers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  let pool = nvrs.filter((r) => r.status !== "deprecated" && (ctx.propertyType === "commercial" ? r.market !== "residential" : r.market !== "commercial"));
  if (ctx.propertyType !== "commercial" && ctx.tier) {
    const sameTier = pool.filter((r) => r.tier === ctx.tier);
    if (sameTier.length) pool = sameTier;
    else notes.push("No recorder in this tier; considered recorders from any residential tier.");
  }
  // Residential 2-4 cameras: only the policy size, unless none of that size passes.
  const preferred = ctx.exactChannels ? pool.filter((r) => r.channels === ctx.exactChannels) : [];
  const ordered = (list: NvrProduct[]) =>
    [...list].sort(
      (a, b) =>
        a.channels - b.channels ||
        (norm(a.manufacturer) === mainMaker ? 0 : 1) - (norm(b.manufacturer) === mainMaker ? 0 : 1) ||
        (TRUSTED_STATUSES.includes(a.status) && a.price?.approved ? 0 : 1) - (TRUSTED_STATUSES.includes(b.status) && b.price?.approved ? 0 : 1) ||
        (a.price?.costExGst ?? Infinity) - (b.price?.costExGst ?? Infinity) ||
        a.model.localeCompare(b.model),
    );

  const evaluated: NvrEvaluation[] = [];
  const groups = [ordered(preferred), ordered(pool.filter((r) => !preferred.includes(r) && r.channels >= ctx.channelsNeeded))];
  for (let g = 0; g < groups.length; g++) {
    for (const r of groups[g]) {
      const e = validateNvr(r, ctx);
      evaluated.push(e);
      if (e.pass) {
        if (g === 1 && ctx.exactChannels) notes.push(`No ${ctx.exactChannels}-channel recorder passed every check; ${r.channels}-channel chosen.`);
        return { selected: r, evaluated, storageShortfall: false, notes };
      }
    }
  }
  // Nothing passes everything. If one fails only on storage, offer it with the shortfall flagged.
  const storageOnly = evaluated.find((e) => e.checks.filter((c) => !c.pass).every((c) => c.name === "storage"));
  if (storageOnly) {
    notes.push(`${storageOnly.product.manufacturer} ${storageOnly.product.model} passes everything except storage: offered with the retention shortfall flagged.`);
    return { selected: storageOnly.product, evaluated, storageShortfall: true, notes };
  }
  if (!evaluated.length) notes.push("No recorder in the catalogue for this job.");
  else notes.push("No recorder in the catalogue passes every check.");
  return { selected: null, evaluated, storageShortfall: false, notes };
}
