"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft } from "lucide-react";
import type { Lead, Contact } from "@/db/schema";
import { convertLead, searchContacts } from "@/actions/leads";
import { Button, Dialog, Field, FormError, Input } from "@/components/ui";
import type { UserOption } from "./cells";

export function ConvertLeadButton({ lead, users }: { lead: Lead; users: UserOption[] }) {
  const [open, setOpen] = React.useState(false);
  const converted = Boolean(lead.contactId);
  return (
    <>
      <Button variant={converted ? "secondary" : "primary"} onClick={() => setOpen(true)}>
        <ArrowRightLeft className="h-4 w-4" />
        {converted ? "Create job / quote" : "Convert to customer"}
      </Button>
      <ConvertLeadDialog open={open} onClose={() => setOpen(false)} lead={lead} users={users} />
    </>
  );
}

export function ConvertLeadDialog({
  open,
  onClose,
  lead,
  users,
}: {
  open: boolean;
  onClose: () => void;
  lead: Lead;
  users: UserOption[];
}) {
  const router = useRouter();
  const alreadyLinked = Boolean(lead.contactId);
  const [mode, setMode] = React.useState<"new" | "existing">(alreadyLinked ? "existing" : "new");
  const [existingId, setExistingId] = React.useState<string>(lead.contactId ?? "");
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<Contact[]>([]);
  const [createJob, setCreateJob] = React.useState(true);
  const [createQuote, setCreateQuote] = React.useState(false);
  const [markWon, setMarkWon] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!open || mode !== "existing") return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const rows = await searchContacts(query);
      if (!cancelled) setResults(rows);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, mode, query]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    const payload = {
      contactMode: mode,
      existingContactId: mode === "existing" ? existingId : null,
      contact:
        mode === "new"
          ? {
              name: String(fd.get("contactName") ?? ""),
              company: String(fd.get("contactCompany") ?? ""),
              email: String(fd.get("contactEmail") ?? ""),
              phone: String(fd.get("contactPhone") ?? ""),
              address: String(fd.get("contactAddress") ?? ""),
            }
          : undefined,
      createJob,
      job: createJob
        ? {
            title: String(fd.get("jobTitle") ?? ""),
            service: String(fd.get("jobService") ?? ""),
            siteAddress: String(fd.get("jobSite") ?? ""),
            assignedToId: String(fd.get("jobAssigned") ?? ""),
          }
        : undefined,
      createQuote,
      quoteTitle: String(fd.get("quoteTitle") ?? ""),
      markWon,
    };
    startTransition(async () => {
      const res = await convertLead(lead.id, payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onClose();
      if (res.data.jobId) router.push(`/jobs/${res.data.jobId}`);
      else if (res.data.quoteId) router.push(`/quotes/${res.data.quoteId}`);
      else router.push(`/contacts/${res.data.contactId}`);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={alreadyLinked ? "Create job / quote" : "Convert lead"} width="max-w-2xl">
      <form onSubmit={submit} className="space-y-5">
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-900">Customer</h3>
          {!alreadyLinked ? (
            <div className="mb-3 flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" name="mode" checked={mode === "new"} onChange={() => setMode("new")} /> New customer
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="mode" checked={mode === "existing"} onChange={() => setMode("existing")} /> Existing customer
              </label>
            </div>
          ) : null}
          {mode === "new" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name *" htmlFor="c-name">
                <Input id="c-name" name="contactName" defaultValue={lead.name} required />
              </Field>
              <Field label="Company" htmlFor="c-company">
                <Input id="c-company" name="contactCompany" defaultValue={lead.company ?? ""} />
              </Field>
              <Field label="Email" htmlFor="c-email">
                <Input id="c-email" name="contactEmail" type="email" defaultValue={lead.email ?? ""} />
              </Field>
              <Field label="Phone" htmlFor="c-phone">
                <Input id="c-phone" name="contactPhone" defaultValue={lead.phone ?? ""} />
              </Field>
              <Field label="Address" htmlFor="c-address" className="sm:col-span-2">
                <Input id="c-address" name="contactAddress" defaultValue={lead.site ?? ""} />
              </Field>
            </div>
          ) : (
            <div className="space-y-2">
              {!alreadyLinked ? (
                <Input placeholder="Search customers by name, company, email, phone…" value={query} onChange={(e) => setQuery(e.target.value)} />
              ) : null}
              <div className="max-h-48 overflow-y-auto rounded-md border border-gray-200">
                {results.length === 0 && !alreadyLinked ? (
                  <p className="px-3 py-2 text-sm text-gray-500">No customers found.</p>
                ) : null}
                {results.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 text-sm last:border-b-0 hover:bg-gray-50">
                    <input type="radio" name="existing" value={c.id} checked={existingId === c.id} onChange={() => setExistingId(c.id)} />
                    <span className="font-medium text-gray-900">{c.name}</span>
                    <span className="text-gray-500">{[c.company, c.email, c.phone].filter(Boolean).join(" · ")}</span>
                  </label>
                ))}
                {alreadyLinked && results.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-gray-700">Linked customer will be used.</p>
                ) : null}
              </div>
            </div>
          )}
        </section>

        <section>
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <input type="checkbox" checked={createJob} onChange={(e) => setCreateJob(e.target.checked)} /> Create a job
          </label>
          {createJob ? (
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Job title *" htmlFor="j-title" className="sm:col-span-2">
                <Input id="j-title" name="jobTitle" defaultValue={`${lead.service ?? "Job"} — ${lead.name}`} required={createJob} />
              </Field>
              <Field label="Service" htmlFor="j-service">
                <Input id="j-service" name="jobService" defaultValue={lead.service ?? ""} />
              </Field>
              <Field label="Assigned to" htmlFor="j-assigned">
                <select id="j-assigned" name="jobAssigned" defaultValue={lead.assignedToId ?? ""} className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm">
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Site address" htmlFor="j-site" className="sm:col-span-2">
                <Input id="j-site" name="jobSite" defaultValue={lead.site ?? ""} />
              </Field>
            </div>
          ) : null}
        </section>

        <section>
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <input type="checkbox" checked={createQuote} onChange={(e) => setCreateQuote(e.target.checked)} /> Create a draft quote
          </label>
          {createQuote ? (
            <div className="mt-2">
              <Field label="Quote title" htmlFor="q-title">
                <Input id="q-title" name="quoteTitle" defaultValue={`${lead.service ?? "Quote"} for ${lead.name}`} />
              </Field>
            </div>
          ) : null}
        </section>

        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={markWon} onChange={(e) => setMarkWon(e.target.checked)} /> Mark lead as Won
        </label>

        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || (mode === "existing" && !existingId)}>
            {pending ? "Converting…" : "Convert"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
