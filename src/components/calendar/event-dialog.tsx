"use client";

import * as React from "react";
import { createEvent, updateEvent, deleteEvent } from "@/actions/events";
import { Button, Dialog, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import type { CalendarEvent } from "./calendar-view";

type UserOption = { id: string; name: string };
type State = { mode: "create"; date: string; time?: string; leadId?: string; title?: string } | { mode: "edit"; event: CalendarEvent } | null;

function localDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function plusHour(t: string) {
  const [h, m] = t.split(":").map(Number);
  return `${String(Math.min(23, h + 1)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function localTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function EventDialog({
  state,
  users,
  onClose,
  onSaved,
}: {
  state: State;
  users: UserOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const ev = state?.mode === "edit" ? state.event : null;
  const key = state ? (state.mode === "create" ? `c-${state.date}` : `e-${state.event.id}`) : "none";

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const date = String(fd.get("date"));
    const allDay = fd.get("allDay") === "on";
    const startTime = allDay ? "00:00" : String(fd.get("startTime"));
    const endTime = allDay ? "23:59" : String(fd.get("endTime"));
    const payload = {
      leadId: state?.mode === "create" ? (state.leadId ?? null) : undefined,
      kind: state?.mode === "create" && state.leadId ? ("site_visit" as const) : undefined,
      title: String(fd.get("title") ?? ""),
      description: String(fd.get("description") ?? ""),
      location: String(fd.get("location") ?? ""),
      startsAt: new Date(`${date}T${startTime}:00`).toISOString(),
      endsAt: new Date(`${date}T${endTime}:00`).toISOString(),
      allDay,
      assignedToId: String(fd.get("assignedToId") ?? ""),
    };
    setError(null);
    startTransition(async () => {
      const res = ev ? await updateEvent(ev.id, payload) : await createEvent(payload);
      if (!res.ok) return setError(res.error);
      onSaved();
    });
  }

  function remove() {
    if (!ev || !confirm("Delete this event?")) return;
    startTransition(async () => {
      const res = await deleteEvent(ev.id);
      if (!res.ok) return setError(res.error);
      onSaved();
    });
  }

  return (
    <Dialog open={state !== null} onClose={onClose} title={ev ? (ev.readOnly ? "Calendar event" : "Edit event") : "New event"}>
      <form key={key} onSubmit={submit} className="space-y-4">
        {ev?.readOnly ? (
          <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">
            This is one occurrence of a repeating event in your Titan calendar. Change or delete it in the calendar; the CRM follows.
          </p>
        ) : ev?.fromCalendar ? (
          <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">From your Titan calendar. Changes made here are copied back to it.</p>
        ) : null}
        <Field label="Title *" htmlFor="ev-title">
          <Input id="ev-title" name="title" defaultValue={ev?.title ?? (state?.mode === "create" ? (state.title ?? "") : "")} required autoFocus />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date" htmlFor="ev-date">
            <Input id="ev-date" name="date" type="date" defaultValue={ev ? localDate(ev.startsAt) : state?.mode === "create" ? state.date : ""} required />
          </Field>
          <Field label="Start" htmlFor="ev-start">
            <Input id="ev-start" name="startTime" type="time" defaultValue={ev ? localTime(ev.startsAt) : (state?.mode === "create" && state.time) || "09:00"} />
          </Field>
          <Field label="End" htmlFor="ev-end">
            <Input id="ev-end" name="endTime" type="time" defaultValue={ev ? localTime(ev.endsAt) : plusHour((state?.mode === "create" && state.time) || "09:00")} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" name="allDay" defaultChecked={ev?.allDay ?? false} /> All day
        </label>
        <Field label="Location" htmlFor="ev-location">
          <Input id="ev-location" name="location" defaultValue={ev?.location ?? ""} />
        </Field>
        <Field label="Assigned to" htmlFor="ev-assigned">
          <Select id="ev-assigned" name="assignedToId" defaultValue={ev?.assignedToId ?? ""}>
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes" htmlFor="ev-desc">
          <Textarea id="ev-desc" name="description" defaultValue={ev?.description ?? ""} />
        </Field>
        <FormError message={error} />
        <div className="flex items-center justify-between">
          {ev && !ev.readOnly ? (
            <Button type="button" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={remove} disabled={pending}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            {ev?.readOnly ? null : (
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : ev ? "Save" : "Create event"}
              </Button>
            )}
          </div>
        </div>
      </form>
    </Dialog>
  );
}
