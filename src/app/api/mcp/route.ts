/**
 * MCP endpoint for Hermes (Streamable HTTP, JSON responses). Off unless a token is set; then only a
 * request carrying one as a bearer key is served:
 *   HERMES_MCP_TOKEN          → the "inspector" profile, as agent:hermes;
 *   HERMES_RESEARCH_MCP_TOKEN → the "research" profile, as agent:hermes-research.
 * Each profile sees only its own tools. The tools and their limits are in src/lib/hermes/mcp.ts.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { handleMcp, HERMES_ACTOR, HERMES_RESEARCH_ACTOR, type McpProfile } from "@/lib/hermes/mcp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const same = (given: string, token: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The profile the bearer token belongs to; null when MCP is off; false when the token is wrong. */
function authorised(req: Request): McpProfile | false | null {
  const tokens: [McpProfile, string | undefined][] = [
    ["inspector", process.env.HERMES_MCP_TOKEN],
    ["research", process.env.HERMES_RESEARCH_MCP_TOKEN],
  ];
  const live = tokens.filter((t): t is [McpProfile, string] => !!t[1] && t[1].length >= 24);
  if (!live.length) return null; // not switched on
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return live.find(([, token]) => same(given, token))?.[0] ?? false;
}

export async function POST(req: Request) {
  const auth = authorised(req);
  if (auth === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const out = await handleMcp(body, auth === "research" ? HERMES_RESEARCH_ACTOR : HERMES_ACTOR, auth);
  if (out === null) return new Response(null, { status: 202 });
  return NextResponse.json(out);
}

/** No server-initiated stream: this server only answers requests. */
export async function GET(req: Request) {
  const auth = authorised(req);
  if (auth === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
