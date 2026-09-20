"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { Contact } from "@/db/schema";
import { createContact, updateContact } from "@/actions/contacts";
import { Button, Dialog, Field, FormError, Input, Textarea } from "@/components/ui";

function ContactFields({ contact, idPrefix }: { contact?: Contact | null; idPrefix: string }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Name *" htmlFor={`${idPrefix}-name`}>
        <Input id={`${idPrefix}-name`} name="name" defaultValue={contact?.name ?? ""} required />
      </Field>
      <Field label="Company" htmlFor={`${idPrefix}-company`}>
        <Input id={`${idPrefix}-company`} name="company" defaultValue={contact?.company ?? ""} />
      </Field>
      <Field label="Email" htmlFor={`${idPrefix}-email`}>
        <Input id={`${idPrefix}-email`} name="email" type="email" defaultValue={contact?.email ?? ""} />
      </Field>
      <Field label="Phone" htmlFor={`${idPrefix}-phone`}>
        <Input id={`${idPrefix}-phone`} name="phone" type="tel" defaultValue={contact?.phone ?? ""} />
      </Field>
      <Field label="Address" htmlFor={`${idPrefix}-address`} className="sm:col-span-2">
        <Input id={`${idPrefix}-address`} name="address" defaultValue={contact?.address ?? ""} />
      </Field>
      <Field label="Notes" htmlFor={`${idPrefix}-notes`} className="sm:col-span-2">
        <Textarea id={`${idPrefix}-notes`} name="notes" defaultValue={contact?.notes ?? ""} />
      </Field>
    </div>
  );
}

export function ContactForm({ contact }: { contact: Contact }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await updateContact(contact.id, data);
      if (!res.ok) return setError(res.error);
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ContactFields contact={contact} idPrefix="c" />
      <FormError message={error} />
      <div className="flex items-center justify-end gap-3">
        {saved ? <span className="text-sm text-green-700">Saved</span> : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

export function NewContactButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setError(null);
    startTransition(async () => {
      const res = await createContact(data);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      router.push(`/contacts/${res.data.id}`);
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New customer
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New customer" width="max-w-2xl">
        <form onSubmit={submit} className="space-y-4">
          <ContactFields idPrefix="nc" />
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create customer"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
