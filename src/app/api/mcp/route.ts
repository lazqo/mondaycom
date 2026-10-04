/**
 * MCP endpoint for Hermes (Streamable HTTP, JSON responses). Off unless HERMES_MCP_TOKEN is set;
 * then only a request carrying that token as a bearer key is served, as agent:hermes.
 * The tools and their limits are in src/lib/hermes/mcp.ts.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { handleMcp } from "@/lib/hermes/mcp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorised(req: Request): boolean | null {
  const token = process.env.HERMES_MCP_TOKEN;
  if (!token || token.length < 24) return null; // not switched on
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
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
  const out = await handleMcp(body);
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
