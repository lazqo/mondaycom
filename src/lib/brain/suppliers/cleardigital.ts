/**
 * Clear Digital (www.cleardigital.co.nz) trade-price connector. A custom shop ("zulu") that shows
 * "Login for pricing" to guests and hides stock until a member signs in.
 *
 * Rules this file keeps (the same as every connector):
 * - The only cost it reads is the price on a product page fetched in a verified logged-in session.
 *   The page's public Open Graph meta (og:product:…:amount) is a public figure: it is never read,
 *   never stored and never used as cost.
 * - A price is read only when it is unambiguous: exactly one amount in the product's own price
 *   block, no RRP/retail/"was" wording, a known GST basis (a label next to the price, or the
 *   site-wide "prices exclude GST" note on the same logged-in page), and the page's product code
 *   matching the one asked for. Anything else is reported and nothing recorded.
 * - CAPTCHA, two-factor prompts and challenges stop the run; nothing tries to get past them.
 * - Login failures are reported as fixed reasons; the site's own message is never passed on.
 */
import { ConnectorError, type WebResponse, type WebSession } from "./web-session";
import { allByClass, amountsIn, basisOf, CAPTCHA_RE, decodeEntities, elementByClass, MFA_RE, pageSketch, priceBlocks, textOf, type CatalogueEntry, type ParsedProductPage, type PriceBasis } from "./html";
import type { SupplierSite } from "./site";

export const CLEARDIGITAL_CONNECTOR = "cleardigital";
export const CLEARDIGITAL_BASE_URL = "https://www.cleardigital.co.nz";
const NAME = "Clear Digital";

/** A Cloudflare / challenge page or rate limiting: stop, never work around it. */
export function blockOf(res: WebResponse): ConnectorError | null {
  const h = res.html.slice(0, 200_000);
  if (/cf-chl|challenge-platform|cf_chl_opt|<title>\s*(Just a moment|Attention Required)/i.test(h) && (res.status === 403 || res.status === 503 || res.status === 429 || /Just a moment/i.test(h)))
    return new ConnectorError("blocked", `${NAME}'s website asked for a browser security check. The connector stopped and did not try to get past it.`);
  if (res.status === 429) return new ConnectorError("rate_limited", `${NAME} asked us to slow down (too many requests). The connector stopped; try again later.`);
  return null;
}

/** Logged in (true), clearly not (false: the sign-in form or "Login for pricing" is shown), or can't tell (null). */
export function loggedInState(html: string): boolean | null {
  if (/\/members\/(logout|signout|account|dashboard)\b/i.test(html) || /<body[^>]*class="[^"]*\b(logged-in|member)\b/i.test(html)) return true;
  if (/<form\b[^>]*name="signin"/i.test(html) || /Login for pricing/i.test(html) || /Login<\/a>\s*to view Stock/i.test(html)) return false;
  return null;
}

export type SignInForm = { action: string; extra: Record<string, string> };

/** The members sign-in form, or the reason it can't be used. */
export function parseSignInForm(html: string): SignInForm | ConnectorError {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  const form = forms.find((f) => /name="password"/i.test(f) && /name="email"/i.test(f));
  if (!form) return new ConnectorError("login_form_changed", `${NAME}'s sign-in page has changed and the form could not be found. Nothing was submitted.`);
  if (CAPTCHA_RE.test(form)) return new ConnectorError("captcha", `${NAME}'s sign-in form now shows a CAPTCHA. The connector stopped and did not try to get past it.`);
  const action = decodeEntities(form.match(/<form\b[^>]*\baction="([^"]*)"/i)?.[1] ?? "") || "/members/login.php";
  const extra: Record<string, string> = {};
  for (const m of form.matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)) {
    const name = m[0].match(/name="([^"]+)"/i)?.[1];
    const value = m[0].match(/value="([^"]*)"/i)?.[1] ?? "";
    if (name && !["email", "password"].includes(name)) extra[name] = decodeEntities(value);
  }
  if (!extra.action) extra.action = "signin";
  return { action, extra };
}

/** A fixed, credential-free reason for a rejected sign-in. */
export function loginFailureOf(html: string): ConnectorError {
  const errors = [...allByClass(html, "div", "alert-danger"), ...allByClass(html, "div", "alert-error"), ...allByClass(html, "div", "error"), ...allByClass(html, "div", "note_box"), ...allByClass(html, "p", "error")].map(textOf).join(" ");
  const t = errors.toLowerCase();
  if (CAPTCHA_RE.test(html) || /captcha/.test(t)) return new ConnectorError("captcha", `${NAME} asked for a CAPTCHA at sign-in. The connector stopped and did not try to get past it.`);
  if (/too many|locked|temporarily|try again (in|later)|limit/.test(t)) return new ConnectorError("locked", `${NAME} has temporarily locked sign-ins for this account (too many attempts). Wait before trying again.`);
  if (/reset your password|first time/.test(t) && /password/.test(t) && !/incorrect|invalid|wrong/.test(t)) return new ConnectorError("auth_failed", `${NAME} says the password must be reset on its new website before it can be used.`);
  if (/no account|not (found|registered|recognised|recognized)|unknown|doesn.t exist|invalid email/.test(t)) return new ConnectorError("auth_failed", `${NAME} did not recognise the stored email address.`);
  if (/password|credentials|details/.test(t) && /incorrect|invalid|wrong|match/.test(t)) return new ConnectorError("auth_failed", `${NAME} rejected the stored password.`);
  if (/pending|not (yet )?approved|awaiting|inactive|disabled|suspended|deactivated/.test(t)) return new ConnectorError("account_inactive", `${NAME} says the trade account is pending approval or disabled.`);
  if (/required|empty|enter your/.test(t)) return new ConnectorError("auth_failed", `${NAME} says the stored login is incomplete (email or password missing).`);
  return new ConnectorError("auth_failed", `${NAME} did not accept the login and gave no reason the connector recognises.`);
}

const LOGIN_PATH = "/members/login.php";

/** Sign in with the stored trade login. Throws a ConnectorError with a credential-free reason on failure. */
export async function login(session: WebSession, credential: { username: string | null; secret: string }): Promise<void> {
  if (!credential.username) throw new ConnectorError("auth_failed", `The stored ${NAME} login has no email address. Store the email and password again.`);
  const page = await session.request(LOGIN_PATH);
  const blocked = blockOf(page);
  if (blocked) throw blocked;
  if (loggedInState(page.html) === true) return;
  const form = parseSignInForm(page.html);
  if (form instanceof ConnectorError) throw form;
  const res = await session.request(form.action || LOGIN_PATH, { method: "POST", form: { ...form.extra, email: credential.username, password: credential.secret, submit: "" } });
  const blockedAfter = blockOf(res);
  if (blockedAfter) throw blockedAfter;
  if (MFA_RE.test(res.html) && loggedInState(res.html) !== true) throw new ConnectorError("mfa", `${NAME} asked for a two-factor / verification code. The connector stopped; it does not handle or bypass that step.`);
  if (loggedInState(res.html) === true) return;
  if (/<form\b[^>]*name="signin"/i.test(res.html)) throw loginFailureOf(res.html);
  // Neither the sign-in form nor a logged-in marker: confirm on a product listing before trusting it.
  const check = await session.request("/?search=camera");
  if (loggedInState(check.html) === true) return;
  if (loggedInState(check.html) === false) throw loginFailureOf(res.html);
  throw new ConnectorError("auth_failed", `${NAME} did not show the account as signed in after the login; nothing was read.`);
}

// ---------- catalogue (search tiles) ----------

/** Product tiles on a search or category page: code, name and page address. No price is read here. */
export function parseTiles(html: string, origin: string): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<div class="box product-type-product">([\s\S]*?)<\/li>/gi)) {
    const tile = m[1];
    const href = tile.match(/href="(\/product\/(\d+)\/[^"]*\/)"/i);
    const sku = tile.match(/<p class=['"]sku['"]>\s*Code:\s*([^<]+)<\/p>/i)?.[1];
    const name = elementByClass(tile, "div", "title");
    if (!href || !sku) continue;
    const code = textOf(sku).trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ id: Number(href[2]), sku: code, model: code, name: name ? textOf(name.inner.replace(/<p class=['"]sku['"]>[\s\S]*?<\/p>/i, " ")) : code, url: new URL(href[1], origin).toString(), type: "simple" });
  }
  return out;
}

export async function findInCatalogue(session: WebSession, q: { skus?: string[]; search?: string }): Promise<CatalogueEntry[]> {
  const terms = q.skus?.length ? q.skus : q.search ? [q.search] : [];
  const out: CatalogueEntry[] = [];
  for (const term of terms) {
    const res = await session.request(`/?search=${encodeURIComponent(term)}`);
    const blocked = blockOf(res);
    if (blocked) throw blocked;
    if (res.status !== 200) continue;
    for (const e of parseTiles(res.html, session.url("/"))) if (!out.some((x) => x.sku.toLowerCase() === e.sku.toLowerCase())) out.push(e);
  }
  // Asked by SKU: only the exact codes count.
  return q.skus?.length ? out.filter((e) => q.skus!.some((s) => s.toLowerCase() === e.sku.toLowerCase())) : out;
}

// ---------- product pages ----------

/** The site-wide GST note on a page ("All prices exclude GST"), if it carries one. */
export function siteBasisOf(html: string): PriceBasis | null {
  const notes = [...textOf(html).matchAll(/(all|our)\s+prices\s+(are\s+)?(shown\s+|displayed\s+|listed\s+)?(ex|excl|exclude|excludes|excluding|exclusive of|inc|incl|include|includes|including|inclusive of|\+)\s*(\.|\s)?\s*(of\s+)?gst/gi)].map((m) => m[0]);
  const bases = [...new Set(notes.map(basisOf).filter((b): b is PriceBasis => !!b))];
  return bases.length === 1 ? bases[0] : null;
}

/** The cells of each row of the first table in a fragment, as text. */
function tableRows(html: string): string[][] {
  const table = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => textOf(c[1])));
}

const BRANCH = (h: string) => h.replace(/\b(north|south)\s+island\b/gi, "").replace(/\s+/g, " ").trim();

export function parseProductPage(html: string): ParsedProductPage {
  const out: ParsedProductPage = { loggedIn: loggedInState(html), title: null, sku: null, stock: null, priceText: null, amount: null, wasAmount: null, suffixBasis: null, siteBasis: siteBasisOf(html), reason: null };
  // The product's own block: from its heading to the description tabs; related-product tiles sit after that.
  const h1 = html.search(/<h1\b/i);
  const tabsAt = html.search(/id="description-tab-/i);
  const main = h1 >= 0 ? html.slice(h1, tabsAt > h1 ? tabsAt : undefined) : html;
  out.title = textOf(main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "") || null;
  out.sku = textOf(main.match(/Code:\s*([^<]+)</i)?.[1] ?? "").trim() || null;
  // The stock tab: a sentence for guests, a branch table (Product Code | AKL | WLG | CHCH …) when signed in.
  const stockStart = html.search(/id="description-tab-stock"/i);
  const stockEnd = stockStart >= 0 ? html.indexOf('id="description-tab-', stockStart + 10) : -1;
  const stockRegion = stockStart >= 0 ? html.slice(stockStart, stockEnd > stockStart ? stockEnd : stockStart + 20_000) : "";
  const stockEl = elementByClass(stockRegion, "div", "product-stock");
  const stockTab = stockEl ? stockEl.inner : stockRegion.replace(/<div class="footer"[\s\S]*$/i, "").replace(/<\/body>[\s\S]*$/i, "");
  const rows = tableRows(stockTab);
  const tablePrice: { text: string; amount: number }[] = [];
  if (rows.length >= 2) {
    const head = rows[0];
    const row = rows.slice(1).find((r) => out.sku && r[0]?.toLowerCase() === out.sku.toLowerCase()) ?? (rows.length === 2 ? rows[1] : null);
    if (row) {
      const stockCells: string[] = [];
      head.forEach((h, n) => {
        const v = row[n] ?? "";
        if (/price|cost/i.test(h)) {
          for (const a of amountsIn(v)) tablePrice.push({ text: `${h} ${v}`, amount: a.amount });
        } else if (!/product\s*code|^code$|model|description/i.test(h) && v) stockCells.push(`${BRANCH(h)} ${v}`);
      });
      out.stock = stockCells.join(" · ").slice(0, 120) || null;
    }
  } else {
    const stockText = stockTab ? textOf(stockTab.replace(/^[^>]*>/, "")) : "";
    out.stock = stockText && !/login/i.test(stockText) ? stockText.slice(0, 80) : null;
  }

  if (/Login for pricing/i.test(main)) return { ...out, loggedIn: false, reason: "The price is hidden: the page was not served to a signed-in account." };
  const region = main + stockTab;
  const sketch = () => pageSketch(region);
  // Where the price may be: a price-classed element in the product block, the stock table's price
  // column, or, failing those, the one and only dollar amount in the product region.
  const blocks = priceBlocks(main).map((b) => ({ text: textOf(b.inner), amounts: amountsIn(textOf(b.inner)) })).filter((b) => b.amounts.length);
  let text: string;
  let amounts: number[];
  if (blocks.length) {
    text = blocks[0].text;
    amounts = [...new Set(blocks.flatMap((b) => b.amounts.map((a) => a.amount)))];
  } else if (tablePrice.length) {
    text = tablePrice.map((t) => t.text).join(" ");
    amounts = [...new Set(tablePrice.map((t) => t.amount))];
  } else {
    const all = amountsIn(textOf(region));
    if (!all.length) return { ...out, reason: "No price is shown on the product page.", sketch: sketch() };
    text = all.map((a) => a.around).join(" ");
    amounts = [...new Set(all.map((a) => a.amount))];
  }
  out.priceText = text.slice(0, 160) || null;
  if (/\b(rrp|retail|msrp|recommended)\b/i.test(text)) return { ...out, reason: `The price is labelled as retail/RRP ("${out.priceText}"); not used as trade cost.`, sketch: sketch() };
  if (/<del\b|<s\b|<strike\b/i.test(main) || /\b(was|now|save|previously)\b/i.test(text)) return { ...out, reason: `The price shows a "was/now" or struck-through amount ("${out.priceText}"); not recorded.`, sketch: sketch() };
  if (/\bfrom\b|\bup to\b|–|—/i.test(text.replace(/\s*\+\s*gst.*$/i, ""))) return { ...out, reason: `The price is a range or "from" price ("${out.priceText}"); not recorded.`, sketch: sketch() };
  if (amounts.length > 1) return { ...out, reason: `More than one price is shown ("${out.priceText}"); not recorded.`, sketch: sketch() };
  const amount = amounts[0];
  if (amount == null || !(amount > 0) || amount >= 100_000) return { ...out, reason: `The price could not be read as an amount ("${out.priceText}").`, sketch: sketch() };
  out.suffixBasis = basisOf(text);
  out.amount = amount;
  if (!out.suffixBasis && !out.siteBasis) out.sketch = sketch();
  return out;
}

export const CLEARDIGITAL_SITE: SupplierSite = { key: CLEARDIGITAL_CONNECTOR, name: NAME, baseUrl: CLEARDIGITAL_BASE_URL, envVar: "CLEARDIGITAL_BASE_URL", login, findInCatalogue, parseProductPage, blockOf };
