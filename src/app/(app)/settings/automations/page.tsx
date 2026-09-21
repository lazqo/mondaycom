import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getAutomationSettings } from "@/lib/settings";
import { lastAutomationRun } from "@/lib/automations/runner";
import { RULES } from "@/lib/automations/rules";
import { listOpenTasks } from "@/queries/dashboard";
import { Card, CardHeader } from "@/components/ui";
import { AutomationSettingsForm } from "@/components/settings/automation-settings-form";
import { TaskList } from "@/components/dashboard/task-list";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Reminders" };

export default async function AutomationsPage() {
  await requireAdmin();
  const [settings, last, open] = await Promise.all([getAutomationSettings(), lastAutomationRun(), listOpenTasks()]);
  const auto = open.filter((t) => t.ruleKey);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Reminder rules</h1>
        <p className="text-sm text-gray-500">
          Reminders for the team only. Nothing here emails customers. Last run: {last ? `${formatDateTime(last.ranAt)} · ${last.created} created, ${last.resolved} resolved in ${last.durationMs} ms` : "never"}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
          <Card>
            <CardHeader title="When to remind" />
            <div className="p-4">
              <AutomationSettingsForm settings={settings} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Rules" />
            <ul className="divide-y divide-gray-100 text-sm">
              {RULES.map((r) => (
                <li key={r.key} className="px-4 py-2.5">
                  <p className="font-medium text-gray-900">
                    {r.name} <span className="text-xs font-normal text-gray-400">{last?.perRule[r.key] ?? 0} matching</span>
                  </p>
                  <p className="text-xs text-gray-600">{r.description(settings)}</p>
                </li>
              ))}
              <li className="px-4 py-2.5">
                <p className="font-medium text-gray-900">Job scheduled → notify assigned staff</p>
                <p className="text-xs text-gray-600">In-app notification when a job is scheduled or moved; email too when enabled above.</p>
              </li>
            </ul>
          </Card>
        </div>
        <Card className="lg:col-span-2">
          <CardHeader title={`Open reminders (${auto.length})`} />
          {auto.length === 0 ? <p className="px-4 py-3 text-sm text-gray-500">No open reminders. They appear here and on Today as conditions are met.</p> : <div className="divide-y divide-gray-100"><TaskList tasks={auto} /></div>}
        </Card>
      </div>
    </div>
  );
}
