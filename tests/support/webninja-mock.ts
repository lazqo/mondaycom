/**
 * A stand-in for a WebNinja B2B webstore (www.swl.co.nz, www.vestaelectrical.co.nz): a CSRF-token
 * login form at /login, a body class that says logged-in / non-logged-in, "POA" for guests, a price
 * block for a signed-in account, POST /search with keywords that redirects to a results page of
 * li.product tiles (.model / .name / .price), product pages at /product/<id>-<slug> with a "Stock
 * Code:" block, and switchable CAPTCHA, two-factor and challenge modes. All values are TEST VALUES.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type WnProduct = {
  id: number;
  /** What the shop prints under "Stock Code:" (SWL: its own number; Vesta: the maker's model). */
  code: string;
  slug: string;
  name: string;
  /** Trade price block as the site prints it for a signed-in account (e.g. "$151.30 <span>ex GST</span>"); "POA" for a POA line. */
  priceHtml: string;
  stock?: string;
};

export type WnState = {
  shop: string;
  email: string;
  password: string;
  mode: "normal" | "captcha" | "mfa" | "cloudflare" | "pending_account";
  products: WnProduct[];
  siteNote?: boolean;
  log: { method: string; path: string; loggedIn: boolean; body?: string }[];
  dropSessionAfter?: number;
};

const CSRF = "tok-csrf-test-0123456789abcdef";

export async function startWebNinjaMock(state: WnState, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions = new Set<string>();
  const searches = new Map<string, string>();
  let views = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const origin = `http://${req.headers.host}`;
    const token = (req.headers.cookie ?? "").match(/wn_session=([^;]+)/)?.[1];
    let loggedIn = !!token && sessions.has(token);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.log.push({ method: req.method ?? "GET", path: url.pathname + url.search, loggedIn, ...(req.method === "POST" ? { body } : {}) });
      const send = (status: number, html: string, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=UTF-8", ...headers });
        res.end(html);
      };
      const page = (title: string, cls: string, inner: string) =>
        `<!DOCTYPE html><html lang="en"><head><title>${title} ${state.shop}</title><meta name="framework" content="WebNinja" /></head>
<body class="${cls} ${loggedIn ? "logged-in customer-type-w" : "non-logged-in"} show-prices"><div id="everything-outer">${loggedIn ? '<a href="' + origin + '/logout">Logout</a>' : '<a href="' + origin + '/login">Login</a>'}
<form class="search" method="post" action="${origin}/search"><input type="hidden" name="_csrf_token" value="${CSRF}" /><input class="keywords" name="keywords" type="search" /></form>
${state.siteNote === false ? "" : '<p class="note">All prices are shown ex GST.</p>'}${inner}</div></body></html>`;
      const tile = (p: WnProduct) =>
        `<li class="product not-in-cart product-${p.id} "> <div class=" details layoutmanager-layout-group layout_group_2"> <div class="photo"><a href="${origin}/product/${p.id}-${p.slug}"><img src="/x.png" /></a></div>
<div class="model">${p.code}</div> <div class="name"> <a href="${origin}/product/${p.id}-${p.slug}"> ${p.name} </a> </div> <div class="price">${loggedIn ? p.priceHtml : "POA"}</div> <div class="clear clearfix"></div> </div> </li>`;
      const loginForm = (captcha: boolean) =>
        `<form class="form form-horizontal login" method="post" action="${origin}/login"><input type="hidden" name="_csrf_token" value="${CSRF}" />
<input type="email" name="email" id="email" /><input type="password" name="password" id="password" autocomplete="off"/>${captcha ? '<div class="cf-turnstile" data-sitekey="0x_test"></div>' : ""}
<input class="btn btn-primary" type="submit" value="Login"/></form>`;
      if (state.mode === "cloudflare") return send(403, '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>');

      if (url.pathname === "/login" && req.method === "GET") return send(200, page("Login", "login", loggedIn ? "<p>You are logged in.</p>" : loginForm(state.mode === "captcha")));
      if (url.pathname === "/login" && req.method === "POST") {
        const f = new URLSearchParams(body);
        const fail = (msg: string) => send(200, page("Login", "login", `<div class="alert alert-danger">${msg}</div>${loginForm(false)}`));
        if (f.get("_csrf_token") !== CSRF) return fail("Your session has expired. Please try again.");
        if (f.get("email") !== state.email || f.get("password") !== state.password) return fail(`Login failed: the email address or password for ${f.get("email")} is incorrect.`);
        if (state.mode === "pending_account") return fail("Your account is pending approval.");
        if (state.mode === "mfa") return send(200, page("Verify", "login", '<form method="post"><p>Enter the authentication code from your authenticator app</p><input name="auth_code" /></form>'));
        const t = `tok${Math.random().toString(36).slice(2)}`;
        sessions.add(t);
        return send(302, "", { Location: `${origin}/account`, "Set-Cookie": [`wn_session=${t}; path=/; HttpOnly`] });
      }
      if (url.pathname === "/account") return send(200, page("My Account", "account", loggedIn ? "<h1>My Account</h1>" : loginForm(false)));
      if (url.pathname === "/search" && req.method === "GET") return send(200, page("Search", "search", "<h1>Search</h1>"));
      if (url.pathname === "/search" && req.method === "POST") {
        const f = new URLSearchParams(body);
        if (f.get("_csrf_token") !== CSRF) return send(403, page("Forbidden", "error", "<p>Invalid token</p>"));
        const id = Math.random().toString(16).slice(2, 13);
        searches.set(id, f.get("keywords") ?? "");
        return send(302, "", { Location: `${origin}/search/results/${id}` });
      }
      const r = url.pathname.match(/^\/search\/results\/([0-9a-f]+)$/);
      if (r) {
        const q = (searches.get(r[1]) ?? "").toLowerCase();
        const hits = state.products.filter((p) => `${p.name} ${p.code}`.toLowerCase().includes(q));
        return send(200, page("Search Results", "search_results shop_search_results", `<ul class="products grid">${hits.map(tile).join("")}</ul><div class="pagination"><div class="results"><span class="total">${hits.length}</span> results</div></div>`));
      }
      const m = url.pathname.match(/^\/product\/(\d+)-/);
      if (m) {
        const p = state.products.find((x) => x.id === Number(m[1]));
        if (!p) return send(404, page("Not found", "error", "<h1>Not found</h1>"));
        if (loggedIn && state.dropSessionAfter != null && ++views > state.dropSessionAfter) {
          sessions.clear();
          loggedIn = false;
        }
        const related = state.products.filter((x) => x.id !== p.id).slice(0, 2);
        return send(
          200,
          page(
            p.name,
            `shop_product_view product_view product-${p.id}`,
            `<h1>${p.name}</h1> <div class="model"> <div class="model-label">Stock Code:</div> <div class="value">${p.code}</div> </div>
<div class="price">${loggedIn ? p.priceHtml : "POA"}</div>${p.stock ? `<div class="stock"><span class="label">Stock:</span> ${p.stock}</div>` : ""}
<div class="enquire"><a class="button btn" href="${origin}/product/${p.id}/enquire">Make an Enquiry</a></div>
<div class="related-products"><h3>Related Products</h3><ul class="products related-products">${related.map(tile).join("")}</ul></div>`,
          ),
        );
      }
      return send(404, page("Not found", "error", "<h1>Not found</h1>"));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) };
}
