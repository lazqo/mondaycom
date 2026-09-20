"use client";

import * as React from "react";
import { createLead } from "@/actions/leads";
import { Button, Dialog, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS, LEAD_STATUSES, LEAD_STATUS_META, SERVICE_SUGGESTIONS } from "@/lib/constants";
import type { UserOption } from "./cells";

export function NewLeadDialog({
  open,
  onClose,
  users,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  users: UserOption[];
  onCreated: (id: string) => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const res = await createLead(data);
      if (!res.ok) {
        setError(res.error);
        setFieldErrors(res.fieldErrors ?? {});
        return;
      }
      onCreated(res.data.id);
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title="New lead" width="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Lead name *" htmlFor="nl-name" error={fieldErrors.name?.[0]} className="sm:col-span-2">
            <Input id="nl-name" name="name" required autoFocus placeholder="Who is enquiring?" />
          </Field>
          <Field label="Company" htmlFor="nl-company">
            <Input id="nl-company" name="company" />
          </Field>
          <Field label="Phone" htmlFor="nl-phone">
            <Input id="nl-phone" name="phone" type="tel" />
          </Field>
          <Field label="Email" htmlFor="nl-email" error={fieldErrors.email?.[0]}>
            <Input id="nl-email" name="email" type="email" />
          </Field>
          <Field label="Service" htmlFor="nl-service">
            <Input id="nl-service" name="service" list="service-suggestions" />
            <datalist id="service-suggestions">
              {SERVICE_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label="Site address" htmlFor="nl-site" className="sm:col-span-2">
            <Input id="nl-site" name="site" />
          </Field>
          <Field label="Status" htmlFor="nl-status">
            <Select id="nl-status" name="status" defaultValue="new">
              {LEAD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_STATUS_META[s].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assigned to" htmlFor="nl-assigned">
            <Select id="nl-assigned" name="assignedToId" defaultValue="">
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Follow-up" htmlFor="nl-followup">
            <Input id="nl-followup" name="followUpAt" type="date" />
          </Field>
          <Field label="Last contact" htmlFor="nl-lastcontact">
            <Input id="nl-lastcontact" name="lastContactAt" type="date" />
          </Field>
          <Field label="Source" htmlFor="nl-source">
            <Select id="nl-source" name="source" defaultValue="phone">
              {LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Notes" htmlFor="nl-notes" className="sm:col-span-2">
            <Textarea id="nl-notes" name="notes" />
          </Field>
        </div>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create lead"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
