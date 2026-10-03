/**
 * The IT Plus page parser: only an unambiguous, logged-in trade price with a known GST basis is
 * read; logged-out pages, RRP labels, ranges and missing GST labels give no price; login errors
 * never repeat the username; public catalogue JSON loses its prices. Amounts are TEST VALUES.
 */
import { describe, it, expect } from "vitest";
import {
  basisOf,
  blockOf,
  loginFailureOf,
  matchListing,
  modelKey,
  parseCatalogueJson,
  parseLoginForm,
  parseProductPage,
  resolveBasis,
  searchTermFor,
  brandWordsFor,
} from "@/lib/brain/suppliers/itplus";
import { ConnectorError, redact } from "@/lib/brain/suppliers/web-session";

const amt = (n: string) => `<span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">&#36;</span>${n}</bdi></span>`;
const SUFFIX = ' <small class="woocommerce-price-suffix">+ GST</small>';
const LOGGED_IN = '<script>var cartflows = {"is_logged_in":"1"};</script><a href="/my-account/customer-logout/">Log out</a>';
const BUNDLE_SETTINGS = '<script>var p = {"price_display_suffix":"+ GST","prices_include_tax":"no","tax_display_shop":"excl"};</script>';
const pageWith = (price: string, opts: { sku?: string; extra?: string; head?: string } = {}) =>
  `<html><head>${opts.head ?? LOGGED_IN}</head><body><div class="summary entry-summary"><h1 class="product_title entry-title">TP-Link VIGI VJB-240</h1>${price}
<p class="stock in-stock">12 in stock</p>${opts.extra ?? ""}<div class="product_meta"><span class="sku_wrapper">SKU: <span class="sku">${opts.sku ?? "VJB-240"}</span></span></div></div></body></html>`;

describe("IT Plus product pages", () => {
  it("reads a single logged-in trade price, ex GST from the '+ GST' label, with SKU and stock", () => {
    const p = parseProductPage(pageWith(`<p class="price">${amt("27.10")}${SUFFIX}</p>`));
    expect(p).toMatchObject({ loggedIn: true, amount: 27.1, suffixBasis: "ex", sku: "VJB-240", stock: "12 in stock", reason: null });
    expect(resolveBasis(p, null)).toEqual({ basis: "ex", from: "price label" });
  });

  it("takes the sale amount, not the struck-through one, and ignores screen-reader text", () => {
    const p = parseProductPage(
      pageWith(`<p class="price"><del aria-hidden="true">${amt("1,040.90")}</del> <span class="screen-reader-text">Original price was: $1,040.90.</span><ins aria-hidden="true">${amt("995.00")}</ins><span class="screen-reader-text">Current price is: $995.00.</span>${SUFFIX}</p>`),
    );
    expect(p.amount).toBe(995);
  });

  it("gives no price on the logged-out page (the real IT Plus markup)", () => {
    const p = parseProductPage(pageWith('<p class="price"><div><a href="https://www.itplus.co.nz/my-account/">Login to see prices</a></div></p>', { head: '<script>var c = {"is_logged_in":""};</script>' }));
    expect(p.loggedIn).toBe(false);
    expect(p.amount).toBeNull();
    expect(p.reason).toMatch(/not served to a logged-in account/);
  });

  it("refuses an RRP-labelled price, two prices, or a range", () => {
    expect(parseProductPage(pageWith(`<p class="price">RRP ${amt("49.00")}${SUFFIX}</p>`)).reason).toMatch(/retail\/RRP/);
    expect(parseProductPage(pageWith(`<p class="price">${amt("20.00")} ${amt("27.10")}${SUFFIX}</p>`)).reason).toMatch(/More than one price/);
    expect(parseProductPage(pageWith(`<p class="price">${amt("20.00")} – ${amt("27.10")}</p>`)).amount).toBeNull();
  });

  it("accepts a bundle's 'From:' price only when every bundled extra is optional", () => {
    const price = `<p class="price"><span class="from">From: </span>${amt("173.20")}${SUFFIX}</p>`;
    const optional = '<div class="cart" data-optional="yes"></div><div class="cart" data-optional="yes"></div>';
    expect(parseProductPage(pageWith(price, { extra: optional })).amount).toBe(173.2);
    expect(parseProductPage(pageWith(price, { extra: '<div class="cart" data-optional="yes"></div><div class="cart" data-optional="no"></div>' })).reason).toMatch(/range or "from" price/);
    expect(parseProductPage(pageWith(price)).reason).toMatch(/range or "from" price/);
  });

  it("needs a GST basis: the label, else the shop's tax setting from a logged-in page in the run", () => {
    const bare = parseProductPage(pageWith(`<p class="price">${amt("27.10")}</p>`));
    expect(bare.amount).toBe(27.1);
    expect(resolveBasis(bare, null)).toMatchObject({ basis: null, reason: expect.stringMatching(/ex or inc GST/) });
    expect(resolveBasis(bare, "ex")).toEqual({ basis: "ex", from: "shop tax setting" });
    const bundle = parseProductPage(pageWith(`<p class="price">${amt("27.10")}</p>`, { head: LOGGED_IN + BUNDLE_SETTINGS }));
    expect(bundle.siteBasis).toBe("ex");
    const conflict = parseProductPage(pageWith(`<p class="price">${amt("27.10")} <small class="woocommerce-price-suffix">incl. GST</small></p>`, { head: LOGGED_IN + BUNDLE_SETTINGS }));
    expect(resolveBasis(conflict, null)).toMatchObject({ basis: null, reason: expect.stringMatching(/disagrees/) });
  });

  it("classifies GST labels", () => {
    expect(basisOf("+ GST")).toBe("ex");
    expect(basisOf("excl. GST")).toBe("ex");
    expect(basisOf("Ex GST")).toBe("ex");
    expect(basisOf("incl. GST")).toBe("inc");
    expect(basisOf("inc GST")).toBe("inc");
    expect(basisOf("$27.10")).toBeNull();
  });
});

describe("IT Plus login", () => {
  const form = (extra = "") =>
    `<form class="woocommerce-form woocommerce-form-login login" method="post"><input name="username"/><input type="password" name="password"/>${extra}<input type="hidden" id="woocommerce-login-nonce" name="woocommerce-login-nonce" value="c0f467df80" /><input type="hidden" name="_wp_http_referer" value="/my-account/" /><button name="login">Log in</button></form>`;

  it("reads the WooCommerce login form and its nonce", () => {
    expect(parseLoginForm(form())).toEqual({ nonce: "c0f467df80", referer: "/my-account/", extra: {} });
  });

  it("stops at a CAPTCHA on the form instead of submitting", () => {
    const r = parseLoginForm(form('<div class="cf-turnstile" data-sitekey="0x4AAA"></div>'));
    expect(r).toBeInstanceOf(ConnectorError);
    expect((r as ConnectorError).code).toBe("captcha");
  });

  it("reports a rejected login with a fixed reason that never repeats the username", () => {
    const html = '<ul class="woocommerce-error"><li><strong>Error:</strong> The password you entered for the username <strong>chris@getsecure.example</strong> is incorrect.</li></ul>';
    const e = loginFailureOf(html);
    expect(e.code).toBe("auth_failed");
    expect(e.message).toBe("IT Plus rejected the stored password.");
    expect(e.message).not.toContain("chris@");
    expect(loginFailureOf('<ul class="woocommerce-error"><li>The username <strong>bob</strong> is not registered on this site.</li></ul>').message).toMatch(/did not recognise/);
    expect(loginFailureOf('<ul class="woocommerce-error"><li>Too many failed login attempts. Please try again in 20 minutes.</li></ul>').code).toBe("locked");
  });

  it("recognises a Cloudflare challenge", () => {
    expect(blockOf({ status: 403, url: "x", html: "<title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/x'></script>" })?.code).toBe("blocked");
    expect(blockOf({ status: 200, url: "x", html: "<p>fine</p>" })).toBeNull();
  });
});

describe("matching IT Plus listings to catalogue products", () => {
  const vigi = brandWordsFor("TP-Link", "TP-Link VIGI");
  const e = (sku: string) => ({ id: 1, sku, name: sku, url: `https://www.itplus.co.nz/products/${sku.toLowerCase()}/`, type: "simple" });

  it("normalises models and SKUs", () => {
    expect(modelKey("VIGI InSight S455(2.8mm)", vigi)).toBe(modelKey("S455-2.8", vigi));
    expect(modelKey("VIGI NVR1004H-4P", vigi)).toBe(modelKey("NVR1004H-4P", vigi));
    expect(searchTermFor("VIGI InSight S455(2.8mm)", vigi)).toBe("S455");
  });

  it("only an exact model match is automatic; near listings are offered to choose from", () => {
    expect(matchListing("VJB-240", vigi, [e("VJB-240-BLK"), e("VJB-240")]).match?.sku).toBe("VJB-240");
    const wd = matchListing("WD43PURZ", brandWordsFor("Western Digital", "WD Purple"), [e("WD43PURZ-SUP"), e("WD43PURZ-Inst")]);
    expect(wd.match).toBeNull();
    expect(wd.candidates.map((c) => c.sku)).toEqual(["WD43PURZ-SUP", "WD43PURZ-Inst"]);
    expect(matchListing("VIGI C340(2.8mm)", vigi, [e("C340-W")]).match).toBeNull();
  });

  it("drops every price field from the public catalogue JSON", () => {
    const json = JSON.stringify([{ id: 32701, sku: "VJB-240", name: "TP-Link VIGI VJB-240", type: "simple", permalink: "https://www.itplus.co.nz/products/tp-link-vigi-vjb-240/", prices: { price: "2710" } }]);
    const [entry] = parseCatalogueJson(json, "https://www.itplus.co.nz");
    expect(entry).toEqual({ id: 32701, sku: "VJB-240", name: "TP-Link VIGI VJB-240", url: "https://www.itplus.co.nz/products/tp-link-vigi-vjb-240/", type: "simple" });
    expect(JSON.stringify(entry)).not.toContain("2710");
    expect(parseCatalogueJson(JSON.stringify([{ id: 1, sku: "X", permalink: "https://evil.example/x" }]), "https://www.itplus.co.nz")).toEqual([]);
  });
});

describe("redaction", () => {
  it("removes usernames, passwords and cookie values, plain or URL-encoded", () => {
    expect(redact("user chris@x.nz pw p@ss w0rd! cookie abc123xyz", ["chris@x.nz", "p@ss w0rd!", "abc123xyz"])).toBe("user ••• pw ••• cookie •••");
    expect(redact("username=chris%40x.nz", ["chris@x.nz"])).toBe("username=•••");
  });
});
