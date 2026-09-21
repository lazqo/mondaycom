"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, Briefcase, FileText, Calendar, Kanban, Settings, Inbox, Mail, Sun, Smartphone, Zap, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { label: "Today", href: "/dashboard", icon: Sun },
  { label: "My day", href: "/my-day", icon: Smartphone },
  { label: "Inbox", href: "/inbox", icon: Inbox },
  { label: "Leads", href: "/leads", icon: Kanban },
  { label: "Customers", href: "/contacts", icon: Users },
  { label: "Quotes", href: "/quotes", icon: FileText },
  { label: "Jobs", href: "/jobs", icon: Briefcase },
  { label: "Calendar", href: "/calendar", icon: Calendar },
];

export function SidebarNav({ isAdmin, needsReview = 0 }: { isAdmin: boolean; needsReview?: number }) {
  const pathname = usePathname();
  const all = isAdmin
    ? [
        ...items,
        { label: "Automations", href: "/settings/automations", icon: Zap },
        { label: "AI", href: "/settings/ai", icon: Sparkles },
        { label: "Mailboxes", href: "/settings/mailboxes", icon: Mail },
        { label: "Users", href: "/settings/users", icon: Settings },
      ]
    : items;
  return (
    <nav className="flex flex-col gap-0.5 p-2">
      {all.map(({ label, href, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium",
              active ? "bg-brand-50 text-brand-700" : "text-gray-700 hover:bg-gray-100",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
            {href === "/inbox" && needsReview > 0 ? (
              <span className="ml-auto rounded-full bg-[#ffcb00] px-1.5 text-[10px] font-semibold text-gray-900" title="Emails needing review">
                {needsReview}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
