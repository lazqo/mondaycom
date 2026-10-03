/**
 * A stand-in for www.itplus.co.nz that behaves like its WooCommerce shop: a login form with a
 * nonce, "Login to see prices" for guests, trade prices with a "+ GST" suffix for a logged-in
 * account, bundles with optional extras ("From:"), a public Store API whose price fields differ
 * from the trade price (so a test can prove they are never used), and switchable CAPTCHA,
 * two-factor and Cloudflare challenge modes. All values are TEST VALUES, not real IT Plus prices.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type MockProduct = {
  sku: string;
  slug: string;
  name: string;
  type: "simple" | "bundle";
  /** Trade price shown to the logged-in account, ex GST. */
  trade: number;
  /** A sale price (shown as <del>trade</del><ins>sale</ins>). */
  sale?: number;
  /** Price in the public Store API (deliberately different). */
  publicPrice: number;
  stock: string;
  /** Extra text shown in the price block, e.g. "RRP". */
  priceLabel?: string;
  /** Leave out the "+ GST" suffix and the shop settings. */
  noBasis?: boolean;
};

export type MockState = {
  username: string;
  password: string;
  mode: "normal" | "captcha" | "mfa" | "cloudflare" | "pending_account";
  products: MockProduct[];
  /** Log every request (method, path, whether a session cookie was sent) for assertions. */
  log: { method: string; path: string; loggedIn: boolean; body?: string }[];
  /** Expire the session after this many logged-in product page views. */
  dropSessionAfter?: number;
};

const NONCE = "a1b2c3d4e5";

function page(body: string, loggedIn: boolean, extraHead = "") {
  return `<!doctype html><html><head><title>IT Plus</title>${extraHead}<script>var cartflows = {"is_logged_in":"${loggedIn ? "1" : ""}","woocommerce_login_nonce":"${NONCE}"};</script></head>
<body class="${loggedIn ? "logged-in " : ""}woocommerce">${loggedIn ? '<a href="/my-account/customer-logout/?_wpnonce=zz">Log out</a>' : ""}${body}</body></html>`;
}

const money = (n: number) => `<span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">&#36;</span>${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</bdi></span>`;

function productPage(p: MockProduct, loggedIn: boolean) {
  const settings = p.noBasis ? "" : `<script>var wc_bundle_params = {"price_display_suffix":"+ GST","prices_include_tax":"no","tax_display_shop":"excl","calc_taxes":"yes"};</script>`;
  const suffix = p.noBasis ? "" : ' <small class="woocommerce-price-suffix">+ GST</small>';
  let price: string;
  if (!loggedIn) price = '<p class="price"><div><a href="/my-account/">Login to see prices</a></div></p>';
  else if (p.sale != null)
    price = `<p class="price"><del aria-hidden="true">${money(p.trade)}</del> <span class="screen-reader-text">Original price was: $${p.trade}.</span><ins aria-hidden="true">${money(p.sale)}</ins><span class="screen-reader-text">Current price is: $${p.sale}.</span>${suffix}</p>`;
  else price = `<p class="price">${p.priceLabel ? `${p.priceLabel} ` : ""}${p.type === "bundle" ? '<span class="from">From: </span>' : ""}${money(p.trade)}${suffix}</p>`;
  const bundled =
    p.type === "bundle"
      ? `<form class="cart bundle_form"><div class="bundled_product"><label class="bundled_product_optional_checkbox">Add for <span class="price">${loggedIn ? money(370) : '<div><a href="/my-account/">Login to see prices</a></div>'}</span></label><div class="cart" data-title="Western Digital WD43PURZ-Inst" data-optional="yes" data-type="simple"></div></div>
<div class="bundled_product"><div class="cart" data-title="TP-Link VIGI App" data-optional="yes" data-type="simple"></div></div></form>`
      : "";
  return page(
    `${settings}<div class="product"><div class="summary entry-summary"><h1 class="product_title entry-title">${p.name}</h1>${price}
<p class="stock ${/out/i.test(p.stock) ? "out-of-stock" : "in-stock"}">${p.stock}</p>${bundled}
<div class="product_meta"><span class="sku_wrapper">SKU: <span class="sku">${p.sku}</span></span></div></div></div>`,
    loggedIn,
  );
}

const loginForm = (captcha: boolean) => `<form class="woocommerce-form woocommerce-form-login login" method="post">
<input type="text" name="username" id="username" /><input type="password" name="password" id="password" />
${captcha ? '<div class="g-recaptcha" data-sitekey="6Lc_test"></div>' : ""}
<input type="hidden" id="woocommerce-login-nonce" name="woocommerce-login-nonce" value="${NONCE}" /><input type="hidden" name="_wp_http_referer" value="/my-account/" />
<button type="submit" name="login" value="Log in">Log in</button></form>`;

export async function startItPlusMock(state: MockState, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions = new Set<string>();
  let views = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = req.headers.cookie ?? "";
    const token = cookie.match(/wordpress_logged_in_test=([^;]+)/)?.[1];
    let loggedIn = !!token && sessions.has(token);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.log.push({ method: req.method ?? "GET", path: url.pathname + url.search, loggedIn, ...(req.method === "POST" ? { body } : {}) });
      const send = (status: number, html: string, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { "Content-Type": html.startsWith("[") || html.startsWith("{") ? "application/json" : "text/html; charset=UTF-8", ...headers });
        res.end(html);
      };
      if (state.mode === "cloudflare") return send(403, '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>');

      if (url.pathname === "/my-account/" && req.method === "GET") {
        if (loggedIn) return send(200, page('<nav class="woocommerce-MyAccount-navigation">Dashboard</nav>', true));
        return send(200, page(loginForm(state.mode === "captcha"), false));
      }
      if (url.pathname === "/my-account/" && req.method === "POST") {
        const f = new URLSearchParams(body);
        if (f.get("woocommerce-login-nonce") !== NONCE) return send(200, page(`<ul class="woocommerce-error" role="alert"><li>Security check failed.</li></ul>${loginForm(false)}`, false));
        if (f.get("username") !== state.username)
          return send(200, page(`<ul class="woocommerce-error" role="alert"><li><strong>Error:</strong> The username <strong>${f.get("username")}</strong> is not registered on this site.</li></ul>${loginForm(false)}`, false));
        if (f.get("password") !== state.password)
          return send(
            200,
            page(`<ul class="woocommerce-error" role="alert"><li><strong>Error:</strong> The password you entered for the username <strong>${f.get("username")}</strong> is incorrect. <a href="/lost-password/">Lost your password?</a></li></ul>${loginForm(false)}`, false),
          );
        if (state.mode === "pending_account") return send(200, page(`<ul class="woocommerce-error"><li>Your account is pending approval by IT Plus.</li></ul>${loginForm(false)}`, false));
        if (state.mode === "mfa") return send(200, page('<form method="post"><p>Enter the verification code from your authenticator app</p><input name="two_factor_code" /></form>', false));
        const t = `tok${Math.random().toString(36).slice(2)}`;
        sessions.add(t);
        return send(302, "", { Location: "/my-account/", "Set-Cookie": [`wordpress_logged_in_test=${t}; path=/; HttpOnly`, `wordpress_sec_test=sec${t}; path=/; HttpOnly`] });
      }
      if (url.pathname === "/wp-json/wc/store/v1/products") {
        const skus = url.searchParams.get("sku")?.split(",").map((s) => s.toLowerCase());
        const q = url.searchParams.get("search")?.toLowerCase();
        const hits = state.products.filter((p) => (skus ? skus.includes(p.sku.toLowerCase()) : q ? `${p.name} ${p.sku}`.toLowerCase().includes(q) : true));
        return send(
          200,
          JSON.stringify(
            hits.map((p, i) => ({
              id: 1000 + i,
              name: p.name,
              sku: p.sku,
              type: p.type,
              permalink: `http://${req.headers.host}/products/${p.slug}/`,
              prices: { price: String(Math.round(p.publicPrice * 100)), regular_price: String(Math.round(p.publicPrice * 100)), currency_code: "NZD", currency_minor_unit: 2 },
            })),
          ),
        );
      }
      const m = url.pathname.match(/^\/products\/([^/]+)\/$/);
      if (m) {
        const p = state.products.find((x) => x.slug === m[1]);
        if (!p) return send(404, page("<h1>Not found</h1>", loggedIn));
        if (loggedIn && state.dropSessionAfter != null && ++views > state.dropSessionAfter) {
          sessions.clear();
          loggedIn = false;
        }
        return send(200, productPage(p, loggedIn));
      }
      return send(404, page("<h1>Not found</h1>", loggedIn));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) };
}
