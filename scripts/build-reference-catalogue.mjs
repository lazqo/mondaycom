#!/usr/bin/env node
/**
 * Builds src/lib/brain/reference/catalogue.json from the verified research files in
 * data/catalogue-research/*.json (one per brand group; format in FORMAT.md).
 *
 * Specifications are copied as found; only field names are mapped to what the engine reads
 * (e.g. bitrateKbps max → maxBitrateMbps, poeMaxW → poeWatts). Nothing is estimated. A camera sold
 * with several fixed lenses becomes one product per lens, with that lens's published field of view.
 * The Get Secure tier and market flags come from FAMILY below (the v0.2 tier policy); they are
 * stored as provisional for Chris to confirm per product.
 *
 *   node scripts/build-reference-catalogue.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "data/catalogue-research";
const OUT = "src/lib/brain/reference/catalogue.json";

// Tier per family from the v0.2 brief; market flags: residential families are not offered for
// commercial jobs unless Chris changes the product; Axis/Hanwha are the commercial catalogue.
const FAMILY = {
  "TP-Link VIGI": { tier: "good", residential: true, commercial: false },
  HiLook: { tier: "better", residential: true, commercial: false },
  Tiandy: { tier: "better", residential: true, commercial: false },
  Dahua: { tier: "better", residential: true, commercial: false },
  Hikvision: { tier: "best", residential: true, commercial: true },
  Ajax: { tier: "premium", residential: true, commercial: false },
  TVT: { tier: null, residential: true, commercial: false },
  Uniview: { tier: null, residential: true, commercial: false },
  Axis: { tier: null, residential: false, commercial: true },
  Hanwha: { tier: null, residential: false, commercial: true },
};
const TIERED = new Set(["camera"]);
const GENERIC = { tier: null, residential: true, commercial: true }; // drives, accessories

/**
 * Links whose source is not an exact-model manufacturer listing are left out. (Hikvision's AcuSeek
 * checklist names camera series patterns and its authorship could not be confirmed; Hikvision
 * cameras still match Hikvision recorders as the same family.)
 */
const SKIP_LINK = (l) => /AcuSeek Camera Compatibility Checklist/.test(l.note ?? "");

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function engineSpecs(category, s) {
  const out = { ...s };
  delete out.ecosystem;
  delete out.formFactor;
  delete out.notes;
  if (category === "camera") {
    out.resolutionMp = num(s.resolutionMp);
    out.horizontalPixels = num(s.horizontalPixels);
    out.hfovDeg = num(s.hfovDeg);
    out.lensMm = Array.isArray(s.lensMm) ? s.lensMm : num(s.lensMm);
    out.irRangeM = num(s.irRangeM) ?? num(s.supplementLightRangeM) ?? null;
    out.whiteLightRangeM = num(s.whiteLightRangeM);
    out.colourNight = s.colourNight === true;
    out.wdrDb = num(s.wdrDb);
    out.codecs = Array.isArray(s.codecs) ? s.codecs : [];
    out.maxBitrateMbps = Array.isArray(s.bitrateKbps) && num(s.bitrateKbps[1]) ? s.bitrateKbps[1] / 1000 : null;
    out.expectedBitrateMbps = null; // Get Secure's planning figure: set in the CRM, never from a datasheet
    out.poeWatts = num(s.poeMaxW);
    out.analytics = Array.isArray(s.analytics) ? s.analytics : [];
    out.audio = s.microphone === true;
    out.speaker = s.speaker === true;
    out.activeDeterrence = Array.isArray(s.activeDeterrence) ? s.activeDeterrence : [];
    out.ingress = Array.isArray(s.ingress) ? s.ingress : [];
    out.onvifProfiles = Array.isArray(s.onvifProfiles) ? s.onvifProfiles : [];
  }
  if (category === "nvr") {
    out.features = Array.isArray(s.analytics) ? s.analytics : [];
    out.audio = num(s.audioIn) != null ? s.audioIn > 0 : undefined;
    out.alarmIo = num(s.alarmIn) != null ? s.alarmIn > 0 : undefined;
    out.compatibleFamilies = Array.isArray(s.compatibleFamilies) ? s.compatibleFamilies : [];
    out.onvifProfiles = Array.isArray(s.onvifProfiles) ? s.onvifProfiles : [];
    out.poePorts = num(s.poePorts) ?? 0;
    out.incomingMbps = num(s.incomingMbps) ?? 0;
  }
  if (category === "hdd") {
    out.capacityTb = num(s.capacityTb);
    out.surveillanceRated = s.surveillanceRated === true;
  }
  return out;
}

const products = [];
const links = [];
const variantsOf = new Map(); // "Manufacturer|base model" -> [{ key, lens }]
const notes = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const data = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  const family = (p) => p.family ?? p.manufacturer;
  for (const p of data.products) {
    const f = FAMILY[family(p)] ?? GENERIC;
    if (!FAMILY[family(p)] && !["hdd"].includes(p.category) && !/bracket|junction|kit/.test(p.category)) notes.push(`${file}: no tier policy for family ${family(p)}`);
    const base = {
      manufacturer: p.manufacturer,
      family: family(p),
      category: p.category,
      formFactor: p.specs.formFactor ?? null,
      residentialAllowed: f.residential,
      commercialAllowed: f.commercial,
      tier: TIERED.has(p.category) ? f.tier : null,
      ecosystem: Array.isArray(p.specs.ecosystem) ? p.specs.ecosystem : [],
      unverifiedFields: p.unverified ?? [],
      sourceUrl: p.datasheetUrl ? p.sourceUrl : p.sourceUrl,
      verifiedAt: p.verifiedAt,
      notes: [...(Array.isArray(p.notes) ? p.notes : p.notes ? [p.notes] : []), ...(p.datasheetUrl ? [`Datasheet: ${p.datasheetUrl}`] : [])].join(" ") || null,
    };
    const lenses = p.category === "camera" && Array.isArray(p.specs.lensOptions) && p.specs.hfovByLensDeg ? p.specs.lensOptions : null;
    const baseKey = `${p.manufacturer}|${p.model}`;
    if (lenses) {
      const list = [];
      for (const lens of lenses) {
        const hfov = p.specs.hfovByLensDeg[String(lens)];
        if (hfov == null) continue;
        const named = (p.orderableVariants ?? []).find((v) => v.replace(/\s/g, "").includes(`(${lens}mm)`));
        const model = named ?? `${p.model} (${lens}mm)`;
        const specs = engineSpecs("camera", { ...p.specs, lensMm: lens, hfovDeg: hfov });
        delete specs.lensOptions;
        delete specs.hfovByLensDeg;
        products.push({ ...base, model, specs });
        list.push({ key: `${p.manufacturer}|${model}`, lens });
      }
      variantsOf.set(baseKey, list);
    } else {
      const specs = engineSpecs(p.category, p.specs);
      if (p.category === "kit") delete specs.components;
      products.push({ ...base, model: p.model, specs });
      variantsOf.set(baseKey, [{ key: baseKey, lens: p.specs.lensMm ?? null }]);
    }
  }
  const makerOf = new Map(data.products.map((p) => [p.model, p.manufacturer]));
  const resolve = (model, lens) => {
    const v = variantsOf.get(`${makerOf.get(model)}|${model}`) ?? [];
    return lens != null ? v.filter((x) => x.lens === lens) : v;
  };
  for (const l of data.compatibility ?? []) {
    // Kit contents come from each kit's own component list (with the exact lens), below.
    if (l.kind === "kit_component") continue;
    if (SKIP_LINK(l)) {
      notes.push(`${file}: skipped ${l.kind} ${l.from} -> ${l.to} (${l.note})`);
      continue;
    }
    for (const from of resolve(l.from)) for (const to of resolve(l.to)) links.push({ kind: l.kind, from: from.key, to: to.key, quantity: l.qty ?? 1, sourceUrl: l.sourceUrl ?? null, notes: l.note ?? null });
  }
  // Kit contents become kit_component links to the exact lens variant.
  for (const p of data.products.filter((x) => x.category === "kit")) {
    for (const c of p.specs.components ?? []) {
      const targets = resolve(c.model, c.lensMm ?? null);
      if (targets.length !== 1) {
        notes.push(`${file}: kit ${p.model} component ${c.model} ${c.lensMm ?? ""} resolved to ${targets.length} products`);
        continue;
      }
      links.push({ kind: "kit_component", from: `${p.manufacturer}|${p.model}`, to: targets[0].key, quantity: c.qty ?? 1, sourceUrl: p.sourceUrl, notes: "Kit contents (manufacturer)" });
    }
  }
}

const seen = new Set();
for (const p of products) {
  const k = `${p.manufacturer}|${p.model}`;
  if (seen.has(k)) throw new Error(`duplicate product ${k}`);
  seen.add(k);
}
const linkKeys = new Set();
const uniqueLinks = links.filter((l) => {
  const k = `${l.kind}|${l.from}|${l.to}`;
  if (linkKeys.has(k) || !seen.has(l.from) || !seen.has(l.to)) return false;
  linkKeys.add(k);
  return true;
});

const version = `v0.2-${products.length}p-${uniqueLinks.length}l`;
writeFileSync(OUT, JSON.stringify({ version, products, links: uniqueLinks }, null, 1) + "\n");
console.log(`${OUT}: ${products.length} products, ${uniqueLinks.length} links (${version})`);
for (const n of notes) console.log(`note: ${n}`);
