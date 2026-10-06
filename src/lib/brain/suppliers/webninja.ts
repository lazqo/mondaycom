/**
 * Connector for suppliers on the WebNinja B2B webstore platform: SWL / Security Wholesale
 * (www.swl.co.nz) and Vesta Electrical (www.vestaelectrical.co.nz). Guests see "POA" in place of
 * every price; a signed-in trade account sees its own prices.
 *
 * Rules this file keeps (the same as every connector):
 * - The only cost it reads is the price on a product page fetched in a verified logged-in session
 *   (the page's body class says "logged-in"; "non-logged-in" means the price shown is not ours).
 * - A price is read only when it is unambiguous: one amount in the product's price block, not POA,
 *   no RRP/retail/"was" wording, a known GST basis (a label next to the price or the page's
 *   site-wide note), and the page's stock code matching the listing asked for. Anything else is
 *   reported and nothing recorded.
 * - CAPTCHA, two-factor prompts and challenges stop the run; nothing tries to get past them.
 * - Login failures are reported as fixed reasons; the site's own message is never passed on.
 */
import { ConnectorError, type WebResponse, type WebSession } from "./web-session";
import { allByClass, amountOf, basisOf, CAPTCHA_RE, decodeEntities, elementByClass, MFA_RE, textOf, type CatalogueEntry, type ParsedProductPage, type PriceBasis } from "./html";
import type { SupplierSite } from "./site";

export type WebNinjaShop = { key: string; name: string; baseUrl: string; envVar: string };

export const SWL_SHOP: WebNinjaShop = { key: "swl", name: "SWL", baseUrl: "https://www.swl.co.nz", envVar: "SWL_BASE_URL" };
export const VESTA_SHOP: WebNinjaShop = { key: "vesta", name: "Vesta Electrical", baseUrl: "https://www.vestaelectrical.co.nz", envVar: "VESTA_BASE_URL" };

export function blockOf(name: string, res: WebResponse): ConnectorError | null {
  const h = res.html.slice(0, 200_000);
  if (/cf-chl|challenge-platform|cf_chl_opt|<title>\s*(Just a moment|Attention Required)/i.test(h) && (res.status === 403 || res.status === 503 || res.status === 429 || /Just a moment/i.test(h)))
    return new ConnectorError("blocked", `${name}'s website asked for a browser security check. The connector stopped and did not try to get past it.`);
  if (res.status === 429) return new ConnectorError("rate_limited", `${name} asked us to slow down (too many requests). The connector stopped; try again later.`);
  return null;
}

/** The body class carries the account state on every WebNinja page. */
export function loggedInState(html: string): boolean | null {
  const body = html.match(/<body\b[^>]*class="([^"]*)"/i)?.[1] ?? "";
  if (/\bnon-logged-in\b/.test(body)) return false;
  if (/\blogged-in\b/.test(body) || /href="[^"]*\/logout\b/i.test(html)) return true;
  if (/<form\b[^>]*class="[^"]*\blogin\b/i.test(html) && /name="password"/i.test(html)) return false;
  return null;
}

/** The CSRF token a WebNinja form carries. */
export function csrfTokenOf(html: string, formClass: string): string | null {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  const form = forms.find((f) => new RegExp(`<form\\b[^>]*class="[^"]*\\b${formClass}\\b`, "i").test(f)) ?? forms.find((f) => /_csrf_token/.test(f));
  return form?.match(/name="_csrf_token"\s+value="([^"]+)"/i)?.[1] ?? form?.match(/value="([^"]+)"\s+name="_csrf_token"/i)?.[1] ?? null;
}

export function parseLoginForm(name: string, html: string): { token: string; action: string } | ConnectorError {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  const form = forms.find((f) => /name="password"/i.test(f) && /name="email"/i.test(f));
  if (!form) return new ConnectorError("login_form_changed", `${name}'s login page has changed and the login form could not be found. Nothing was submitted.`);
  if (CAPTCHA_RE.test(form)) return new ConnectorError("captcha", `${name}'s login form now shows a CAPTCHA. The connector stopped and did not try to get past it.`);
  const token = form.match(/name="_csrf_token"\s+value="([^"]+)"/i)?.[1];
  if (!token) return new ConnectorError("login_form_changed", `${name}'s login form is missing its security token. Nothing was submitted.`);
  const action = decodeEntities(form.match(/<form\b[^>]*\baction="([^"]*)"/i)?.[1] ?? "") || "/login";
  return { token, action };
}

export function loginFailureOf(name: string, html: string): ConnectorError {
  const errors = [...allByClass(html, "div", "alert"), ...allByClass(html, "div", "error"), ...allByClass(html, "div", "message"), ...allByClass(html, "ul", "errors"), ...allByClass(html, "p", "error")].map(textOf).join(" ");
  const t = errors.toLowerCase();
  if (CAPTCHA_RE.test(html) || /captcha/.test(t)) return new ConnectorError("captcha", `${name} asked for a CAPTCHA at login. The connector stopped and did not try to get past it.`);
  if (/too many|locked|temporarily|try again (in|later)|limit/.test(t)) return new ConnectorError("locked", `${name} has temporarily locked logins for this account (too many attempts). Wait before trying again.`);
  if (/no account|not (found|registered|recognised|recognized)|unknown|doesn.t exist|invalid email/.test(t)) return new ConnectorError("auth_failed", `${name} did not recognise the stored email address.`);
  if (/password|credentials|details|login/.test(t) && /incorrect|invalid|wrong|match|failed/.test(t)) return new ConnectorError("auth_failed", `${name} rejected the stored password.`);
  if (/pending|not (yet )?approved|awaiting|inactive|disabled|suspended|deactivated/.test(t)) return new ConnectorError("account_inactive", `${name} says the trade account is pending approval or disabled.`);
  if (/token|security|expired|session/.test(t)) return new ConnectorError("login_form_changed", `${name} rejected the login form's security token; try again.`);
  if (/required|empty|enter your/.test(t)) return new ConnectorError("auth_failed", `${name} says the stored login is incomplete (email or password missing).`);
  return new ConnectorError("auth_failed", `${name} did not accept the login and gave no reason the connector recognises.`);
}

export async function login(shop: WebNinjaShop, session: WebSession, credential: { username: string | null; secret: string }): Promise<void> {
  if (!credential.username) throw new ConnectorError("auth_failed", `The stored ${shop.name} login has no email address. Store the email and password again.`);
  const page = await session.request("/login");
  const blocked = blockOf(shop.name, page);
  if (blocked) throw blocked;
  if (loggedInState(page.html) === true) return;
  const form = parseLoginForm(shop.name, page.html);
  if (form instanceof ConnectorError) throw form;
  const res = await session.request(form.action, { method: "POST", form: { _csrf_token: form.token, email: credential.username, password: credential.secret } });
  const blockedAfter = blockOf(shop.name, res);
  if (blockedAfter) throw blockedAfter;
  if (MFA_RE.test(res.html) && loggedInState(res.html) !== true) throw new ConnectorError("mfa", `${shop.name} asked for a two-factor / verification code. The connector stopped; it does not handle or bypass that step.`);
  if (loggedInState(res.html) === true) return;
  throw loginFailureOf(shop.name, res.html);
}

// ---------- catalogue (search result tiles) ----------

/** Product tiles (li.product): the supplier's code (".model"), the name and the page address. No price is read here. */
export function parseTiles(html: string, origin: string): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<li\b[^>]*class="[^"]*\bproduct\b[^"]*\bproduct-(\d+)\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const tile = m[2];
    const nameEl = elementByClass(tile, "div", "name");
    const href = nameEl?.inner.match(/href="([^"]+)"/i)?.[1] ?? tile.match(/href="([^"]*\/product\/\d+[^"]*)"/i)?.[1];
    const modelEl = elementByClass(tile, "div", "model");
    const code = modelEl ? textOf(modelEl.inner).replace(/^stock code:\s*/i, "").trim() : "";
    if (!href || !code || seen.has(code)) continue;
    let url: string;
    try {
      url = new URL(decodeEntities(href), origin).toString();
    } catch {
      continue;
    }
    if (new URL(url).origin !== new URL(origin).origin) continue;
    seen.add(code);
    out.push({ id: Number(m[1]), sku: code, model: code, name: nameEl ? textOf(nameEl.inner) : code, url, type: "simple" });
  }
  return out;
}

export async function findInCatalogue(shop: WebNinjaShop, session: WebSession, q: { skus?: string[]; search?: string }): Promise<CatalogueEntry[]> {
  const terms = q.skus?.length ? q.skus : q.search ? [q.search] : [];
  const out: CatalogueEntry[] = [];
  for (const term of terms) {
    const page = await session.request("/search");
    const blocked = blockOf(shop.name, page);
    if (blocked) throw blocked;
    const token = csrfTokenOf(page.html, "search");
    if (!token) throw new ConnectorError("search_changed", `${shop.name}'s search form has changed (no security token); the catalogue could not be searched.`);
    const res = await session.request("/search", { method: "POST", form: { _csrf_token: token, keywords: term } });
    const blockedAfter = blockOf(shop.name, res);
    if (blockedAfter) throw blockedAfter;
    if (res.status !== 200) continue;
    for (const e of parseTiles(res.html, session.url("/"))) if (!out.some((x) => x.sku.toLowerCase() === e.sku.toLowerCase())) out.push(e);
  }
  return q.skus?.length ? out.filter((e) => q.skus!.some((s) => s.toLowerCase() === e.sku.toLowerCase())) : out;
}

// ---------- product pages ----------

export function siteBasisOf(html: string): PriceBasis | null {
  const notes = [...textOf(html).matchAll(/(all|our)\s+prices\s+(are\s+)?(shown\s+|displayed\s+|listed\s+)?(ex|excl|exclude|excludes|excluding|exclusive of|inc|incl|include|includes|including|inclusive of|\+)\s*(\.|\s)?\s*(of\s+)?gst/gi)].map((m) => m[0]);
  const bases = [...new Set(notes.map(basisOf).filter((b): b is PriceBasis => !!b))];
  return bases.length === 1 ? bases[0] : null;
}

export function parseProductPage(html: string): ParsedProductPage {
  const out: ParsedProductPage = { loggedIn: loggedInState(html), title: null, sku: null, stock: null, priceText: null, amount: null, wasAmount: null, suffixBasis: null, siteBasis: siteBasisOf(html), reason: null };
  // The product's own block: from its heading to the related products.
  const h1 = html.search(/<h1\b/i);
  const relatedAt = html.search(/class="[^"]*\brelated-products\b/i);
  const main = h1 >= 0 ? html.slice(h1, relatedAt > h1 ? relatedAt : undefined) : html;
  out.title = textOf(main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") || null;
  const modelEl = elementByClass(main, "div", "model");
  if (modelEl) {
    const valueEl = elementByClass(modelEl.inner, "div", "value");
    out.sku = textOf(valueEl ? valueEl.inner : modelEl.inner).replace(/^stock code:\s*/i, "").trim() || null;
  }
  const stockEl = elementByClass(main, "div", "stock") ?? elementByClass(main, "div", "availability") ?? elementByClass(main, "span", "stock");
  out.stock = stockEl ? textOf(stockEl.inner).replace(/^(stock|availability):\s*/i, "").slice(0, 80) || null : null;

  const block = elementByClass(main, "div", "price") ?? elementByClass(main, "span", "price");
  if (!block) return { ...out, reason: "No price is shown on the product page." };
  const text = textOf(block.inner);
  out.priceText = text.slice(0, 160) || null;
  if (/^\s*poa\b|price on application|login/i.test(text)) {
    if (out.loggedIn === false) return { ...out, loggedIn: false, reason: "The price is hidden (POA): the page was not served to a signed-in account." };
    return { ...out, reason: `The price is on application ("${out.priceText}"); nothing to record.` };
  }
  if (/\b(rrp|retail|msrp|recommended)\b/i.test(text)) return { ...out, reason: `The price is labelled as retail/RRP ("${out.priceText}"); not used as trade cost.` };
  if (/<del\b|<s\b|<strike\b|\b(was|now|save|previously)\b/i.test(block.inner)) return { ...out, reason: `The price shows a "was/now" or struck-through amount ("${out.priceText}"); not recorded.` };
  if (/\bfrom\b|\bup to\b|–|—/i.test(text.replace(/\s*\+\s*gst.*$/i, ""))) return { ...out, reason: `The price is a range or "from" price ("${out.priceText}"); not recorded.` };
  const amounts = [...text.matchAll(/\$\s?([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(\.[0-9]{1,2})?/g)].map((m) => amountOf(m[0]));
  if (amounts.length === 0) return { ...out, reason: `No amount could be read from the price ("${out.priceText ?? ""}").` };
  if (amounts.length > 1) return { ...out, reason: `More than one price is shown ("${out.priceText}"); not recorded.` };
  const amount = amounts[0];
  if (amount == null || !(amount > 0) || amount >= 100_000) return { ...out, reason: `The price could not be read as an amount ("${out.priceText}").` };
  out.suffixBasis = basisOf(text);
  out.amount = amount;
  return out;
}

export function webNinjaSite(shop: WebNinjaShop): SupplierSite {
  return {
    key: shop.key,
    name: shop.name,
    baseUrl: shop.baseUrl,
    envVar: shop.envVar,
    login: (session, credential) => login(shop, session, credential),
    findInCatalogue: (session, q) => findInCatalogue(shop, session, q),
    parseProductPage,
    blockOf: (res) => blockOf(shop.name, res),
  };
}

export const SWL_SITE = webNinjaSite(SWL_SHOP);
export const VESTA_SITE = webNinjaSite(VESTA_SHOP);
