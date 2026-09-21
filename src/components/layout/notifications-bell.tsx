"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import type { Notification } from "@/db/schema";
import { markAllNotificationsRead, markNotificationRead } from "@/actions/notifications";
import { formatDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

export function NotificationsBell({ items, unread }: { items: Notification[]; unread: number }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="relative rounded-md p-2 text-gray-600 hover:bg-gray-100" aria-label={`Notifications (${unread} unread)`} data-testid="notifications-bell">
        <Bell className="h-5 w-5" />
        {unread > 0 ? <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-[#e2445c] px-1 text-center text-[10px] font-semibold leading-[18px] text-white">{unread}</span> : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-40 mt-1 w-80 rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
            <span className="text-sm font-semibold text-gray-900">Notifications</span>
            {unread > 0 ? (
              <button
                type="button"
                className="text-xs text-brand-700 hover:underline"
                onClick={async () => {
                  await markAllNotificationsRead();
                  router.refresh();
                }}
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? <p className="px-3 py-4 text-sm text-gray-500">No notifications.</p> : null}
            {items.map((n) => (
              <Link
                key={n.id}
                href={n.link ?? "/dashboard"}
                onClick={async () => {
                  setOpen(false);
                  if (!n.readAt) await markNotificationRead(n.id);
                  router.refresh();
                }}
                className={cn("block border-b border-gray-100 px-3 py-2 text-sm hover:bg-gray-50", !n.readAt && "bg-brand-50/60")}
              >
                <p className="truncate font-medium text-gray-900">{n.title}</p>
                {n.body ? <p className="truncate text-xs text-gray-600">{n.body}</p> : null}
                <p className="text-[11px] text-gray-400">{formatDateTime(n.createdAt)}</p>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
