/**
 * A stand-in for www.cleardigital.co.nz: a members sign-in form (email/password/action=signin),
 * "Login for pricing" and hidden stock for guests, a price block with a GST label for a signed-in
 * member, site-wide search on /?search=, product pages at /product/<id>/<slug>/ whose head carries
 * a public og:product price (so a test can prove it is never used), and switchable CAPTCHA,
 * two-factor and challenge modes. All values are TEST VALUES, not real Clear Digital prices.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type CdProduct = {
  id: number;
  code: string;
  slug: string;
  name: string;
  /** Trade price shown to the signed-in member, as the site prints it (e.g. "$151.30 + GST"). */
  priceHtml: string;
  /** The public Open Graph figure (deliberately different). */
  publicPrice: number;
  stock: string;
};

export type CdState = {
  email: string;
  password: string;
  mode: "normal" | "captcha" | "mfa" | "cloudflare" | "pending_account" | "reset_required";
  products: CdProduct[];
  /** Whether the site prints its "All prices exclude GST" note. */
  siteNote?: boolean;
  log: { method: string; path: string; loggedIn: boolean; body?: string }[];
  dropSessionAfter?: number;
};

function page(title: string, body: string, loggedIn: boolean, head = "") {
  return `<!doctype html><html><head><title>${title} - Clear Digital</title>${head}</head><body class="zulu-product browse-template">
<div id="header">${loggedIn ? '<a href="/members/account.php?">My Account</a> <a href="/members/logout.php?">Sign out</a>' : '<a href="/members/login.php?">Sign in</a>'}</div>${body}
<div class="footer"><p>Clear Digital · Auckland · Wellington · Christchurch</p></div></body></html>`;
}

const tile = (p: CdProduct, loggedIn: boolean) =>
  `<li> <div class="box product-type-product"> <div class="image"><a href="/product/${p.id}/${p.slug}/"><img src="/x.png" /></a></div>
<div class="title result"><a href="/product/${p.id}/${p.slug}/" title="View this product...">${p.name}</a> <p class='sku'>Code: ${p.code}</p></div>
<div class="options"><div class="options-price">${loggedIn ? p.priceHtml : `<a href='/members/login.php?&return=%2F'>Login for pricing</a>`}</div></div></div></li>`;

const signInForm = (captcha: boolean) => `<div class="form_table login"><form method="post" name="signin" id="signin" action="">
<div class="field"><label>Email Address</label><input type="email" name="email" value="" class="form-control " /></div>
<div class="field"><label>Password</label><input type="password" name="password" value="" class="form-control " /></div>
${captcha ? '<div class="g-recaptcha" data-sitekey="6Lc_test"></div>' : ""}
<div class="field"><label><input type="checkbox" name="remember_me" value="1" /> Remember Me</label></div>
<div class="field submit"><button type="submit" name="submit" class="btn btn-default ">Sign In</button><input type="hidden" name="action" value="signin" class="form-control " /></div></form></div>`;

export async function startClearDigitalMock(state: CdState, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions = new Set<string>();
  let views = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const token = (req.headers.cookie ?? "").match(/zulu_member=([^;]+)/)?.[1];
    let loggedIn = !!token && sessions.has(token);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.log.push({ method: req.method ?? "GET", path: url.pathname + url.search, loggedIn, ...(req.method === "POST" ? { body } : {}) });
      const send = (status: number, html: string, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=UTF-8", ...headers });
        res.end(html);
      };
      if (state.mode === "cloudflare") return send(403, '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>');
      const note = state.siteNote === false ? "" : '<p class="gst-note">All prices exclude GST.</p>';

      if (url.pathname === "/members/login.php" && req.method === "GET") {
        if (loggedIn) return send(302, "", { Location: "/members/account.php?" });
        return send(200, page("Sign in to your account", `<h1>Sign In</h1>${signInForm(state.mode === "captcha")}`, false));
      }
      if (url.pathname === "/members/login.php" && req.method === "POST") {
        const f = new URLSearchParams(body);
        const fail = (msg: string) => send(200, page("Sign in to your account", `<h1>Sign In</h1><div class="alert alert-danger">${msg}</div>${signInForm(false)}`, false));
        if (f.get("action") !== "signin") return fail("Something went wrong. Please try again.");
        if (f.get("email") !== state.email) return fail(`No account was found for ${f.get("email")}.`);
        if (f.get("password") !== state.password) return fail("The password you entered is incorrect.");
        if (state.mode === "reset_required") return fail("If you're signing in for the first time on our new website you will need to reset your password.");
        if (state.mode === "pending_account") return fail("Your account is awaiting approval by Clear Digital.");
        if (state.mode === "mfa") return send(200, page("Verify", '<form method="post"><p>Enter the verification code we sent to your phone</p><input name="otp_code" /></form>', false));
        const t = `tok${Math.random().toString(36).slice(2)}`;
        sessions.add(t);
        return send(302, "", { Location: "/members/account.php?", "Set-Cookie": [`zulu_member=${t}; path=/; HttpOnly`, `PHPSESSID=sess${t}; path=/`] });
      }
      if (url.pathname === "/members/account.php") {
        if (!loggedIn) return send(302, "", { Location: "/members/login.php?" });
        return send(200, page("My Account", "<h1>My Account</h1><p>Welcome back.</p>", true));
      }
      if (url.pathname === "/" && url.searchParams.has("search")) {
        const q = (url.searchParams.get("search") ?? "").toLowerCase();
        const hits = state.products.filter((p) => `${p.name} ${p.code}`.toLowerCase().includes(q));
        return send(200, page(`Searching keywords '${q}' - Shop Online`, `${note}<h1>Search</h1><ul class="product-box row6">${hits.map((p) => tile(p, loggedIn)).join("")}</ul>`, loggedIn));
      }
      const m = url.pathname.match(/^\/product\/(\d+)\/([^/]+)\/$/);
      if (m) {
        const p = state.products.find((x) => x.id === Number(m[1]));
        if (!p) return send(404, page("Not found", "<h1>Not found</h1>", loggedIn));
        if (loggedIn && state.dropSessionAfter != null && ++views > state.dropSessionAfter) {
          sessions.clear();
          loggedIn = false;
        }
        const head = `<meta property="og:product:sale_price:amount" content="${p.publicPrice.toFixed(2)}"/><meta property="og:product:sale_price:currency" content="NZD"/>`;
        const price = loggedIn
          ? `<p class="button-wrapper"><div class="options-price">${p.priceHtml}</div><a href="/cart/add/${p.id}/" class="button">Add to cart</a></p>`
          : `<p class="button-wrapper"><a href="/members/login.php?&return=%2Fproduct%2F${p.id}%2F" class="button btn-variant-2">Login for pricing</a></p>`;
        const stock = loggedIn ? `<div class="product-stock"><p>${p.stock}</p></div>` : `<div class="product-stock"><p>Please <a href="/members/login.php?">Login</a> to view Stock information.</p></div>`;
        const related = state.products.filter((x) => x.id !== p.id).slice(0, 2);
        return send(
          200,
          page(
            p.name,
            `${note}<div class="product-header"><h1>${p.name}</h1><h4 class="mb-5">Code: ${p.code}</h4></div><div class="col">${price}</div>
<div id="description-tab-desc"><div class="product-description"><p>${p.name}</p></div></div>
<div id="description-tab-related"><ul class="product-box row6">${related.map((x) => tile(x, loggedIn)).join("")}</ul></div>
<div id="description-tab-stock">${stock}</div>`,
            loggedIn,
            head,
          ),
        );
      }
      return send(404, page("Not found", "<h1>Not found</h1>", loggedIn));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) };
}
