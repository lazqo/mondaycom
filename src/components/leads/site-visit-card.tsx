"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import type { Event } from "@/db/schema";
import { Button, Card, CardHeader } from "@/components/ui";
import { EventDialog } from "@/components/calendar/event-dialog";
import { formatDateTime, formatTime } from "@/lib/utils";

type UserOption = { id: string; name: string };

export function SiteVisitCard({ lead, events, users }: { lead: { id: string; name: string; site: string | null }; events: Event[]; users: UserOption[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const visits = events.filter((e) => e.kind === "site_visit");
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return (
    <Card>
      <CardHeader
        title="Site visits"
        action={
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <CalendarPlus className="h-4 w-4" /> Book site visit
          </Button>
        }
      />
      <div className="divide-y divide-gray-100 text-sm">
        {visits.length === 0 ? <p className="px-4 py-3 text-gray-500">No site visit booked.</p> : null}
        {visits.map((v) => (
          <Link key={v.id} href={`/calendar?view=day&date=${new Date(v.startsAt).toISOString().slice(0, 10)}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50">
            <span>
              {formatDateTime(v.startsAt)} – {formatTime(v.endsAt)}
            </span>
            <span className="text-xs text-gray-500">{new Date(v.endsAt) < new Date() ? "completed" : "upcoming"}</span>
          </Link>
        ))}
      </div>
      <EventDialog
        state={open ? { mode: "create", date, leadId: lead.id, title: `Site visit: ${lead.name}${lead.site ? ` — ${lead.site}` : ""}` } : null}
        users={users}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </Card>
  );
}
