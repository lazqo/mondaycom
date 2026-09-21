"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { createTask } from "@/actions/tasks";
import { Button, Dialog, Field, FormError, Input, Select, Textarea } from "@/components/ui";

type UserOption = { id: string; name: string };

export function NewTaskButton({ users, defaults }: { users: UserOption[]; defaults?: { leadId?: string; jobId?: string; quoteId?: string; contactId?: string; title?: string } }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = { ...Object.fromEntries(new FormData(e.currentTarget)), ...defaults, title: String(new FormData(e.currentTarget).get("title") ?? "") };
    setError(null);
    startTransition(async () => {
      const res = await createTask(data);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add reminder
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New reminder">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Title *" htmlFor="t-title">
            <Input id="t-title" name="title" required autoFocus defaultValue={defaults?.title ?? ""} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due" htmlFor="t-due">
              <Input id="t-due" name="dueAt" type="date" />
            </Field>
            <Field label="Assign to" htmlFor="t-assign">
              <Select id="t-assign" name="assignedToId" defaultValue="">
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Detail" htmlFor="t-detail">
            <Textarea id="t-detail" name="detail" className="min-h-16" />
          </Field>
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add reminder"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
