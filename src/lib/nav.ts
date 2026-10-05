import { Users, Briefcase, FileText, Calendar, CalendarSync, Kanban, Settings, Inbox, Mail, Sun, Smartphone, BellRing, Sparkles, Activity, Mic, Brain, FileBadge } from "lucide-react";
import type { UserRole } from "@/lib/constants";

export type NavItem = { label: string; href: string; icon: React.ComponentType<{ className?: string }>; roles: UserRole[] };

const ITEMS: NavItem[] = [
  { label: "Home", href: "/dashboard", icon: Sun, roles: ["admin", "member"] },
  { label: "My day", href: "/my-day", icon: Smartphone, roles: ["admin", "member", "field"] },
  { label: "Inbox", href: "/inbox", icon: Inbox, roles: ["admin", "member"] },
  { label: "Leads", href: "/leads", icon: Kanban, roles: ["admin", "member"] },
  { label: "Customers", href: "/contacts", icon: Users, roles: ["admin", "member", "field"] },
  { label: "Recordings", href: "/recordings", icon: Mic, roles: ["admin", "member"] },
  { label: "Quotes", href: "/quotes", icon: FileText, roles: ["admin", "member"] },
  { label: "Jobs", href: "/jobs", icon: Briefcase, roles: ["admin", "member", "field"] },
  { label: "Calendar", href: "/calendar", icon: Calendar, roles: ["admin", "member", "field"] },
  { label: "Hermes", href: "/inspector", icon: Sparkles, roles: ["admin", "member"] },
];
const SETTINGS: NavItem[] = [
  { label: "Reminders", href: "/settings/automations", icon: BellRing, roles: ["admin"] },
  { label: "Hermes", href: "/settings/hermes", icon: Sparkles, roles: ["admin"] },
  { label: "Email accounts", href: "/settings/mailboxes", icon: Mail, roles: ["admin"] },
  { label: "Calendar sync", href: "/settings/calendar", icon: CalendarSync, roles: ["admin"] },
  { label: "Business Brain", href: "/settings/brain", icon: Brain, roles: ["admin"] },
  { label: "Proposals", href: "/settings/proposals", icon: FileBadge, roles: ["admin"] },
  { label: "Staff", href: "/settings/users", icon: Settings, roles: ["admin"] },
  { label: "System status", href: "/settings/status", icon: Activity, roles: ["admin"] },
];

/** Navigation for a role. Plain module so both server and client components can use it. */
export function navItemsFor(role: UserRole) {
  return { main: ITEMS.filter((i) => i.roles.includes(role)), settings: SETTINGS.filter((i) => i.roles.includes(role)) };
}
