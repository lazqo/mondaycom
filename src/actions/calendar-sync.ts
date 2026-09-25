"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { calendarConnections, calendarItems } from "@/db/schema";
import { requireAdmin, requireOffice } from "@/lib/auth";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { EVENT_KINDS } from "@/lib/constants";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { connectCalDav, listEventCalendars, sameUrl, type CalendarChoice } from "@/lib/calendar/caldav";
import { syncAllCalendars } from "@/lib/calendar/sync";

const credentialsInput = z.object({
  id: z.string().uuid().nullable().optional(),
  serverUrl: z.string().trim().url("Enter the calendar server address, e.g. https://dav.flockmail.com"),
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().optional(),
});

const connectionInput = credentialsInput.extend({
  name: z.string().trim().min(1).max(100).default("Titan calendar"),
  calendarUrl: z.string().trim().url("Choose a calendar"),
  calendarName: z.string().trim().max(200).optional(),
  pushKinds: z.array(z.enum(EVENT_KINDS)).default(["site_visit", "job", "other"]),
  active: z.boolean().default(true),
});
export type CalendarConnectionInput = z.input<typeof connectionInput>;

async function passwordFor(id: string | null | undefined, typed: string | undefined): Promise<string | null> {
  if (typed) return typed;
  if (!id) return null;
  const c = await db.query.calendarConnections.findFirst({ where: eq(calendarConnections.id, id), columns: { passwordEncrypted: true } });
  return c ? decryptSecret(c.passwordEncrypted) : null;
}

/** Log in and list the account's calendars, so the user can pick one. Nothing is saved. */
export async function findCalendars(input: unknown): Promise<ActionResult<CalendarChoice[]>> {
  await requireAdmin();
  const parsed = credentialsInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const password = await passwordFor(parsed.data.id, parsed.data.password);
  if (!password) return fail("Enter the password (or app password) for this calendar");
  try {
    const client = await connectCalDav({ serverUrl: parsed.data.serverUrl, username: parsed.data.username, password });
    const calendars = await listEventCalendars(client);
    if (!calendars.length) return fail("Signed in, but this account has no calendars");
    return ok(calendars);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function saveCalendarConnection(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireAdmin();
  const parsed = connectionInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const password = await passwordFor(d.id, d.password);
  if (!password) return fail("Enter the password (or app password) for this calendar");

  const values = {
    name: d.name,
    serverUrl: d.serverUrl,
    username: d.username,
    calendarUrl: d.calendarUrl,
    calendarName: d.calendarName ?? null,
    pushKinds: d.pushKinds,
    active: d.active,
    updatedAt: new Date(),
  };
  let id = d.id ?? null;
  if (id) {
    const before = await db.query.calendarConnections.findFirst({ where: eq(calendarConnections.id, id) });
    if (!before) return fail("Calendar connection not found");
    await db
      .update(calendarConnections)
      .set({ ...values, ...(d.password ? { passwordEncrypted: encryptSecret(d.password) } : {}), ...(sameUrl(before.calendarUrl, d.calendarUrl) ? {} : { ctag: null }) })
      .where(eq(calendarConnections.id, id));
    // A different calendar: forget the old pairings so events are written to the new one.
    if (!sameUrl(before.calendarUrl, d.calendarUrl)) await db.delete(calendarItems).where(eq(calendarItems.connectionId, id));
  } else {
    const existing = await db.query.calendarConnections.findFirst({ columns: { id: true } });
    if (existing) return fail("A calendar is already connected. Edit it, or disconnect it first.");
    const [row] = await db
      .insert(calendarConnections)
      .values({ ...values, passwordEncrypted: encryptSecret(password) })
      .returning({ id: calendarConnections.id });
    id = row.id;
  }
  revalidatePath("/settings/calendar");
  return ok({ id });
}

export async function deleteCalendarConnection(id: string): Promise<ActionResult<undefined>> {
  await requireAdmin();
  await db.delete(calendarConnections).where(eq(calendarConnections.id, id));
  revalidatePath("/settings/calendar");
  return ok(undefined);
}

export type SyncNowResult = { created: number; updated: number; deleted: number; pushed: number; errors: string[] };

/** Sync now, reading the whole calendar window rather than trusting the change tag. */
export async function syncCalendarNow(): Promise<ActionResult<SyncNowResult>> {
  await requireOffice();
  const out = await syncAllCalendars((m) => console.log(m), { force: true });
  const total: SyncNowResult = { created: 0, updated: 0, deleted: 0, pushed: 0, errors: [] };
  for (const r of Object.values(out)) {
    if ("error" in r) {
      total.errors.push(r.error);
      continue;
    }
    total.created += r.pulled.created;
    total.updated += r.pulled.updated;
    total.deleted += r.pulled.deleted;
    total.pushed += r.pushed.created + r.pushed.updated + r.pushed.deleted;
    total.errors.push(...r.errors);
  }
  revalidatePath("/calendar");
  revalidatePath("/settings/calendar");
  revalidatePath("/dashboard");
  if (total.errors.length && !Object.values(out).some((r) => !("error" in r))) return fail(total.errors[0]);
  return ok(total);
}
