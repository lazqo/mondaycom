/**
 * The bearer tokens that switch on /api/mcp, one per Hermes profile. The two must differ: with
 * the same value, the research profile (web access) would be let in as the inspector and see
 * customer email, so the endpoint stays off until they do.
 */
import { timingSafeEqual } from "node:crypto";

export const sameToken = (given: string, token: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function mcpTokensMisconfigured(): boolean {
  const a = process.env.HERMES_MCP_TOKEN ?? "";
  const b = process.env.HERMES_RESEARCH_MCP_TOKEN ?? "";
  return a.length >= 24 && b.length >= 24 && sameToken(a, b);
}
