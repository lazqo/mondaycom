import type { Metadata } from "next";
import { count, desc, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { inspectorQueue, inspectorRuns } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { hermesAutonomy } from "@/lib/hermes/autonomy";
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
          “Do it”: Hermes does it and it shows on Home; you can undo it. “Do it, then ask me”: the work is done and the result waits for your click (a quote, a reply). “Ask me first”: nothing happens until you say so. Below the confidence, the action waits for you with Hermes’s plan attached.
        </p>
        <HermesAutonomyForm initial={autonomy} />
      </Card>
    </div>
  );
}
