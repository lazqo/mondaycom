/**
 * The whole deterministic reading of one source: extraction, what is known, what is missing (and
 * whether it blocks), and the plain summary. Pure; the same for emails and conversations.
 */
import { extract, type ExtractContext } from "./extract";
import { computeMissing, knownFrom, summarise, type Known } from "./missing";
import type { InspectorInput, Understanding } from "./types";

export function analyse(input: InspectorInput, ctx: ExtractContext, crmKnown: Known, who: string | null): { understanding: Understanding; known: Known } {
  const u = extract(input, ctx);
  const known = knownFrom(u, crmKnown);
  u.missing = computeMissing(u, known);
  u.summary = summarise(u, who);
  return { understanding: u, known };
}
