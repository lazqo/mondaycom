"use client";

import { useActionState } from "react";
import { createFirstAdmin, type FirstAdminState } from "@/actions/setup";
import { Button, Field, FormError, Input } from "@/components/ui";

export function FirstAdminForm() {
  const [state, action, pending] = useActionState<FirstAdminState, FormData>(createFirstAdmin, undefined);
  return (
    <form action={action} className="space-y-4">
      <Field label="Your name" htmlFor="fa-name">
        <Input id="fa-name" name="name" required autoFocus autoComplete="name" />
      </Field>
      <Field label="Email (your login)" htmlFor="fa-email">
        <Input id="fa-email" name="email" type="email" required autoComplete="email" />
      </Field>
      <Field label="Password (10+ characters)" htmlFor="fa-password">
        <Input id="fa-password" name="password" type="password" required minLength={10} autoComplete="new-password" />
      </Field>
      <Field label="Confirm password" htmlFor="fa-confirm">
        <Input id="fa-confirm" name="confirm" type="password" required minLength={10} autoComplete="new-password" />
      </Field>
      <FormError message={state?.error} />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating…" : "Create admin account"}
      </Button>
    </form>
  );
}
