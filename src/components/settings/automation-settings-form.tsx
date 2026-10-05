"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { runAutomationsNow, updateAutomationSettings } from "@/actions/tasks";
import { Button, Field, FormError, Input } from "@/components/ui";
import type { AutomationSettings } from "@/lib/constants";

export function AutomationSettingsForm({ settings }: { settings: AutomationSettings }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    setMsg(null);
    startTransition(async () => {
      const res = await updateAutomationSettings(fd);
      if (!res.ok) return setError(res.error);
      setMsg("Saved and re-evaluated.");
      router.refresh();
    });
  }
  function run() {
    setMsg(null);
    startTransition(async () => {
      const res = await runAutomationsNow();
      setMsg(res.ok ? `${res.data.overdue} overdue, ${res.data.today} today, ${res.data.waiting} waiting on customers${res.data.closed ? `, ${res.data.closed} closed` : ""}` : res.error);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Work day starts" htmlFor="as-h1">
          <Input id="as-h1" name="business_hours_start" type="number" min={0} max={22} defaultValue={settings.business_hours_start} />
        </Field>
        <Field label="Work day ends" htmlFor="as-h2">
          <Input id="as-h2" name="business_hours_end" type="number" min={2} max={24} defaultValue={settings.business_hours_end} />
        </Field>
      </div>
      <p className="-mt-1 text-xs text-gray-500">24-hour clock. The calendar grid shows these hours plus an hour each side.</p>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Site visit (minutes)" htmlFor="as-d1">
          <Input id="as-d1" name="site_visit_minutes" type="number" min={15} max={480} defaultValue={settings.site_visit_minutes} />
        </Field>
        <Field label="Service call (minutes)" htmlFor="as-d2">
          <Input id="as-d2" name="service_call_minutes" type="number" min={15} max={480} defaultValue={settings.service_call_minutes} />
        </Field>
        <Field label="Install (hours, if no estimate)" htmlFor="as-d3">
          <Input id="as-d3" name="install_hours" type="number" min={0.5} max={40} step={0.5} defaultValue={settings.install_hours} />
        </Field>
      </div>
      <p className="-mt-1 text-xs text-gray-500">How long Hermes pencils things in for. An install uses the Business Brain&apos;s labour estimate when it has one.</p>
      <Field label="New lead not contacted after (hours)" htmlFor="as-1">
        <Input id="as-1" name="new_lead_contact_hours" type="number" min={1} defaultValue={settings.new_lead_contact_hours} />
      </Field>
      <Field label="Site visit done, no quote after (days)" htmlFor="as-2">
        <Input id="as-2" name="site_visit_quote_days" type="number" min={0} defaultValue={settings.site_visit_quote_days} />
      </Field>
      <Field label="Quote sent, no response after (days)" htmlFor="as-3">
        <Input id="as-3" name="quote_followup_days" type="number" min={1} defaultValue={settings.quote_followup_days} />
      </Field>
      <Field label="Job done, not invoiced after (days)" htmlFor="as-4">
        <Input id="as-4" name="job_invoice_days" type="number" min={0} defaultValue={settings.job_invoice_days} />
      </Field>
      <label className="flex items-center gap-2 text-sm text-gray-800">
        <input type="checkbox" name="notify_assignee_by_email" defaultChecked={settings.notify_assignee_by_email} /> Also email staff when a job is scheduled for them
      </label>
      <FormError message={error} />
      {msg ? <p className="text-sm text-green-700">{msg}</p> : null}
      <div className="flex justify-between">
        <Button type="button" variant="secondary" onClick={run} disabled={pending}>
          Check now
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
