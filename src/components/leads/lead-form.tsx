"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Lead } from "@/db/schema";
import { updateLead, archiveLead } from "@/actions/leads";
import { Button, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS, LEAD_STATUSES, LEAD_STATUS_META, LEAD_URGENCIES, LEAD_URGENCY_META, SERVICE_SUGGESTIONS } from "@/lib/constants";
import type { UserOption } from "./cells";

export function LeadForm({ lead, users }: { lead: Lead; users: UserOption[] }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});
  const [saved, setSaved] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setError(null);
    setFieldErrors({});
    setSaved(false);
    startTransition(async () => {
      const res = await updateLead(lead.id, data);
      if (!res.ok) {
        setError(res.error);
        setFieldErrors(res.fieldErrors ?? {});
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  function archive() {
    if (!confirm("Archive this lead? It will disappear from the board.")) return;
    startTransition(async () => {
      const res = await archiveLead(lead.id);
      if (!res.ok) setError(res.error);
      else router.push("/leads");
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Lead name *" htmlFor="l-name" error={fieldErrors.name?.[0]} className="sm:col-span-2">
          <Input id="l-name" name="name" defaultValue={lead.name} required />
        </Field>
        <Field label="Company" htmlFor="l-company">
          <Input id="l-company" name="company" defaultValue={lead.company ?? ""} />
        </Field>
        <Field label="Phone" htmlFor="l-phone">
          <Input id="l-phone" name="phone" type="tel" defaultValue={lead.phone ?? ""} />
        </Field>
        <Field label="Email" htmlFor="l-email" error={fieldErrors.email?.[0]}>
          <Input id="l-email" name="email" type="email" defaultValue={lead.email ?? ""} />
        </Field>
        <Field label="Service" htmlFor="l-service">
          <Input id="l-service" name="service" list="service-suggestions-edit" defaultValue={lead.service ?? ""} />
          <datalist id="service-suggestions-edit">
            {SERVICE_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label="Site address" htmlFor="l-site" className="sm:col-span-2">
          <Input id="l-site" name="site" defaultValue={lead.site ?? ""} />
        </Field>
        <Field label="Status" htmlFor="l-status">
          <Select id="l-status" name="status" defaultValue={lead.status}>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_META[s].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assigned to" htmlFor="l-assigned">
          <Select id="l-assigned" name="assignedToId" defaultValue={lead.assignedToId ?? ""}>
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Follow-up" htmlFor="l-followup">
          <Input id="l-followup" name="followUpAt" type="date" defaultValue={lead.followUpAt ?? ""} />
        </Field>
        <Field label="Last contact" htmlFor="l-lastcontact">
          <Input id="l-lastcontact" name="lastContactAt" type="date" defaultValue={lead.lastContactAt ?? ""} />
        </Field>
        <Field label="Source" htmlFor="l-source">
          <Select id="l-source" name="source" defaultValue={lead.source}>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {LEAD_SOURCE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Enquiry summary" htmlFor="l-summary" className="sm:col-span-2">
          <Textarea id="l-summary" name="summary" defaultValue={lead.summary ?? ""} className="min-h-16" placeholder="What the customer is asking for" />
        </Field>
        <Field label="Urgency" htmlFor="l-urgency">
          <Select id="l-urgency" name="urgency" defaultValue={lead.urgency ?? ""}>
            <option value="">—</option>
            {LEAD_URGENCIES.map((u) => (
              <option key={u} value={u}>
                {LEAD_URGENCY_META[u].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Next action" htmlFor="l-next">
          <Input id="l-next" name="nextAction" defaultValue={lead.nextAction ?? ""} />
        </Field>
        <Field label="Notes" htmlFor="l-notes" className="sm:col-span-2">
          <Textarea id="l-notes" name="notes" defaultValue={lead.notes ?? ""} />
        </Field>
      </div>
      <FormError message={error} />
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={archive} disabled={pending} className="text-red-600 hover:bg-red-50">
          Archive lead
        </Button>
        <div className="flex items-center gap-3">
          {saved ? <span className="text-sm text-green-700">Saved</span> : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}
