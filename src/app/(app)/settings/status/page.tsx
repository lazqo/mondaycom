import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getHealth } from "@/lib/health";
import { Badge, Card, CardHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "System status" };

export default async function StatusPage() {
  await requireAdmin();
  const h = await getHealth();
  const ok = (v: boolean) => <Badge className={v ? "bg-[#00c875] text-white" : "bg-[#e2445c] text-white"}>{v ? "OK" : "Problem"}</Badge>;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">System status</h1>
        <p className="text-sm text-gray-500">
          Checked {formatDateTime(h.time)} · version {h.version}. Uptime monitors can poll <code>/api/health</code> (see docs/runbooks/backup-and-monitoring.md).
        </p>
      </div>
      {h.warnings.length ? (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900" data-testid="status-warnings">
          <p className="font-medium">Needs attention</p>
          <ul className="mt-1 list-disc pl-5">
            {h.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">Everything looks healthy.</div>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Database" action={ok(h.db === "up")} />
          <p className="p-4 text-sm text-gray-700">All customer data, emails, attachments and job photos live in this database. Back it up daily.</p>
        </Card>
        <Card>
          <CardHeader title="Email ingestion" action={ok(h.ingestion.mode !== "off" && !h.ingestion.mailboxes.some((m) => m.stale))} />
          <div className="p-4 text-sm text-gray-700">
            <p className="mb-2">Running: {h.ingestion.mode === "in-process" ? "inside the web app" : h.ingestion.mode === "worker" ? "as a separate worker" : "not in this process"}</p>
            {h.ingestion.mailboxes.length === 0 ? <p className="text-gray-500">No email account connected.</p> : null}
            <ul className="space-y-1">
              {h.ingestion.mailboxes.map((m) => (
                <li key={m.address} className={m.stale ? "text-red-700" : ""}>
                  {m.address} · {m.active ? "active" : "paused"} · last checked {m.lastSyncAt ? `${m.minutesSinceSync} min ago` : "never"}
                  {m.lastError ? ` · error: ${m.lastError}` : ""}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-gray-500">
              Waiting to classify: {h.emails.pending} · needs review: {h.emails.needsReview} · problems: {h.emails.errors}
            </p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Reminder rules" action={ok(h.automations.minutesSinceRun !== null && h.automations.minutesSinceRun <= 60)} />
          <p className="p-4 text-sm text-gray-700">
            Last run {h.automations.lastRunAt ? `${h.automations.minutesSinceRun} min ago` : "never"} · {h.automations.open ?? 0} open reminders.
          </p>
        </Card>
        <Card>
          <CardHeader title="Email AI" action={<Badge className={h.ai.provider === "anthropic" ? "bg-[#00c875] text-white" : "bg-gray-400 text-white"}>{h.ai.provider === "anthropic" ? "Claude" : "Offline rules"}</Badge>} />
          <p className="p-4 text-sm text-gray-700">{h.ai.provider === "anthropic" ? `Model ${h.ai.model}.` : "Add ANTHROPIC_API_KEY on the server to use Claude. Until then, simple keyword rules classify email."}</p>
        </Card>
      </div>
    </div>
  );
}
