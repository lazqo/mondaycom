/**
 * Ask Hermes to inspect one email or conversation. Returns its structured result, or why there is
 * none (not configured, unavailable, timed out, unusable output). Never throws for Hermes's sake:
 * the caller falls back to Chris on anything but "ok".
 */
import { randomUUID } from "node:crypto";
import type { IdentityResult, InspectorInput } from "@/lib/inspector/types";
import { HERMES_INSPECTOR_VERSION, HermesOutputError, parseHermesResult, type HermesResult } from "./contract";
import { buildContextPack, buildMessages, repairMessages } from "./context";
import { getHermes, HermesUnavailableError } from "./runtime";

export type HermesStatus = "ok" | "not_configured" | "unavailable" | "timeout" | "invalid_output" | "error";

export type HermesOutcome = {
  status: HermesStatus;
  result: HermesResult | null;
  runtime: string | null;
  model: string | null;
  version: string;
  durationMs: number;
  error: string | null;
  rawExcerpt: string | null;
  contextRefs: Record<string, unknown>;
};

export async function askHermes(input: InspectorInput, opts: { identity: IdentityResult; leadId: string | null; contactId: string | null; staffNames: string[]; answers?: { key: string; question: string; answer: string; at: string }[] }): Promise<HermesOutcome> {
  const started = Date.now();
  const { pack, refs } = await buildContextPack(input, opts);
  const base = { version: HERMES_INSPECTOR_VERSION, contextRefs: refs as Record<string, unknown> };
  const runtime = getHermes();
  if (!runtime) return { ...base, status: "not_configured", result: null, runtime: null, model: null, durationMs: 0, error: "Hermes is not connected (HERMES_API_URL and HERMES_API_KEY are not set).", rawExcerpt: null };

  const messages = buildMessages(pack);
  const key = `inspect:${input.sourceType}:${input.sourceId}:${randomUUID()}`;
  const fail = (status: HermesStatus, error: string, raw: string | null = null, model: string | null = runtime.model): HermesOutcome => ({ ...base, status, result: null, runtime: runtime.name, model, durationMs: Date.now() - started, error, rawExcerpt: raw ? raw.slice(0, 2000) : null });
  try {
    const reply = await runtime.complete(messages, { idempotencyKey: key });
    try {
      const result = parseHermesResult(reply.text);
      return { ...base, status: "ok", result, runtime: runtime.name, model: reply.model, durationMs: Date.now() - started, error: null, rawExcerpt: null };
    } catch (err) {
      if (!(err instanceof HermesOutputError)) throw err;
      // One more chance, with the problem stated.
      const again = await runtime.complete(repairMessages(messages, reply.text, err.message), { idempotencyKey: `${key}:repair` });
      try {
        const result = parseHermesResult(again.text);
        return { ...base, status: "ok", result, runtime: runtime.name, model: again.model, durationMs: Date.now() - started, error: null, rawExcerpt: null };
      } catch (err2) {
        if (!(err2 instanceof HermesOutputError)) throw err2;
        return fail("invalid_output", err2.message, again.text, again.model);
      }
    }
  } catch (err) {
    if (err instanceof HermesUnavailableError) return fail(err.kind === "timeout" ? "timeout" : "unavailable", err.message);
    return fail("error", err instanceof Error ? err.message : String(err));
  }
}
