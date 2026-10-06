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
import { allByClass, amountOf, basisOf, CAPTCHA_RE, decodeEntities, elementByClass, MFA_RE, textOf, type CatalogueEntry, type ParsedProductPage, type PriceBasis } from "./html";
import type { SupplierSite } from "./site";

// The shared pieces keep their old import path for the tests and the runner.
export { basisOf, brandWordsFor, decodeEntities, elementByClass, matchListing, modelKey, resolveBasis, searchTermFor, textOf } from "./html";
export type { CatalogueEntry, ParsedProductPage, PriceBasis } from "./html";

export const ITPLUS_CONNECTOR = "itplus";
export const ITPLUS_BASE_URL = "https://www.itplus.co.nz";

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

/** IT Plus as a connector site. */
export const ITPLUS_SITE: SupplierSite = {
  key: ITPLUS_CONNECTOR,
  name: "IT Plus",
  baseUrl: ITPLUS_BASE_URL,
  envVar: "ITPLUS_BASE_URL",
  login,
  findInCatalogue,
  parseProductPage,
  blockOf,
};
