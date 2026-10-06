import type { Metadata } from "next";
import { count, desc, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { inspections, inspectorQueue, inspectorRuns } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { hermesAutonomy, DIAL_LABELS, type DialClass } from "@/lib/hermes/autonomy";
import { AUTHORITY } from "@/lib/hermes/authority";
import type { ActionType } from "@/lib/inspector/types";
import { HARD_GUARDRAILS } from "@/lib/hermes/authority";
import { Badge, Card, CardHeader } from "@/components/ui";
import { HermesAutonomyForm } from "@/components/settings/hermes-autonomy";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Hermes" };

/**
 * Hermes: whether it is connected, how it has been doing, and how far it may go on its own.
 * The floor (nothing customer-facing without Chris) is in code and has no setting.
 */
export default async function HermesSettingsPage() {
  await requireAdmin();
  const connected = !!process.env.HERMES_API_URL && !!process.env.HERMES_API_KEY;
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const [autonomy, last, [stats], [queue]] = await Promise.all([
    hermesAutonomy(),
    db.query.inspectorRuns.findFirst({ orderBy: [desc(inspectorRuns.createdAt)], columns: { createdAt: true, status: true, model: true, durationMs: true, error: true } }),
    db.select({ runs: count(), ok: sql<number>`count(*) filter (where ${inspectorRuns.status} = 'ok')`, avgMs: sql<number>`coalesce(avg(${inspectorRuns.durationMs}), 0)` }).from(inspectorRuns).where(gte(inspectorRuns.createdAt, since)),
    db.select({ waiting: count(), retrying: sql<number>`count(*) filter (where ${inspectorQueue.attempts} > 0)` }).from(inspectorQueue),
  ]);
  const research = !!process.env.HERMES_RESEARCH_API_URL && !!process.env.HERMES_RESEARCH_API_KEY;
  // Why Hermes waited this week: readings the dial held (below the confidence needed) or refused.
  const recent = await db.query.inspections.findMany({ where: gte(inspections.createdAt, since), columns: { id: true, summary: true, validation: true, createdAt: true, sourceType: true }, orderBy: [desc(inspections.createdAt)], limit: 300 });
  const held = { count: 0, byClass: new Map<string, number>(), refused: 0, examples: [] as { at: Date; summary: string; message: string }[] };
  for (const r of recent) {
    const v = r.validation as { hard?: { rule: string; message: string }[]; decisions?: { action: string; allowed: boolean; rule: string }[] } | null;
    if (!v) continue;
    const low = v.hard?.find((h) => h.rule === "low_confidence");
    if (low) {
      held.count++;
      for (const d of v.decisions ?? []) if (d.rule === "low_confidence") {
        const cls = AUTHORITY[d.action as ActionType]?.class;
        const label = cls && cls in DIAL_LABELS ? DIAL_LABELS[cls as DialClass].label : null;
        if (label) held.byClass.set(label, (held.byClass.get(label) ?? 0) + 1);
      }
      if (held.examples.length < 5) held.examples.push({ at: r.createdAt, summary: r.summary, message: low.message });
    }
    if (v.hard?.some((h) => h.rule === "autonomy_never")) held.refused++;
  }
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Hermes</h1>
        <p className="text-sm text-gray-600">Hermes reads every email and Plaud conversation, decides what it is and what should happen, and does the internal work. Here you set how far it goes on its own. Nothing customer-facing is ever sent, confirmed, priced or discounted without you: that is fixed in code, not a setting.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Connection" action={<Badge className={connected ? "bg-[#00c875] text-white" : "bg-[#e2445c] text-white"}>{connected ? "Connected" : "Not connected"}</Badge>} />
          <div className="space-y-1 p-4 text-sm text-gray-700">
            <p>{connected ? `Inspector profile at ${process.env.HERMES_API_URL}${process.env.HERMES_MODEL ? ` (${process.env.HERMES_MODEL})` : ""}.` : "Set HERMES_API_URL and HERMES_API_KEY on the server (docs/DEPLOYMENT_HANDOFF.md section 17). Until then every new email waits for you on Home."}</p>
            <p>Research profile: {research ? "connected" : "not connected (research requests become tasks)"}.</p>
            <p>CRM tools: {process.env.HERMES_MCP_TOKEN ? "on" : "off (HERMES_MCP_TOKEN not set)"}.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Last 7 days" />
          <div className="space-y-1 p-4 text-sm text-gray-700" data-testid="hermes-stats">
            <p>
              {Number(stats.runs)} readings, {Number(stats.ok)} usable{Number(stats.runs) ? ` (${Math.round((Number(stats.ok) / Number(stats.runs)) * 100)}%)` : ""}, {Math.round(Number(stats.avgMs) / 100) / 10}s each on average.
            </p>
            <p>Last reading: {last ? `${formatDateTime(last.createdAt)} · ${last.status}${last.model ? ` · ${last.model}` : ""}${last.error ? ` · ${last.error.slice(0, 120)}` : ""}` : "none yet"}.</p>
            <p>Queue: {Number(queue.waiting)} waiting{Number(queue.retrying) ? `, ${Number(queue.retrying)} retrying` : ""}.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Never, whatever the dial says" />
          <ul className="list-disc space-y-0.5 p-4 pl-8 text-xs text-gray-700">
            {[...HARD_GUARDRAILS.customer_facing, ...HARD_GUARDRAILS.commercial.slice(0, 2), ...HARD_GUARDRAILS.identity.slice(0, 1), ...HARD_GUARDRAILS.secrets].map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader title="How far Hermes goes on its own" />
        <p className="px-4 pt-3 text-xs text-gray-600">
          Pick a position. Careful waits for you more; Normal is what the CRM assumes; Autonomous lets Hermes act on less certainty. Whatever the position, a quote, a reply or a booking is never sent or confirmed by Hermes. Under Advanced, each class has its own level (“Do it”, “Do it, then ask me”, “Ask me first”, “Never”) and the confidence it needs; below that confidence the action waits for you with Hermes’s plan attached.
        </p>
        <HermesAutonomyForm initial={autonomy} />
        <div className="border-t border-gray-100 px-4 py-3 text-sm" data-testid="why-waited">
          <p className="font-medium text-gray-900">Why Hermes waited this week</p>
          {held.count === 0 && held.refused === 0 ? (
            <p className="text-xs text-gray-600">Nothing was held back by the dial in the last 7 days{Number(stats.runs) ? "" : " (no readings yet)"}.</p>
          ) : (
            <>
              <p className="text-xs text-gray-600">
                {held.count} reading{held.count === 1 ? "" : "s"} waited for you because Hermes was below the confidence the dial needs
                {held.byClass.size ? ` (${[...held.byClass.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")})` : ""}
                {held.refused ? `; ${held.refused} had work switched off` : ""}. A lower bar on the class, or the Autonomous position, would let these through.
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                {held.examples.map((e, i) => (
                  <li key={i}>
                    {formatDateTime(e.at)} · {e.summary || "(no summary)"} · <span className="text-gray-500">{e.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
