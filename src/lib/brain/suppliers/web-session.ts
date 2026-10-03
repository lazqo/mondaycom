/**
 * A small cookie-keeping HTTP client for one supplier website. It only ever talks to that one
 * site (a redirect anywhere else is refused, so a login cookie can never be sent to another host),
 * keeps its cookies in memory for the length of one run, and never logs or returns them.
 */

export class ConnectorError extends Error {
  constructor(
    /** A fixed code the UI and status use, e.g. "auth_failed", "captcha", "mfa", "blocked", "unreachable". */
    readonly code: string,
    /** A credential-free explanation. */
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export type WebResponse = { status: number; url: string; html: string };

export class WebSession {
  private readonly origin: string;
  private readonly cookies = new Map<string, string>();

  constructor(
    base: string,
    private readonly opts: { userAgent?: string; timeoutMs?: number; delayMs?: number } = {},
  ) {
    this.origin = new URL(base).origin;
  }

  /** Values a redaction must hide: every cookie value this session holds. */
  secrets(): string[] {
    return [...this.cookies.values()].filter((v) => v.length >= 4);
  }

  cookieNames(): string[] {
    return [...this.cookies.keys()];
  }

  url(path: string): string {
    return new URL(path, this.origin + "/").toString();
  }

  private store(res: Response) {
    const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split("=").slice(1).join("=")) < Date.now()));
      if (!value || value === "deleted" || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private paused = false;

  async request(path: string, init: { method?: "GET" | "POST"; form?: Record<string, string>; accept?: string } = {}): Promise<WebResponse> {
    // Be polite: one request at a time, with a pause between them.
    if (this.paused && this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    this.paused = true;
    let url = this.url(path);
    let method = init.method ?? "GET";
    let body: string | undefined = init.form ? new URLSearchParams(init.form).toString() : undefined;
    for (let hop = 0; hop < 6; hop++) {
      if (new URL(url).origin !== this.origin) throw new ConnectorError("unexpected_redirect", `The supplier site redirected to another website (${new URL(url).host}); stopped.`);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          redirect: "manual",
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
          headers: {
            "User-Agent": this.opts.userAgent ?? "Mozilla/5.0 (compatible; GetSecureCRM-PriceSync/1.0)",
            Accept: init.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-NZ,en;q=0.9",
            ...(this.cookies.size ? { Cookie: this.header() } : {}),
            ...(body ? { "Content-Type": "application/x-www-form-urlencoded", Origin: this.origin, Referer: url } : {}),
          },
        });
      } catch (e) {
        const timeout = e instanceof Error && /timeout|abort/i.test(e.name + e.message);
        throw new ConnectorError("unreachable", timeout ? "The supplier site did not respond in time." : "The supplier site could not be reached.");
      }
      this.store(res);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).toString();
        // Browsers turn a POST into a GET on 301/302/303.
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        await res.arrayBuffer().catch(() => null);
        continue;
      }
      const html = await res.text();
      return { status: res.status, url, html };
    }
    throw new ConnectorError("unexpected_redirect", "The supplier site redirected too many times; stopped.");
  }
}

/** Replace every secret (username, password, cookie values) in a piece of text. */
export function redact(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 3) continue;
    out = out.split(s).join("•••");
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join("•••");
  }
  return out;
}
