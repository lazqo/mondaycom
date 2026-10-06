/**
 * Shared pieces of every supplier connector: small HTML helpers, the price types, the GST-basis
 * rule, CAPTCHA/MFA markers and the model-to-listing matching. Each supplier site (itplus.ts,
 * cleardigital.ts, webninja.ts) builds on these and keeps the same rules: a price is read only when
 * it is unambiguous and its GST basis is known; anything else is reported, not recorded.
 */
export type PriceBasis = "ex" | "inc";

export type ParsedProductPage = {
  loggedIn: boolean | null;
  title: string | null;
  sku: string | null;
  stock: string | null;
  /** The visible text of the price, for the run report (e.g. "$173.20 + GST"). */
  priceText: string | null;
  amount: number | null;
  /** A struck-through earlier price (WooCommerce sale markup), shown so a person can see it was a sale. */
  wasAmount: number | null;
  /** Basis shown next to the price on this page, if any. */
  suffixBasis: PriceBasis | null;
  /** The shop's tax display setting, where the page carries it. */
  siteBasis: PriceBasis | null;
  /** Why no amount could be read. */
  reason: string | null;
  /** When no price could be read: the page's class names and the text around any dollar amounts, for the developer. Never secrets. */
  sketch?: string | null;
};

export type CatalogueEntry = {
  id: number;
  /** The manufacturer model/part number the supplier shows, where that is separate from its own SKU. */
  model?: string | null;
  sku: string;
  name: string;
  url: string;
  type: string;
  /** The supplier's own short description (e.g. "Supply Only", "Price Including Installation In a Recorder"). */
  summary?: string | null;
  /** The "Notes*" section of the supplier's description, where it has one. */
  notes?: string | null;
  /** Public stock wording. */
  stock?: string | null;
};

// ---------- small HTML helpers (supplier shop markup is regular enough for these) ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function textOf(html: string): string {
  return decodeEntities(html.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\$ (?=\d)/g, "$")
    .trim();
}

/** The inner HTML of the first <tag> whose class list has `cls`, from `from`, with nesting of the same tag balanced. */
export function elementByClass(html: string, tag: string, cls: string, from = 0): { inner: string; start: number; end: number } | null {
  // `cls` must be a whole class name ("price" does not match "price-wrapper").
  const open = new RegExp(`<${tag}\\b[^>]*\\bclass\\s*=\\s*(["'])(?:[^"']*\\s)?${cls.replace(/[-]/g, "\\-")}(?:\\s[^"']*)?\\1[^>]*>`, "gi");
  open.lastIndex = from;
  const m = open.exec(html);
  if (!m) return null;
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tagRe.lastIndex = m.index + m[0].length;
  let depth = 1;
  let t: RegExpExecArray | null;
  while ((t = tagRe.exec(html))) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return { inner: html.slice(m.index + m[0].length, t.index), start: m.index, end: t.index + t[0].length };
  }
  return { inner: html.slice(m.index + m[0].length), start: m.index, end: html.length };
}

export function allByClass(html: string, tag: string, cls: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const e = elementByClass(html, tag, cls, from);
    if (!e) return out;
    out.push(e.inner);
    from = e.end;
  }
}

export function amountOf(fragment: string): number | null {
  const t = textOf(fragment).replace(/[$\s]/g, "");
  const m = t.match(/^(?:NZ)?\$?([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(\.[0-9]{1,2})?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "") + (m[2] ?? ""));
  return Number.isFinite(n) ? n : null;
}

export function basisOf(text: string | null | undefined): PriceBasis | null {
  if (!text) return null;
  const t = text.toLowerCase();
  // "+ GST", "ex GST", "excl. GST", "excludes GST", "exclusive of GST", "GST exclusive", "plus GST"
  const ex = /\+\s*gst|\bex\.?\s*gst|\bexcl(?:\.|udes?|uding|usive)?(?:\s+of)?\s*gst|\bexcluding\b|\bplus\s+gst|\bgst\s+excl(?:\.|usive|uded)?\b/.test(t);
  // "inc GST", "incl. GST", "includes GST", "inclusive of GST", "GST inclusive"
  const inc = /\binc\.?\s*gst|\bincl(?:\.|udes?|uding|usive)?(?:\s+of)?\s*gst|\bincluding\b|\bgst\s+incl(?:\.|usive|uded)?\b/.test(t);
  if (ex === inc) return null;
  return ex ? "ex" : "inc";
}

export const CAPTCHA_RE = /g-recaptcha|h-captcha|cf-turnstile|data-sitekey|grecaptcha|hcaptcha|name="[^"]*captcha[^"]*"/i;
export const MFA_RE = /two[- ]factor|2fa\b|authentication code|verification code|one[- ]time (pass)?code|authenticator app|security code|name="[^"]*(otp|totp|2fa|mfa|authcode)[^"]*"/i;

/**
 * Decide the GST basis of a page's price: its own suffix first, then the shop's setting seen on this
 * page or on another logged-in page in the same run. A disagreement or no evidence means no price.
 */
export function resolveBasis(page: ParsedProductPage, runBasis: PriceBasis | null): { basis: PriceBasis; from: string } | { basis: null; reason: string } {
  const site = page.siteBasis ?? runBasis;
  if (page.suffixBasis && site && page.suffixBasis !== site) return { basis: null, reason: `The page's GST label (${page.suffixBasis} GST) disagrees with the shop's tax setting (${site} GST); not recorded.` };
  if (page.suffixBasis) return { basis: page.suffixBasis, from: "price label" };
  if (site) return { basis: site, from: "shop tax setting" };
  return { basis: null, reason: "The page does not say whether the price is ex or inc GST; not recorded." };
}

/** A comparable key for a model or SKU: no brand words, no "mm", no punctuation. */
export function modelKey(s: string, brandWords: string[] = []): string {
  let t = s.toLowerCase();
  for (const w of brandWords) t = t.replace(new RegExp(`\\b${w.toLowerCase().replace(/[^a-z0-9]+/g, "[^a-z0-9]*")}\\b`, "g"), " ");
  return t.replace(/(\d)\s*mm\b/g, "$1").replace(/[^a-z0-9]/g, "");
}

const BRAND_WORDS: Record<string, string[]> = {
  "TP-Link": ["tp-link", "tp link", "vigi", "insight"],
  "TP-Link VIGI": ["tp-link", "tp link", "vigi", "insight"],
  HiLook: ["hilook"],
  Hikvision: ["hikvision"],
  "Dahua Technology": ["dahua"],
  Dahua: ["dahua"],
  "Zhejiang Uniview Technologies Co., Ltd.": ["uniview", "unv"],
  Uniview: ["uniview", "unv"],
  "Western Digital": ["western digital", "wd purple"],
  Seagate: ["seagate", "skyhawk"],
  "Ajax Systems": ["ajax systems", "ajax"],
  Ajax: ["ajax"],
};

export function brandWordsFor(manufacturer: string, family: string | null): string[] {
  return [...(BRAND_WORDS[manufacturer] ?? []), ...(family ? (BRAND_WORDS[family] ?? []) : []), manufacturer, ...(family ? [family] : [])];
}

/** A search term for the supplier catalogue: the model without brand words or lens suffix. */
export function searchTermFor(model: string, brandWords: string[]): string {
  let t = model;
  for (const w of brandWords) t = t.replace(new RegExp(`\\b${w.replace(/[^a-z0-9]+/gi, "[^a-z0-9]*")}\\b`, "gi"), " ");
  return t.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
}

/** The model/SKU keys a listing can be matched on: its SKU, its stated model, and each token of its name. */
function listingKeys(e: CatalogueEntry, brandWords: string[]): { exact: string[]; name: string[] } {
  const exact = [modelKey(e.sku, brandWords), ...(e.model ? [modelKey(e.model, brandWords)] : [])].filter(Boolean);
  // "Wi-Tek WI-PS305GH: 4x 1000Mbps PoE…" names the model as one token; a supplier whose own SKU
  // is a stock number (SWL) is matched that way.
  const name = e.name
    .split(/[\s,;:()[\]/|]+/)
    .map((t) => modelKey(t, brandWords))
    .filter((k) => k.length >= 4);
  return { exact, name };
}

/**
 * Match a canonical product to supplier listings. Only an exact model/SKU key is a match (the
 * listing's SKU, its model field, or the model written as one word of its name); listings that
 * merely start with the model (e.g. WD43PURZ-SUP and WD43PURZ-Inst for WD43PURZ) are returned as
 * candidates for a person to choose between.
 */
export function matchListing(model: string, brandWords: string[], entries: CatalogueEntry[]): { match: CatalogueEntry | null; candidates: CatalogueEntry[] } {
  const key = modelKey(model, brandWords);
  if (!key) return { match: null, candidates: [] };
  const keyed = entries.map((e) => ({ e, k: listingKeys(e, brandWords) }));
  const exact = keyed.filter((x) => x.k.exact.includes(key)).map((x) => x.e);
  if (exact.length === 1) return { match: exact[0], candidates: [] };
  if (exact.length > 1) return { match: null, candidates: exact };
  const byName = keyed.filter((x) => x.k.name.includes(key)).map((x) => x.e);
  if (byName.length === 1) return { match: byName[0], candidates: [] };
  if (byName.length > 1) return { match: null, candidates: byName.slice(0, 8) };
  // Close, not exact: a key that begins the other, and long enough to mean something ("Dome" is
  // not close to "DomeCam Mini"). The listing's own codes count from 4 characters; a word of the
  // name only from 6, and in both cases it must cover most of the model asked for.
  const closeEnough = (k: string, min: number) => k.length >= min && k.length >= Math.ceil(key.length * 0.6) && (k.startsWith(key) || key.startsWith(k));
  const near = keyed.filter((x) => x.k.exact.some((k) => closeEnough(k, 4)) || x.k.name.some((k) => closeEnough(k, 6))).map((x) => x.e);
  return { match: null, candidates: near.slice(0, 8) };
}

// ---------- price blocks and diagnostics shared by the custom-shop connectors ----------

/** Elements whose class mentions "price" (any tag), outermost first; label-only classes are skipped. */
export function priceBlocks(html: string): { cls: string; inner: string }[] {
  const out: { cls: string; inner: string }[] = [];
  const re = /<(div|span|p|td|th|strong|b|li|dd)\b[^>]*\bclass\s*=\s*(["'])([^"']*price[^"']*)\2[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const cls = m[3];
    if (/price-?(label|title|heading|note|caption)|no-?price|price-?(wrapper|box|container|block)$/i.test(cls) && !/\$/.test(html.slice(m.index, m.index + 400))) continue;
    const tag = m[1];
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    tagRe.lastIndex = m.index + m[0].length;
    let depth = 1;
    let t: RegExpExecArray | null;
    let end = html.length;
    while ((t = tagRe.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    out.push({ cls, inner: html.slice(m.index + m[0].length, end) });
  }
  return out;
}

/**
 * Every dollar amount in a piece of text, with the words around it (for labels and diagnostics),
 * split into what comes after it up to the next amount (where a label usually sits: "$158.00 ex
 * GST") and what comes before it back to the previous amount, so a label between two amounts is
 * read with the right one.
 */
export function amountsIn(text: string): { amount: number; around: string; before: string; after: string }[] {
  const matches = [...text.matchAll(/(?:NZ)?\$\s?([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(\.[0-9]{1,2})?/gi)];
  const out: { amount: number; around: string; before: string; after: string }[] = [];
  matches.forEach((m, n) => {
    const amount = amountOf(m[0].replace(/^NZ/i, ""));
    if (amount == null) return;
    const start = m.index!;
    const end = start + m[0].length;
    const prevEnd = n > 0 ? matches[n - 1].index! + matches[n - 1][0].length : Math.max(0, start - 40);
    const nextStart = n + 1 < matches.length ? matches[n + 1].index! : end + 60;
    out.push({ amount, around: text.slice(Math.max(0, start - 40), end + 40).trim(), before: text.slice(Math.max(prevEnd, start - 40), start).trim(), after: text.slice(end, Math.min(nextStart, end + 60)).trim() });
  });
  return out;
}

/**
 * A sketch of a product page for the developer when no price could be read: the class names
 * used in the product region, table headings, and the text around each dollar amount. Text is
 * limited to those fragments, so nothing from the account header or a form ever appears.
 */
export function pageSketch(regionHtml: string): string {
  const classes = [...new Set([...regionHtml.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean))].slice(0, 80);
  const headings = [...regionHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => textOf(m[1])).filter(Boolean).slice(0, 12);
  const text = textOf(regionHtml);
  const money = amountsIn(text).map((a) => `…${a.around}…`).slice(0, 8);
  const labels = [...new Set([...text.matchAll(/\b(?:your|trade|dealer|nett?|wholesale|rrp|retail|list|ex|inc|excl|incl)\.?\s*(?:price|gst)\b[^$]{0,20}/gi)].map((m) => m[0].trim()))].slice(0, 8);
  return [`classes: ${classes.join(" ") || "none"}`, headings.length ? `table headings: ${headings.join(" | ")}` : null, money.length ? `amounts: ${money.join(" ")}` : "amounts: none in the product region", labels.length ? `labels: ${labels.join(" | ")}` : null].filter(Boolean).join("\n");
}
