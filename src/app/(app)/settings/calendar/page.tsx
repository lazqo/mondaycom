import type { Metadata } from "next";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { calendarItems } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { CalendarSettings } from "@/components/settings/calendar-settings";

export const metadata: Metadata = { title: "Calendar sync" };

export default async function CalendarSettingsPage() {
  await requireAdmin();
  const conn = await db.query.calendarConnections.findFirst({ columns: { passwordEncrypted: false } });
  const paired = conn ? (await db.select({ n: count() }).from(calendarItems).where(eq(calendarItems.connectionId, conn.id)))[0].n : 0;
  return (
    <CalendarSettings
      connection={
        conn
          ? {
              id: conn.id,
              name: conn.name,
              serverUrl: conn.serverUrl,
              username: conn.username,
              calendarUrl: conn.calendarUrl,
              calendarName: conn.calendarName,
              pushKinds: conn.pushKinds,
              active: conn.active,
              lastSyncAt: conn.lastSyncAt?.toISOString() ?? null,
              lastError: conn.lastError,
              paired,
            }
          : null
      }
      syncSeconds={Number(process.env.CALENDAR_SYNC_SECONDS ?? 300)}
      inProcess={process.env.INGEST_IN_PROCESS === "true" || process.env.INGEST_IN_PROCESS === "1"}
    />
  );
}
