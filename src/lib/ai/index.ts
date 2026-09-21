import { env } from "@/lib/env";
import { AnthropicClassifier } from "./anthropic-classifier";
import { RulesClassifier } from "./rules-classifier";
import type { LeadClassifier } from "./types";

export * from "./types";

let cached: LeadClassifier | null = null;

/**
 * Picks the classifier from env. "auto" uses Anthropic when an API key is present and the
 * offline rules otherwise, so the pipeline always works. Swap providers by adding a class that
 * implements LeadClassifier and a branch here — nothing else in the app knows which model ran.
 */
export function getClassifier(): LeadClassifier {
  if (cached) return cached;
  const wantAnthropic = env.AI_PROVIDER === "anthropic" || (env.AI_PROVIDER === "auto" && !!env.ANTHROPIC_API_KEY);
  if (wantAnthropic) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    cached = new AnthropicClassifier(env.AI_MODEL, env.ANTHROPIC_API_KEY);
  } else {
    cached = new RulesClassifier();
  }
  return cached;
}

/** For tests and one-off scripts. */
export function setClassifier(c: LeadClassifier | null) {
  cached = c;
}
