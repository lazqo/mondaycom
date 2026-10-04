/**
 * Talking to Hermes (Nous Research's Hermes Agent, Get Secure's own agent).
 *
 * The CRM calls Hermes Agent's API server (OpenAI-compatible, `POST /v1/chat/completions`, bearer
 * key; see https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) once per
 * email or conversation, with a context pack the CRM builds. Hermes answers with one JSON Inspector
 * result. Hermes may also read more through the CRM's own MCP tools (src/app/api/mcp), which are
 * read-only or guarded and audited.
 *
 * Hermes is never trusted: its reply is parsed against the contract and validated before anything
 * happens, and if it is not configured, unreachable, slow or returns something invalid, the item
 * goes to Chris (fallback), never to "no action".
 *
 * Configuration (server env, never in the repo):
 *   HERMES_API_URL       e.g. http://127.0.0.1:8642 (Hermes Agent's API server)
 *   HERMES_API_KEY       the API_SERVER_KEY set in Hermes Agent
 *   HERMES_MODEL         optional; the model/profile name Hermes exposes (default "hermes-agent")
 *   HERMES_TIMEOUT_MS    optional; default 120000
 */

export type HermesMessage = { role: "system" | "user" | "assistant"; content: string };
export type HermesReply = { text: string; model: string | null; durationMs: number };

export interface HermesRuntime {
  /** "hermes-api" for the real agent; tests use their own. */
  readonly name: string;
  readonly model: string;
  complete(messages: HermesMessage[], opts: { idempotencyKey: string; timeoutMs?: number }): Promise<HermesReply>;
}

/** Hermes could not be reached, refused, or ran out of time. The item falls back to Chris. */
export class HermesUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "timeout" | "http" | "network",
  ) {
    super(message);
    this.name = "HermesUnavailableError";
  }
}

export class HermesApiRuntime implements HermesRuntime {
  readonly name = "hermes-api";
  constructor(
    private baseUrl: string,
    private apiKey: string,
    readonly model: string,
    private defaultTimeoutMs: number,
  ) {}

  async complete(messages: HermesMessage[], opts: { idempotencyKey: string; timeoutMs?: number }): Promise<HermesReply> {
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? this.defaultTimeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          // One long-lived memory key for the Inspector, so Hermes can learn Get Secure's patterns.
          "X-Hermes-Session-Key": "getsecure-crm-inspector",
          // A retry of the same inspection never starts a second run.
          "Idempotency-Key": opts.idempotencyKey.slice(0, 255),
        },
        body: JSON.stringify({ model: this.model, messages, stream: false }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (ctl.signal.aborted) throw new HermesUnavailableError(`Hermes did not answer within ${Math.round((opts.timeoutMs ?? this.defaultTimeoutMs) / 1000)} seconds.`, "timeout");
      throw new HermesUnavailableError(`Hermes could not be reached: ${err instanceof Error ? err.message : String(err)}`, "network");
    }
    clearTimeout(timer);
    if (!res.ok) {
      // Never echo the body: an error page could carry anything. The status is enough.
      throw new HermesUnavailableError(`Hermes answered HTTP ${res.status}.`, "http");
    }
    const json = (await res.json().catch(() => null)) as { model?: string; choices?: { message?: { content?: string | null } }[] } | null;
    const text = json?.choices?.[0]?.message?.content ?? "";
    return { text, model: json?.model ?? this.model, durationMs: Date.now() - started };
  }
}

let override: HermesRuntime | null | undefined;

/** For tests: a stand-in Hermes (or null to act as if Hermes is not configured). */
export function setHermes(h: HermesRuntime | null | undefined) {
  override = h;
}

/** The configured Hermes, or null when it is not set up (everything then falls back to Chris). */
export function getHermes(): HermesRuntime | null {
  if (override !== undefined) return override;
  const url = process.env.HERMES_API_URL;
  const key = process.env.HERMES_API_KEY;
  if (!url || !key) return null;
  return new HermesApiRuntime(url, key, process.env.HERMES_MODEL || "hermes-agent", Number(process.env.HERMES_TIMEOUT_MS) || 120_000);
}

/** Below this confidence a recommendation is shown to Chris instead of being acted on. */
export function hermesMinConfidence(): number {
  const v = Number(process.env.HERMES_MIN_CONFIDENCE);
  return v > 0 && v <= 1 ? v : 0.6;
}
