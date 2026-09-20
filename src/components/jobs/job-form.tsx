"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Contact, Job } from "@/db/schema";
import { createJob, updateJob } from "@/actions/jobs";
import { Button, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { SERVICE_SUGGESTIONS } from "@/lib/constants";

type UserOption = { id: string; name: string };
type Props =
  | { mode: "create"; contacts: Contact[]; users: UserOption[]; defaultContactId?: string }
  | { mode: "edit"; contacts: Contact[]; users: UserOption[]; job: Job };

export function JobForm(props: Props) {
  const router = useRouter();
  const job = props.mode === "edit" ? props.job : null;
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setError(null);
    setSaved(false);
    startTransition(async () => {
      if (props.mode === "create") {
        const res = await createJob(data);
        if (!res.ok) return setError(res.error);
        router.push(`/jobs/${res.data.id}`);
        router.refresh();
      } else {
        const res = await updateJob(props.job.id, data);
        if (!res.ok) return setError(res.error);
        setSaved(true);
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Title *" htmlFor="j-title" className="sm:col-span-2">
          <Input id="j-title" name="title" defaultValue={job?.title ?? ""} required />
        </Field>
        <Field label="Customer *" htmlFor="j-contact">
          <Select id="j-contact" name="contactId" defaultValue={job?.contactId ?? (props.mode === "create" ? (props.defaultContactId ?? "") : "")} required>
            <option value="">Choose a customer…</option>
            {props.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.company ? ` (${c.company})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assigned to" htmlFor="j-assigned">
          <Select id="j-assigned" name="assignedToId" defaultValue={job?.assignedToId ?? ""}>
            <option value="">Unassigned</option>
            {props.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Service" htmlFor="j-service">
          <Input id="j-service" name="service" list="job-service-suggestions" defaultValue={job?.service ?? ""} />
          <datalist id="job-service-suggestions">
            {SERVICE_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label="Site address" htmlFor="j-site">
          <Input id="j-site" name="siteAddress" defaultValue={job?.siteAddress ?? ""} />
        </Field>
        <Field label="Notes" htmlFor="j-notes" className="sm:col-span-2">
          <Textarea id="j-notes" name="notes" defaultValue={job?.notes ?? ""} placeholder="Scope, access details, materials…" />
        </Field>
      </div>
      <FormError message={error} />
      <div className="flex items-center justify-end gap-3">
        {saved ? <span className="text-sm text-green-700">Saved</span> : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : props.mode === "create" ? "Create job" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
