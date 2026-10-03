/**
 * IT Plus (www.itplus.co.nz) trade-price connector: a WooCommerce shop that hides prices until a
 * trade account logs in ("Login to see prices").
 *
 * Rules this file keeps:
 * - The only cost it ever reads is the price on a product page fetched in a verified logged-in
 *   session. The public product API is used for catalogue metadata (SKU, name, description, page
 *   address) only; its price fields are dropped as soon as the response is parsed. They are never
 *   stored, never used as cost, and never decide whether a logged-in price is valid: a trade price
 *   that happens to equal the public figure is recorded like any other.
 * - A logged-in price is valid when: the session is verified as logged in, the page's SKU is the
 *   listing asked for, the price comes from that logged-in page, its GST basis is clear, and there
 *   is no RRP/retail/"was" ambiguity.
 * - A price is read only when it is unambiguous: exactly one amount (or the sale amount), no
 *   RRP/retail label, a known GST basis (the "+ GST" suffix or the shop's tax display setting),
 *   and the page's SKU matching the one asked for. Anything else is reported and nothing recorded.
 * - CAPTCHA, two-factor prompts and Cloudflare challenges stop the run; nothing tries to get past them.
 * - Login failures are reported as fixed reasons; the site's own message (which can quote the
 *   username) is never passed on.
 */
import { ConnectorError, type WebResponse, type WebSession } from "./web-session";

export const ITPLUS_CONNECTOR = "itplus";
export const ITPLUS_BASE_URL = "https://www.itplus.co.nz";

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
};

export type CatalogueEntry = {
  id: number;
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

// ---------- small HTML helpers (WooCommerce markup is regular enough for these) ----------

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

function allByClass(html: string, tag: string, cls: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const e = elementByClass(html, tag, cls, from);
    if (!e) return out;
    out.push(e.inner);
    from = e.end;
  }
}

function amountOf(fragment: string): number | null {
  const t = textOf(fragment).replace(/[$\s]/g, "");
  const m = t.match(/^(?:NZ)?\$?([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(\.[0-9]{1,2})?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "") + (m[2] ?? ""));
  return Number.isFinite(n) ? n : null;
}

export function basisOf(text: string | null | undefined): PriceBasis | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const ex = /\+\s*gst|\bex\.?\s*gst|\bexcl?\.?(uding)?\s*gst|\bexcluding\b|\bplus\s+gst/.test(t);
  const inc = /\binc\.?\s*gst|\bincl?\.?(uding)?\s*gst|\bincluding\b|\bgst\s+incl/.test(t);
  if (ex === inc) return null;
  return ex ? "ex" : "inc";
}

/** Whether the page belongs to a logged-in account (true), clearly does not (false), or can't tell (null). */
export function loggedInState(html: string): boolean | null {
  if (/"is_logged_in"\s*:\s*"?(1|true)"?/i.test(html) || /customer-logout/i.test(html) || /<body[^>]*class="[^"]*\blogged-in\b/i.test(html)) return true;
  if (/"is_logged_in"\s*:\s*"?(0|false)?"/i.test(html) || /Login to see prices/i.test(html)) return false;
  return null;
}

/** The shop's tax display setting, where a page carries WooCommerce's settings (bundle pages do). */
export function siteBasisOf(html: string): PriceBasis | null {
  const display = html.match(/"tax_display_shop"\s*:\s*"(excl|incl)"/i)?.[1]?.toLowerCase();
  const suffix = html.match(/"price_display_suffix"\s*:\s*"([^"]*)"/i)?.[1];
  const fromDisplay: PriceBasis | null = display === "excl" ? "ex" : display === "incl" ? "inc" : null;
  const fromSuffix = basisOf(suffix ? decodeEntities(suffix.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))) : null);
  if (fromDisplay && fromSuffix && fromDisplay !== fromSuffix) return null;
  return fromDisplay ?? fromSuffix;
}

// ---------- page checks ----------

/** CAPTCHA, a Cloudflare challenge or rate limiting: stop, never work around it. */
export function blockOf(res: WebResponse): ConnectorError | null {
  const h = res.html.slice(0, 200_000);
  if (/cf-chl|challenge-platform|cf_chl_opt|<title>\s*(Just a moment|Attention Required)/i.test(h) && (res.status === 403 || res.status === 503 || res.status === 429 || /Just a moment/i.test(h)))
    return new ConnectorError("blocked", "IT Plus's website (Cloudflare) asked for a browser security check. The connector stopped and did not try to get past it.");
  if (res.status === 429) return new ConnectorError("rate_limited", "IT Plus asked us to slow down (too many requests). The connector stopped; try again later.");
  return null;
}

const CAPTCHA_RE = /g-recaptcha|h-captcha|cf-turnstile|data-sitekey|grecaptcha|hcaptcha|name="[^"]*captcha[^"]*"/i;
const MFA_RE = /two[- ]factor|2fa\b|authentication code|verification code|one[- ]time (pass)?code|authenticator app|security code|name="[^"]*(otp|totp|2fa|mfa|authcode)[^"]*"/i;

export type LoginForm = { nonce: string; referer: string; extra: Record<string, string> };

/** The WooCommerce login form on /my-account/, or the reason it can't be used. */
export function parseLoginForm(html: string): LoginForm | ConnectorError {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  const form = forms.find((f) => /name="password"/i.test(f) && /woocommerce-login-nonce/i.test(f));
  if (!form) return new ConnectorError("login_form_changed", "IT Plus's login page has changed and the login form could not be found. Nothing was submitted.");
  if (CAPTCHA_RE.test(form)) return new ConnectorError("captcha", "IT Plus's login form now shows a CAPTCHA. The connector stopped and did not try to get past it.");
  const nonce = form.match(/name="woocommerce-login-nonce"[^>]*value="([^"]+)"/i)?.[1] ?? form.match(/value="([^"]+)"[^>]*name="woocommerce-login-nonce"/i)?.[1];
  if (!nonce) return new ConnectorError("login_form_changed", "IT Plus's login form is missing its security token. Nothing was submitted.");
  const referer = form.match(/name="_wp_http_referer"[^>]*value="([^"]*)"/i)?.[1] ?? "/my-account/";
  // Any other hidden fields the form carries are sent back as they are (never credential fields).
  const extra: Record<string, string> = {};
  for (const m of form.matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)) {
    const name = m[0].match(/name="([^"]+)"/i)?.[1];
    const value = m[0].match(/value="([^"]*)"/i)?.[1] ?? "";
    if (name && !["woocommerce-login-nonce", "_wp_http_referer", "username", "password"].includes(name)) extra[name] = decodeEntities(value);
  }
  return { nonce, referer: decodeEntities(referer), extra };
}

/** A fixed, credential-free reason for a rejected login (the site's own text can quote the username). */
export function loginFailureOf(html: string): ConnectorError {
  const errors = [...allByClass(html, "ul", "woocommerce-error"), ...allByClass(html, "div", "woocommerce-error"), ...allByClass(html, "div", "is-error")].map(textOf).join(" ");
  const t = errors.toLowerCase();
  if (CAPTCHA_RE.test(html) || /captcha/.test(t)) return new ConnectorError("captcha", "IT Plus asked for a CAPTCHA at login. The connector stopped and did not try to get past it.");
  if (/too many|locked|temporarily|try again (in|later)|limit/.test(t)) return new ConnectorError("locked", "IT Plus has temporarily locked logins for this account (too many attempts). Wait before trying again.");
  if (/unknown (username|email)|not registered|no account|isn.t registered|invalid username|invalid email/.test(t)) return new ConnectorError("auth_failed", "IT Plus did not recognise the stored username or email.");
  if (/password/.test(t) && /incorrect|invalid|wrong/.test(t)) return new ConnectorError("auth_failed", "IT Plus rejected the stored password.");
  if (/pending|not (yet )?approved|awaiting|inactive|disabled|suspended|deactivated/.test(t)) return new ConnectorError("account_inactive", "IT Plus says the trade account is pending approval or disabled.");
  if (/nonce|security check|expired|session/.test(t)) return new ConnectorError("login_form_changed", "IT Plus rejected the login form's security token; try again.");
  if (/required|empty/.test(t)) return new ConnectorError("auth_failed", "IT Plus says the stored login is incomplete (username or password missing).");
  return new ConnectorError("auth_failed", "IT Plus did not accept the login and gave no reason the connector recognises.");
}

/** Log in with the stored trade login. Throws a ConnectorError with a credential-free reason on failure. */
export async function login(session: WebSession, credential: { username: string | null; secret: string }): Promise<void> {
  if (!credential.username) throw new ConnectorError("auth_failed", "The stored IT Plus login has no username. Store the username and password again.");
  const page = await session.request("/my-account/");
  const blocked = blockOf(page);
  if (blocked) throw blocked;
  if (loggedInState(page.html) === true) return;
  const form = parseLoginForm(page.html);
  if (form instanceof ConnectorError) throw form;
  const res = await session.request("/my-account/", {
    method: "POST",
    form: { ...form.extra, username: credential.username, password: credential.secret, "woocommerce-login-nonce": form.nonce, _wp_http_referer: form.referer, login: "Log in" },
  });
  const blockedAfter = blockOf(res);
  if (blockedAfter) throw blockedAfter;
  if (MFA_RE.test(res.html) && loggedInState(res.html) !== true)
    throw new ConnectorError("mfa", "IT Plus asked for a two-factor / verification code. The connector stopped; it does not handle or bypass that step.");
  if (loggedInState(res.html) === true && session.cookieNames().some((n) => /^wordpress_logged_in_/i.test(n))) return;
  if (loggedInState(res.html) === true) {
    // Logged-in page but no WordPress login cookie: confirm on a fresh page before trusting it.
    const check = await session.request("/my-account/");
    if (loggedInState(check.html) === true) return;
  }
  throw loginFailureOf(res.html);
}

// ---------- product pages ----------

export function parseProductPage(html: string): ParsedProductPage {
  const out: ParsedProductPage = { loggedIn: loggedInState(html), title: null, sku: null, stock: null, priceText: null, amount: null, wasAmount: null, suffixBasis: null, siteBasis: siteBasisOf(html), reason: null };
  const summary = elementByClass(html, "div", "summary");
  const region = summary ? summary.inner : html;
  const title = elementByClass(region, "h1", "product_title");
  out.title = title ? textOf(title.inner) : null;
  const sku = elementByClass(html, "span", "sku");
  out.sku = sku ? textOf(sku.inner) || null : (html.match(/"@type"\s*:\s*"Product"[\s\S]{0,2000}?"sku"\s*:\s*"([^"]+)"/)?.[1] ?? null);
  const stockEl = region.match(/<p\b[^>]*class="[^"]*\bstock\b([^"]*)"[^>]*>([\s\S]*?)<\/p>/i);
  if (stockEl) {
    const text = textOf(stockEl[2]);
    out.stock = text || (/out-of-stock/.test(stockEl[1]) ? "Out of stock" : /backorder/.test(stockEl[1]) ? "Available on back-order" : /in-stock/.test(stockEl[1]) ? "In stock" : null);
  }

  const priceEl = elementByClass(region, "p", "price") ?? elementByClass(region, "span", "price");
  if (!priceEl) return { ...out, reason: "No price is shown on the product page." };
  const priceHtml = priceEl.inner.replace(/<span\b[^>]*class="[^"]*screen-reader-text[^"]*"[^>]*>[\s\S]*?<\/span>/gi, " ");
  const text = textOf(priceHtml);
  out.priceText = text.slice(0, 160) || null;
  if (/login to see prices|log ?in to (see|view)/i.test(text)) return { ...out, loggedIn: false, reason: "The price is hidden: the page was not served to a logged-in account." };
  if (/\b(rrp|retail|msrp|recommended)\b/i.test(text)) return { ...out, reason: `The price is labelled as retail/RRP ("${out.priceText}"); not used as trade cost.` };
  // A sale is shown as <del>was</del><ins>now</ins>. That is unambiguous only with exactly one of
  // each; any other "was" wording, or del without ins, is not read.
  const hasDel = /<del\b/i.test(priceHtml);
  const hasIns = /<ins\b/i.test(priceHtml);
  if (hasDel !== hasIns) return { ...out, reason: `The price shows a struck-through or "was" amount without a clear current price ("${out.priceText}"); not recorded.` };
  if (!hasDel && /\b(was|now|save|previously)\b/i.test(text)) return { ...out, reason: `The price has "was/now" wording without sale markup ("${out.priceText}"); not recorded.` };
  if (hasDel) {
    const dels = [...priceHtml.matchAll(/<del\b[^>]*>([\s\S]*?)<\/del>/gi)].flatMap((m) => allByClass(m[1], "span", "woocommerce-Price-amount").map(amountOf));
    const inss = [...priceHtml.matchAll(/<ins\b[^>]*>([\s\S]*?)<\/ins>/gi)].flatMap((m) => allByClass(m[1], "span", "woocommerce-Price-amount").map(amountOf));
    const outside = allByClass(priceHtml.replace(/<(del|ins)\b[\s\S]*?<\/\1>/gi, " "), "span", "woocommerce-Price-amount");
    if (dels.length !== 1 || inss.length !== 1 || outside.length) return { ...out, reason: `The sale price markup is not one "was" and one current amount ("${out.priceText}"); not recorded.` };
    out.wasAmount = dels[0];
  }
  const current = hasIns ? [...priceHtml.matchAll(/<ins\b[^>]*>([\s\S]*?)<\/ins>/gi)].map((m) => m[1]).join(" ") : priceHtml;
  const amounts = allByClass(current, "span", "woocommerce-Price-amount").map(amountOf);
  if (amounts.length === 0) return { ...out, reason: `No amount could be read from the price ("${out.priceText ?? ""}").` };
  if (amounts.length > 1) return { ...out, reason: `More than one price is shown ("${out.priceText}"); not recorded.` };
  const amount = amounts[0];
  if (amount == null || !(amount > 0) || amount >= 100_000) return { ...out, reason: `The price could not be read as an amount ("${out.priceText}").` };
  if (/\bfrom\b|\bup to\b|–|—/i.test(text.replace(/\s*\+\s*gst.*$/i, ""))) {
    // A bundle shows "From:" when it has optional extras. That base price is the product alone only
    // when every bundled item is optional.
    const optional = (html.match(/data-optional="yes"/gi) ?? []).length;
    const items = (html.match(/data-optional="/gi) ?? []).length;
    if (!(items > 0 && optional === items)) return { ...out, reason: `The price is a range or "from" price ("${out.priceText}"); not recorded.` };
  }
  const suffix = elementByClass(priceHtml, "small", "woocommerce-price-suffix") ?? elementByClass(priceHtml, "span", "woocommerce-price-suffix");
  out.suffixBasis = basisOf(suffix ? textOf(suffix.inner) : text);
  out.amount = amount;
  return out;
}

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

// ---------- catalogue lookup (public metadata only) ----------

/** Parse WooCommerce Store API product JSON down to catalogue metadata. Price fields are discarded here. */
export function parseCatalogueJson(body: string, origin: string): CatalogueEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: CatalogueEntry[] = [];
  for (const p of data as Record<string, unknown>[]) {
    const url = typeof p.permalink === "string" ? p.permalink : null;
    if (typeof p.id !== "number" || typeof p.sku !== "string" || !p.sku || !url) continue;
    if (new URL(url, origin).origin !== new URL(origin).origin) continue;
    const description = typeof p.description === "string" ? textOf(p.description) : "";
    const notesAt = description.search(/\bNotes\s*\*/i);
    const stock = p.stock_availability && typeof p.stock_availability === "object" ? (p.stock_availability as { text?: string; class?: string }) : null;
    out.push({
      id: p.id,
      sku: p.sku.trim(),
      name: decodeEntities(String(p.name ?? "")),
      url,
      type: String(p.type ?? "simple"),
      summary: typeof p.short_description === "string" ? textOf(p.short_description).slice(0, 300) || null : null,
      notes: notesAt >= 0 ? description.slice(notesAt).slice(0, 1200) : null,
      stock: stock ? stock.text || (stock.class === "in-stock" ? "In stock" : stock.class === "out-of-stock" ? "Out of stock" : (stock.class ?? null)) : null,
    });
  }
  return out;
}

export async function findInCatalogue(session: WebSession, q: { skus?: string[]; search?: string }): Promise<CatalogueEntry[]> {
  const params = new URLSearchParams({ per_page: "50" });
  if (q.skus?.length) params.set("sku", q.skus.join(","));
  if (q.search) params.set("search", q.search);
  const res = await session.request(`/wp-json/wc/store/v1/products?${params}`, { accept: "application/json" });
  const blocked = blockOf(res);
  if (blocked) throw blocked;
  if (res.status !== 200) return [];
  return parseCatalogueJson(res.html, session.url("/"));
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
  "Western Digital": ["western digital", "wd purple"],
  Seagate: ["seagate", "skyhawk"],
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

/**
 * Match a canonical product to supplier listings. Only an exact model/SKU key is a match; listings
 * that merely start with the model (e.g. WD43PURZ-SUP and WD43PURZ-Inst for WD43PURZ) are returned
 * as candidates for a person to choose between.
 */
export function matchListing(model: string, brandWords: string[], entries: CatalogueEntry[]): { match: CatalogueEntry | null; candidates: CatalogueEntry[] } {
  const key = modelKey(model, brandWords);
  if (!key) return { match: null, candidates: [] };
  const exact = entries.filter((e) => modelKey(e.sku, brandWords) === key);
  if (exact.length === 1) return { match: exact[0], candidates: [] };
  if (exact.length > 1) return { match: null, candidates: exact };
  const near = entries.filter((e) => {
    const k = modelKey(e.sku, brandWords);
    return k.length >= 4 && (k.startsWith(key) || key.startsWith(k));
  });
  return { match: null, candidates: near.slice(0, 8) };
}
