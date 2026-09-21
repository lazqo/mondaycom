import { NextResponse } from "next/server";
import { getHealth } from "@/lib/health";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Uptime monitors hit this unauthenticated: they get { ok, db, time } and a 503 when the database
 * is down. Signed-in admins (or a request with HEALTH_TOKEN) get the full detail.
 */
export async function GET(req: Request) {
  const h = await getHealth();
  const token = process.env.HEALTH_TOKEN;
  const authed = (token && req.headers.get("authorization") === `Bearer ${token}`) || (await getCurrentUser())?.role === "admin";
  const body = authed ? h : { ok: h.ok, db: h.db, time: h.time, version: h.version, warnings: h.warnings.length };
  return NextResponse.json(body, { status: h.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
