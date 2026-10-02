/**
 * Recorder selection. A recorder is never chosen on channel count alone. Each of these is its own
 * check: channels, incoming bandwidth, PoE (per port and in total), storage, recording
 * resolution, simultaneous decoding, features/analytics, and camera compatibility.
 */
import type { CameraProduct, Check, CompatibilityLink, NvrEvaluation, NvrProduct, Policies, Product, PropertyType, Tier } from "./types";
import { TRUSTED_STATUSES } from "./types";
import { chooseDrives } from "./storage";
import { planningBitrate } from "./cameras";
import { cameraNvrBasis } from "./compat";
import { familyOf } from "./pricing";

export { onvifCompatible } from "./compat";

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
  links?: CompatibilityLink[];
};

/** "1080p" → 2, "4K" → 8, "6" → 6: decoding keys as megapixels. */
export function decodingKeyMp(key: string): number | null {
  const k = key.trim().toLowerCase();
  if (k === "4k" || k === "2160p") return 8;
  if (k === "1080p") return 2;
  if (k === "720p") return 1;
  const n = Number(k.replace(/mp$/, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function validateNvr(nvr: NvrProduct, ctx: NvrContext): NvrEvaluation {
  const checks: Check[] = [];
  const n = ctx.cameras.length;

  checks.push({ name: "channels", pass: n <= nvr.channels && ctx.channelsNeeded <= nvr.channels, detail: `${n} camera(s), ${ctx.channelsNeeded} channel(s) needed, recorder has ${nvr.channels}` });

  const bitrates = ctx.cameras.map((c) => planningBitrate(c));
  if (bitrates.some((b) => b.mbps == null)) {
    checks.push({ name: "bandwidth", pass: false, detail: "A camera has no bitrate in the catalogue, so incoming bandwidth cannot be verified" });
  } else if (!(nvr.incomingMbps > 0)) {
    checks.push({ name: "bandwidth", pass: true, unverified: true, detail: "Recorder incoming bandwidth not in the catalogue" });
  } else {
    const total = bitrates.reduce((s, b) => s + b.mbps!, 0);
    const conservative = bitrates.some((b) => b.basis === "max_published");
    checks.push({
      name: "bandwidth",
      pass: total <= nvr.incomingMbps,
      detail: `${total.toFixed(1)} Mbps from cameras${conservative ? " (at the maximum published bitrate)" : ""}, recorder accepts ${nvr.incomingMbps} Mbps`,
    });
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
    const drives = chooseDrives(ctx.requiredGb, nvr, ctx.products, ctx.policies, ctx.links);
    checks.push({
      name: "storage",
      pass: !!drives,
      detail: drives
        ? `${drives.count} x ${drives.product.capacityTb} TB holds the ${Math.round(ctx.requiredGb)} GB needed`
        : `cannot hold ${Math.round(ctx.requiredGb)} GB (${nvr.hddBays} bay(s), ${nvr.maxHddTb} TB per drive, ${nvr.maxTotalTb} TB total)`,
    });
  }

  const maxMp = Math.max(0, ...ctx.cameras.map((c) => c.resolutionMp));
  if (nvr.recordingResolutionMaxMp == null) {
    checks.push({ name: "recording", pass: true, unverified: true, detail: "Recorder's maximum recording resolution not in the catalogue" });
  } else {
    checks.push({
      name: "recording",
      pass: maxMp <= nvr.recordingResolutionMaxMp,
      detail: `cameras up to ${maxMp} MP, recorder records up to ${nvr.recordingResolutionMaxMp} MP`,
    });
  }

  const decoding = Object.entries(nvr.decoding ?? {})
    .map(([k, ch]) => ({ mp: decodingKeyMp(k), ch }))
    .filter((d): d is { mp: number; ch: number } => d.mp != null && d.ch > 0);
  if (!decoding.length) {
    checks.push({ name: "decoding", pass: true, unverified: true, detail: "Recorder's decoding capability not in the catalogue" });
  } else {
    const able = decoding.filter((d) => d.mp >= maxMp - 0.05).sort((a, b) => a.mp - b.mp)[0];
    const top = Math.max(...decoding.map((d) => d.mp));
    checks.push({
      name: "decoding",
      // Decoding printed only at lower resolutions is a gap in the datasheet, not proof it cannot.
      pass: true,
      unverified: !able,
      detail: able
        ? `decodes ${able.ch} channel(s) at ${able.mp} MP simultaneously for live view/playback${nvr.decodingText ? ` (${nvr.decodingText})` : ""}`
        : `decoding printed only up to ${top} MP; check ${maxMp} MP main-stream decoding${nvr.decodingText ? ` (${nvr.decodingText})` : ""}`,
    });
  }

  const features = new Set(nvr.features.map(norm));
  const lacking = ctx.requiredFeatures.filter((f) => !features.has(norm(f)));
  if (ctx.audio && !nvr.audio) lacking.push("audio");
  if (ctx.alarmIo && !nvr.alarmIo) lacking.push("alarm I/O");
  checks.push({ name: "features", pass: lacking.length === 0, detail: lacking.length ? `lacks ${lacking.join(", ")}` : "required features supported" });

  const bases = [...new Map(ctx.cameras.map((c) => [c.id, c])).values()].map((c) => ({ c, ...cameraNvrBasis(c, nvr, ctx.links ?? []) }));
  const none = bases.filter((b) => !b.basis);
  const onvif = bases.filter((b) => b.basis === "onvif");
  checks.push({
    name: "compatibility",
    pass: none.length === 0,
    unverified: none.length === 0 && onvif.length > 0,
    detail: none.length
      ? `${none.map((b) => `${b.c.manufacturer} ${b.c.model}`).join(", ")}: no documented compatibility, same family or shared ONVIF Profile S/T with ${nvr.model}`
      : onvif.length
        ? `${onvif.map((b) => b.c.model).join(", ")} via ONVIF ${[...new Set(onvif.flatMap((b) => b.profiles))].join("/")} only; proprietary analytics still to be verified`
        : bases.every((b) => b.basis === "documented")
          ? "compatibility documented"
          : "same family as the cameras",
  });

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
  const families = new Map<string, number>();
  for (const c of ctx.cameras) families.set(norm(familyOf(c)), (families.get(norm(familyOf(c))) ?? 0) + 1);
  const mainFamily = [...families.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const pool = nvrs.filter((r) => r.status !== "deprecated" && (ctx.propertyType === "commercial" ? r.commercialAllowed : r.residentialAllowed));
  const ordered = (list: NvrProduct[]) =>
    [...list].sort(
      (a, b) =>
        a.channels - b.channels ||
        (TRUSTED_STATUSES.includes(a.status) && a.price?.approved ? 0 : 1) - (TRUSTED_STATUSES.includes(b.status) && b.price?.approved ? 0 : 1) ||
        (a.price?.costExGst ?? Infinity) - (b.price?.costExGst ?? Infinity) ||
        a.model.localeCompare(b.model),
    );
  // Same family as the cameras first; a recorder from another family only if none of those works.
  // Within each: the policy size (residential 2-4 cameras: 4-channel) before anything larger.
  const same = pool.filter((r) => norm(familyOf(r)) === mainFamily);
  const other = pool.filter((r) => norm(familyOf(r)) !== mainFamily);
  const sized = (list: NvrProduct[]) => {
    const exact = ctx.exactChannels ? list.filter((r) => r.channels === ctx.exactChannels) : [];
    return [ordered(exact), ordered(list.filter((r) => !exact.includes(r) && r.channels >= ctx.channelsNeeded))];
  };

  const evaluated: NvrEvaluation[] = [];
  const tryGroups = (groups: NvrProduct[][]) => {
    const tried: NvrEvaluation[] = [];
    for (let g = 0; g < groups.length; g++) {
      for (const r of groups[g]) {
        const e = validateNvr(r, ctx);
        evaluated.push(e);
        tried.push(e);
        if (e.pass) {
          if (g === 1 && ctx.exactChannels) notes.push(`No ${ctx.exactChannels}-channel recorder passed every check; ${r.channels}-channel chosen.`);
          return { pass: e, tried };
        }
      }
    }
    return { pass: null, tried };
  };
  // Nothing passes everything: one that fails only on storage is offered with the shortfall flagged.
  const storageOnly = (list: NvrEvaluation[]) => list.find((e) => e.checks.filter((c) => !c.pass).every((c) => c.name === "storage"));

  const own = tryGroups(sized(same));
  if (own.pass) return { selected: own.pass.product, evaluated, storageShortfall: false, notes };
  const ownShort = storageOnly(own.tried);
  if (ownShort) {
    notes.push(`${ownShort.product.manufacturer} ${ownShort.product.model} passes everything except storage: offered with the retention shortfall flagged rather than mixing brands.`);
    return { selected: ownShort.product, evaluated, storageShortfall: true, notes };
  }
  const cross = tryGroups(sized(other));
  if (cross.pass) {
    if (same.length) notes.push(`No ${mainFamily} recorder passes; ${cross.pass.product.manufacturer} ${cross.pass.product.model} chosen (different family).`);
    return { selected: cross.pass.product, evaluated, storageShortfall: false, notes };
  }
  const crossShort = storageOnly(cross.tried);
  if (crossShort) {
    notes.push(`${crossShort.product.manufacturer} ${crossShort.product.model} passes everything except storage: offered with the retention shortfall flagged.`);
    return { selected: crossShort.product, evaluated, storageShortfall: true, notes };
  }
  if (!evaluated.length) notes.push("No recorder in the catalogue for this job.");
  else notes.push("No recorder in the catalogue passes every check.");
  return { selected: null, evaluated, storageShortfall: false, notes };
}
