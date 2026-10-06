/**
 * The Clear Digital and WebNinja page parsers: only an unambiguous signed-in price with a known
 * GST basis is read; a branch-stock table is read for stock and, where it carries a price column,
 * for the price; an ex/inc pair must agree; POA, RRP and two prices give nothing; a page that gives
 * no price carries a sketch (class names and amounts, never other text). Amounts are TEST VALUES.
 */
import { describe, it, expect } from "vitest";
import { parseProductPage as parseClearDigital, loggedInState as cdLoggedIn } from "@/lib/brain/suppliers/cleardigital";
import { parseProductPage as parseWebNinja, loggedInState as wnLoggedIn } from "@/lib/brain/suppliers/webninja";
import { brandWordsFor, matchListing, pageSketch, type CatalogueEntry } from "@/lib/brain/suppliers/html";

const cdPage = (priceBlock: string, stockTab: string, opts: { note?: boolean; head?: string } = {}) =>
  `<html><head>${opts.head ?? ""}</head><body><div id="header"><a href="/members/logout.php?">Sign out</a><p>Welcome back, Chris (account 4471)</p></div>
${opts.note === false ? "" : '<p class="gst-note">All prices exclude GST.</p>'}<h1>Ajax BulletCam (8 Mp/4 mm)</h1><h4 class="mb-5">Code: Ajax BulletCam (8 Mp/4 mm)</h4><div class="col">${priceBlock}</div>
<div id="description-tab-desc"><p>Desc</p></div><div id="description-tab-related"><ul><li><div class="box product-type-product"><div class="options"><div class="options-price">$999.00 + GST</div></div></div></li></ul></div>
<div id="description-tab-stock"><div class="product-stock">${stockTab}</div></div><div class="footer">Clear Digital · Auckland</div></body></html>`;

describe("Clear Digital product pages", () => {
  it("reads the price from the signed-in price block with its '+ GST' label and ignores the related tiles", () => {
    const p = parseClearDigital(cdPage('<p class="button-wrapper"><div class="options-price">$151.30 + GST</div></p>', "<p>In stock</p>"));
    expect(p).toMatchObject({ loggedIn: true, sku: "Ajax BulletCam (8 Mp/4 mm)", amount: 151.3, suffixBasis: "ex", stock: "In stock", reason: null });
  });

  it("reads a branch-stock table (Product Code | AKL | WLG | CHCH), and a price column in it when that is where the price is", () => {
    const table = `<table><tr><th>Product Code</th><th>AKL North Island</th><th>WLG North Island</th><th>CHCH South Island</th><th>Price</th></tr>
<tr><td>Ajax BulletCam (8 Mp/4 mm)</td><td>12</td><td>0</td><td>3</td><td>$151.30</td></tr></table>`;
    const p = parseClearDigital(cdPage("", table));
    expect(p).toMatchObject({ amount: 151.3, stock: "AKL 12 · WLG 0 · CHCH 3", siteBasis: "ex" });
    expect(p.suffixBasis).toBeNull(); // the site-wide note settles the basis
    // Without a price column, the one dollar amount in the product region is still the price.
    const p2 = parseClearDigital(cdPage('<div class="pricing"><span class="your-price">Your price $151.30</span></div>', table.replace("<th>Price</th>", "").replace("<td>$151.30</td>", "")));
    expect(p2).toMatchObject({ amount: 151.3, stock: "AKL 12 · WLG 0 · CHCH 3" });
  });

  it("gives nothing, with a sketch for the developer that never carries the account header, when no price is shown or two are", () => {
    const none = parseClearDigital(cdPage('<p class="button-wrapper"><a class="button">Add to cart</a></p>', "<p>In stock</p>"));
    expect(none.amount).toBeNull();
    expect(none.reason).toMatch(/No price is shown/);
    expect(none.sketch).toMatch(/classes:/);
    expect(none.sketch).not.toMatch(/Chris|4471|Welcome/);
    const two = parseClearDigital(cdPage('<div class="options-price">$151.30 + GST <span class="rrp-strike">$199.00</span></div>', "<p>In stock</p>"));
    expect(two.amount).toBeNull();
    expect(two.reason).toMatch(/More than one price/);
    const rrp = parseClearDigital(cdPage('<div class="options-price">RRP $199.00</div>', "<p>In stock</p>"));
    expect(rrp.reason).toMatch(/RRP/);
    expect(rrp.sketch).toMatch(/amounts: .*RRP \$199\.00/);
  });

  it("never reads the public Open Graph figure, and knows a guest page", () => {
    const guest = parseClearDigital(cdPage('<p class="button-wrapper"><a href="/members/login.php?">Login for pricing</a></p>', "<p>Please <a>Login</a> to view Stock information.</p>", { head: '<meta property="og:product:sale_price:amount" content="46.93"/>' }).replace('<a href="/members/logout.php?">Sign out</a>', ""));
    expect(guest).toMatchObject({ loggedIn: false, amount: null, stock: null });
    expect(cdLoggedIn('<body><form name="signin"></form></body>')).toBe(false);
  });
});

const wnPage = (price: string, extra = "", cls = "logged-in customer-type-w") =>
  `<html><body class="shop_product_view ${cls} show-prices"><div id="header"><a href="https://x/logout">Logout</a> Hello trade@example.com</div>
<h1>TP-Link VIGI NVR1004H-4P</h1><div class="model"><div class="model-label">Stock Code:</div><div class="value">47970</div></div>${price}${extra}
<div class="related-products"><ul><li class="product product-9"><div class="price">$5.00</div></li></ul></div></body></html>`;

describe("WebNinja (SWL / Vesta Electrical) product pages", () => {
  it("reads an ex/inc pair that agrees as the ex-GST price, and refuses a pair that does not", () => {
    const ok = parseWebNinja(wnPage('<div class="price"><span class="price-ex">$158.00 ex GST</span> <span class="price-inc">$181.70 inc GST</span></div>'));
    expect(ok).toMatchObject({ sku: "47970", amount: 158, suffixBasis: "ex", loggedIn: true, reason: null });
    const bad = parseWebNinja(wnPage('<div class="price"><span>$158.00 ex GST</span> <span>$170.00 inc GST</span></div>'));
    expect(bad.amount).toBeNull();
    expect(bad.reason).toMatch(/More than one price/);
    expect(bad.sketch).toMatch(/classes:/);
    expect(bad.sketch).not.toMatch(/trade@example\.com/);
  });

  it("finds a price-classed block that is not called exactly 'price', or the one amount on the page", () => {
    const wrapper = parseWebNinja(wnPage('<div class="product-price-wrapper"><span class="your-price">$158.00</span> <span class="tax-label">excl. GST</span></div>'));
    expect(wrapper).toMatchObject({ amount: 158, suffixBasis: "ex" });
    const lone = parseWebNinja(wnPage('<div class="buy"><strong>Trade: $158.00 + GST</strong></div>'));
    expect(lone).toMatchObject({ amount: 158, suffixBasis: "ex" });
  });

  it("POA, a guest page and a stock line", () => {
    expect(parseWebNinja(wnPage('<div class="price">POA</div>')).reason).toMatch(/on application/);
    const guest = parseWebNinja(wnPage('<div class="price">POA</div>', "", "non-logged-in"));
    expect(guest).toMatchObject({ loggedIn: false, amount: null });
    expect(parseWebNinja(wnPage('<div class="price">$158.00 ex GST</div>', '<div class="stock"><span>Stock:</span> Auckland 12</div>')).stock).toBe("Auckland 12");
    expect(wnLoggedIn('<body class="x non-logged-in">')).toBe(false);
  });
});

describe("matching listings to catalogue products", () => {
  const e = (sku: string, name: string, model?: string): CatalogueEntry => ({ id: 1, sku, name, model: model ?? null, url: "https://x/p", type: "simple" });

  it("a short word in a name ('Dome') is never a close match; the model as one word of the name is", () => {
    const words = brandWordsFor("Ajax Systems", "Ajax");
    const swl = [e("33194", "Provision-ISR DMA-380IPEN-28-V3: Eye-Sight 8MP Mini Dome", "33194"), e("33224", "Provision-ISR Dome Cover for Mini Domes", "33224")];
    expect(matchListing("DomeCam Mini (5 Mp/2.8 mm)", words, swl)).toEqual({ match: null, candidates: [] });
    expect(matchListing("VIGI NVR1004H-4P", brandWordsFor("TP-Link", "TP-Link VIGI"), [e("47970", "TP-Link VIGI NVR1004H-4P: 4 Channel PoE+ NVR", "47970")]).match?.sku).toBe("47970");
  });

  it("Ajax: the supplier's code is the product name; a different lens is close, the same lens exact", () => {
    const words = brandWordsFor("Ajax Systems", "Ajax");
    const cd = [e("Ajax BulletCam (8 Mp/2.8 mm)", "Ajax BulletCam (8 Mp/2.8 mm)"), e("Ajax BulletCam (8 Mp/4 mm)", "Ajax BulletCam (8 Mp/4 mm)")];
    const m = matchListing("BulletCam (8 Mp/4 mm)", words, cd);
    expect(m.match?.sku).toBe("Ajax BulletCam (8 Mp/4 mm)");
    const only28 = matchListing("BulletCam (8 Mp/4 mm)", words, [cd[0]]);
    expect(only28.match).toBeNull();
    expect(only28.candidates.map((c) => c.sku)).toEqual(["Ajax BulletCam (8 Mp/2.8 mm)"]);
  });

  it("a page sketch lists classes, headings and amounts only", () => {
    const sk = pageSketch('<div class="a b"><table><tr><th>AKL</th></tr></table><p>Trade price $12.50 ex GST for Chris Smith</p></div>');
    expect(sk).toMatch(/classes: a b/);
    expect(sk).toMatch(/table headings: AKL/);
    expect(sk).toMatch(/\$12\.50/);
  });
});
