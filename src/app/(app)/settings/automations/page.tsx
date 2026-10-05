import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getAutomationSettings } from "@/lib/settings";
import { lastAutomationRun, legacyReminderSummary } from "@/lib/automations/runner";
import { RULES } from "@/lib/automations/rules";
import { listNextSteps } from "@/queries/next-steps";
import { Badge, Card, CardHeader } from "@/components/ui";
import { AutomationSettingsForm } from "@/components/settings/automation-settings-form";
import { StepLine } from "@/components/next-steps/step-line";
import { LegacyRemindersBanner } from "@/components/next-steps/legacy-banner";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Next steps" };

function Group({ title, rows, today, tone, empty }: { title: string; rows: { record: { type: string; id: string }; step: unknown }[]; today: string; tone: "alert" | "warn" | "default" | "quiet"; empty: string }) {
  const steps = rows as Parameters<typeof StepLine>[0][];
  return (
    <Card data-testid={`steps-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            {title}
            <Badge className={rows.length === 0 ? "bg-gray-100 text-gray-500" : tone === "alert" ? "bg-[#e2445c] text-white" : tone === "warn" ? "bg-[#ffcb00] text-gray-900" : tone === "quiet" ? "bg-gray-200 text-gray-700" : "bg-brand-100 text-brand-800"}>{rows.length}</Badge>
          </span>
        }
      />
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-gray-500">{empty}</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {steps.map((r) => (
            <StepLine key={`${r.record.type}-${r.record.id}`} record={r.record} step={r.step} today={today} />
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Next steps: every open lead and job's one step, with the reason, and the checklist timings that
 * produce the generic ones. Reminders are not created here any more; this is where they are read.
 */
export default async function NextStepsPage() {
  await requireAdmin();
  const [settings, last, steps, legacy] = await Promise.all([getAutomationSettings(), lastAutomationRun(), listNextSteps(), legacyReminderSummary()]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Next steps</h1>
        <p className="text-sm text-gray-500">
          One step per lead and job, worked out from what has happened on it: a promise, a task, a proposal waiting on you, an appointment, or the checklist below. Anything that happens on the record replaces it. Last checked: {last ? formatDateTime(last.ranAt) : "never"}.
        </p>
      </div>
      <LegacyRemindersBanner summary={legacy} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
          <Card>
            <CardHeader title="Checklist timings" />
            <div className="p-4">
              <AutomationSettingsForm settings={settings} />
            </div>
          </Card>
          <Card>
            <CardHeader title="The daily checklist" />
            <ul className="divide-y divide-gray-100 text-sm">
              {RULES.map((r) => (
                <li key={r.key} className="px-4 py-2.5">
                  <p className="font-medium text-gray-900">{r.name}</p>
                  <p className="text-xs text-gray-600">{r.description(settings)}</p>
                </li>
              ))}
              <li className="px-4 py-2.5">
                <p className="font-medium text-gray-900">Waiting on a customer</p>
                <p className="text-xs text-gray-600">A customer&apos;s promise (photos, a decision, a payment) holds the record until its date; past it, the step is to chase them.</p>
              </li>
              <li className="px-4 py-2.5">
                <p className="font-medium text-gray-900">Job scheduled → notify assigned staff</p>
                <p className="text-xs text-gray-600">In-app notification when a job is scheduled or moved; email too when enabled above.</p>
              </li>
            </ul>
            <p className="px-4 pb-3 text-xs text-gray-500">A specific plan on the record (a task, a promise, a proposal) always replaces a checklist step.</p>
          </Card>
        </div>
        <div className="space-y-4 lg:col-span-2">
          <Group title="Overdue" rows={steps.overdue} today={steps.today} tone="alert" empty="Nothing overdue." />
          <Group title="Today" rows={steps.dueToday} today={steps.today} tone="warn" empty="Nothing due today." />
          <Group title="Coming up" rows={steps.later} today={steps.today} tone="default" empty="Nothing scheduled ahead." />
          <Group title="Waiting on customers" rows={steps.waiting} today={steps.today} tone="quiet" empty="No customer has said they'll send anything." />
          <p className="text-xs text-gray-500">{steps.quiet} record{steps.quiet === 1 ? "" : "s"} with nothing to do (won with a job in hand, or finished).</p>
        </div>
      </div>
    </div>
  );
}
