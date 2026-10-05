/**
 * Instructions Chris gives on a recording ("move Tim's visit to Thursday 3 pm", "mark Campbell's
 * job done", "add a note to Rowena"), carried out by the CRM. A recording is Chris's own voice, so
 * it is the one source treated as an operator; the validator only lets commands through from there,
 * with the commanded words quoted from the transcript. Reversible changes run at once and say how to
 * undo them; anything that changes what a customer was told, or cannot be undone, waits for a click.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { events, jobs, leads, tasks } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { queueCalendarSync } from "@/lib/calendar/sync";
import { JOB_STATUSES, LEAD_STATUSES } from "@/lib/constants";
import type { HermesResult } from "@/lib/hermes/contract";
import { resolveAt, resolveDue } from "./dates";
import { createTask } from "./work";

export type Command = HermesResult["commands"][number];
export type CommandScope = { leadId: string | null; contactId: string | null; jobId: string | null };

/** Commands that change what a customer was told, or cannot be undone: Chris clicks first. */
export function commandNeedsClick(c: Command): boolean {
  if (c.action === "move_event" || c.action === "cancel_event") return true;
  if (c.action === "set_job_status" && c.args.status === "cancelled") return true;
  return false;
}

/** One line saying what the command does, for the card and the feed. */
export function describeCommand(c: Command): string {
  const t = c.target.label ? ` for ${c.target.label}` : "";
  const a = c.args;
  switch (c.action) {
    case "add_note":
      return `Add a note${t}: “${String(a.body ?? "").slice(0, 80)}”`;
    case "create_task":
      return `Create a task${t}: “${String(a.title ?? "")}”${a.due ? ` (${String(a.due)})` : ""}`;
    case "complete_task":
      return `Mark done${t}: “${String(a.title ?? c.target.label ?? "")}”`;
    case "cancel_task":
      return `Remove the task${t}: “${String(a.title ?? c.target.label ?? "")}”`;
    case "set_follow_up":
      return `Set the follow-up${t} to ${String(a.when ?? "")}`;
    case "set_lead_status":
      return `Set the lead${t} to ${String(a.status ?? "")}`;
    case "set_job_status":
      return `Set the job${t} to ${String(a.status ?? "")}`;
    case "move_event":
      return `Move the appointment${t} to ${String(a.when ?? "")}`;
    case "cancel_event":
      return `Cancel the appointment${t}`;
    case "update_lead_field":
      return `Set ${String(a.field ?? "a field")}${t} to “${String(a.value ?? "")}”`;
  }
}

const id = (ref: string | null | undefined, kind: string) => (ref && ref.startsWith(`${kind}:`) && /^[0-9a-f-]{36}$/i.test(ref.slice(kind.length + 1)) ? ref.slice(kind.length + 1) : null);

/** Carry a command out. Returns what was done and how to undo it, or why it could not be done. */
export async function runCommand(c: Command, scope: CommandScope, opts: { actorId: string | null; at: Date }): Promise<{ status: "done" | "blocked"; result: Record<string, unknown> }> {
  const a = c.args;
  const leadId = id(c.target.ref, "lead") ?? scope.leadId;
  const jobId = id(c.target.ref, "job") ?? scope.jobId;
  const contactId = id(c.target.ref, "customer") ?? scope.contactId;
  const blocked = (reason: string) => ({ status: "blocked" as const, result: { reason, command: c } });
  const done = (summary: string, extra: Record<string, unknown> = {}) => ({ status: "done" as const, result: { summary, command: c, ...extra } });
  const actor = { actorId: opts.actorId };
  switch (c.action) {
    case "add_note": {
      const body = String(a.body ?? "").trim();
      if (!body) return blocked("The note is empty.");
      const entity = leadId ? ("lead" as const) : jobId ? ("job" as const) : contactId ? ("contact" as const) : null;
      if (!entity) return blocked("Nothing to put the note on: say which lead, job or customer.");
      await logActivity({ entity, entityId: (leadId ?? jobId ?? contactId)!, ...actor, action: "note", detail: { body, via: "recording" } });
      return done(`Note added: “${body.slice(0, 80)}”`);
    }
    case "create_task": {
      const title = String(a.title ?? "").trim();
      if (!title) return blocked("The task has no title.");
      const r = await createTask({ leadId, contactId, jobId }, { title, due: typeof a.due === "string" ? a.due : "today", detail: typeof a.detail === "string" ? a.detail : "From a recording.", kind: "task", ruleKey: "hermes:command" });
      return r.alreadyOpen ? done(`Already open: ${r.title}.`, { taskId: r.taskId }) : done(`Task created: “${title}”.`, { taskId: r.taskId, undo: "mark the task dismissed" });
    }
    case "complete_task":
    case "cancel_task": {
      const taskId = id(c.target.ref, "task");
      const title = String(a.title ?? c.target.label ?? "").trim().toLowerCase();
      const t = taskId
        ? await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) })
        : title
          ? (await db.query.tasks.findMany({ where: and(eq(tasks.status, "open"), leadId ? eq(tasks.leadId, leadId) : jobId ? eq(tasks.jobId, jobId) : contactId ? eq(tasks.contactId, contactId) : eq(tasks.status, "open")), limit: 50 })).find((x) => x.title.toLowerCase().includes(title) || title.includes(x.title.toLowerCase()))
          : null;
      if (!t) return blocked(`No open task matches “${title || c.target.ref || "?"}”.`);
      const status = c.action === "complete_task" ? "done" : "dismissed";
      await db.update(tasks).set({ status, updatedAt: new Date() }).where(eq(tasks.id, t.id));
      if (t.leadId) await logActivity({ entity: "lead", entityId: t.leadId, ...actor, action: status === "done" ? "task_done" : "task_dismissed", detail: { taskId: t.id, title: t.title, via: "recording" } });
      return done(`${status === "done" ? "Done" : "Removed"}: “${t.title}”.`, { taskId: t.id, undo: "reopen the task" });
    }
    case "set_follow_up": {
      if (!leadId) return blocked("Say which lead the follow-up is for.");
      const when = typeof a.when === "string" ? resolveDue(a.when, opts.at) : null;
      if (!when) return blocked(`I cannot place “${String(a.when ?? "")}” as a day.`);
      const prev = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { followUpAt: true } });
      const day = when.toISOString().slice(0, 10);
      await db.update(leads).set({ followUpAt: day, followUpSetAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, leadId));
      await logActivity({ entity: "lead", entityId: leadId, ...actor, action: "updated", detail: { changes: { followUpAt: { from: prev?.followUpAt ?? null, to: day } }, via: "recording" } });
      return done(`Follow-up set to ${day}.`, { previous: prev?.followUpAt ?? null, undo: `set it back to ${prev?.followUpAt ?? "none"}` });
    }
    case "set_lead_status": {
      if (!leadId) return blocked("Say which lead.");
      const status = String(a.status ?? "").toLowerCase().replace(/\s+/g, "_");
      if (!(LEAD_STATUSES as readonly string[]).includes(status)) return blocked(`“${String(a.status ?? "")}” is not a lead status (${LEAD_STATUSES.join(", ")}).`);
      const prev = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { status: true } });
      await db.update(leads).set({ status: status as (typeof LEAD_STATUSES)[number], updatedAt: new Date() }).where(eq(leads.id, leadId));
      await logActivity({ entity: "lead", entityId: leadId, ...actor, action: "status_changed", detail: { from: prev?.status ?? null, to: status, via: "recording" } });
      return done(`Lead set to ${status}.`, { previous: prev?.status ?? null, undo: `set it back to ${prev?.status ?? "?"}` });
    }
    case "set_job_status": {
      if (!jobId) return blocked("Say which job.");
      const status = String(a.status ?? "").toLowerCase().replace(/\s+/g, "_");
      if (!(JOB_STATUSES as readonly string[]).includes(status)) return blocked(`“${String(a.status ?? "")}” is not a job status (${JOB_STATUSES.join(", ")}).`);
      const prev = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId), columns: { status: true } });
      await db.update(jobs).set({ status: status as (typeof JOB_STATUSES)[number], ...(status === "done" ? { doneAt: new Date() } : {}), updatedAt: new Date() }).where(eq(jobs.id, jobId));
      await logActivity({ entity: "job", entityId: jobId, ...actor, action: "status_changed", detail: { from: prev?.status ?? null, to: status, via: "recording" } });
      return done(`Job set to ${status}.`, { previous: prev?.status ?? null, undo: `set it back to ${prev?.status ?? "?"}` });
    }
    case "move_event": {
      const eventId = id(c.target.ref, "event");
      const ev = eventId ? await db.query.events.findFirst({ where: eq(events.id, eventId) }) : null;
      if (!ev) return blocked("Say which appointment (an event from the calendar).");
      if (ev.readOnly) return blocked("That is a repeating calendar event: change it in the calendar.");
      const when = typeof a.when === "string" ? resolveAt(a.when, opts.at) : null;
      if (!when) return blocked(`I cannot place “${String(a.when ?? "")}” as a time.`);
      const endsAt = new Date(when.getTime() + (ev.endsAt.getTime() - ev.startsAt.getTime()));
      await db.update(events).set({ startsAt: when, endsAt, updatedAt: new Date() }).where(eq(events.id, ev.id));
      if (ev.leadId) await logActivity({ entity: "lead", entityId: ev.leadId, ...actor, action: "site_visit_moved", detail: { eventId: ev.id, startsAt: when.toISOString(), via: "recording" } });
      if (ev.jobId) await logActivity({ entity: "job", entityId: ev.jobId, ...actor, action: "rescheduled", detail: { startsAt: when.toISOString(), endsAt: endsAt.toISOString(), via: "recording" } });
      queueCalendarSync();
      return done(`Moved “${ev.title}” to ${when.toISOString()}.`, { eventId: ev.id, previous: ev.startsAt.toISOString(), undo: "move it back on the calendar" });
    }
    case "cancel_event": {
      const eventId = id(c.target.ref, "event");
      const ev = eventId ? await db.query.events.findFirst({ where: eq(events.id, eventId) }) : null;
      if (!ev) return blocked("Say which appointment (an event from the calendar).");
      if (ev.readOnly) return blocked("That is a repeating calendar event: change it in the calendar.");
      await db.delete(events).where(eq(events.id, ev.id));
      if (ev.leadId) await logActivity({ entity: "lead", entityId: ev.leadId, ...actor, action: "site_visit_removed", detail: { eventId: ev.id, title: ev.title, via: "recording" } });
      queueCalendarSync();
      return done(`Cancelled “${ev.title}”.`, { eventId: ev.id });
    }
    case "update_lead_field": {
      if (!leadId) return blocked("Say which lead.");
      const field = String(a.field ?? "").toLowerCase();
      const col = ({ name: "name", phone: "phone", email: "email", site: "site", site_address: "site", address: "site", service: "service", company: "company" } as Record<string, "name" | "phone" | "email" | "site" | "service" | "company">)[field];
      if (!col) return blocked(`“${field}” is not a lead field I can set (name, phone, email, site, service, company).`);
      const value = String(a.value ?? "").trim();
      if (!value) return blocked("No value given.");
      const prev = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { [col]: true } as Record<string, true> });
      await db.update(leads).set({ [col]: value, updatedAt: new Date() }).where(eq(leads.id, leadId));
      await logActivity({ entity: "lead", entityId: leadId, ...actor, action: "updated", detail: { changes: { [col]: { from: (prev as Record<string, unknown> | undefined)?.[col] ?? null, to: value } }, via: "recording" } });
      return done(`${col} set to “${value}”.`, { previous: (prev as Record<string, unknown> | undefined)?.[col] ?? null, undo: "set the previous value back" });
    }
  }
}
