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
/** The settings pages, in the order the Settings page lists them. */
export type SettingsPage = NavItem & { group: "Every day" | "Setup"; blurb: string };
export const SETTINGS_PAGES: SettingsPage[] = [
  { label: "Hermes", href: "/settings/hermes", icon: Sparkles, roles: ["admin"], group: "Every day", blurb: "How far Hermes goes on its own, and how it has been doing." },
  { label: "Business Brain", href: "/settings/brain", icon: Brain, roles: ["admin"], group: "Every day", blurb: "Products, supplier prices, suppliers and the quoting rules." },
  { label: "Next steps", href: "/settings/automations", icon: BellRing, roles: ["admin"], group: "Every day", blurb: "The one next step each lead and job carries, and when it nudges you." },
  { label: "Email accounts", href: "/settings/mailboxes", icon: Mail, roles: ["admin"], group: "Setup", blurb: "The Titan mailbox Hermes reads and replies from." },
  { label: "Calendar sync", href: "/settings/calendar", icon: CalendarSync, roles: ["admin"], group: "Setup", blurb: "Two-way sync with the Titan calendar." },
  { label: "Proposals", href: "/settings/proposals", icon: FileBadge, roles: ["admin"], group: "Setup", blurb: "The branded PDF that goes out with an approved quote." },
  { label: "Staff", href: "/settings/users", icon: Settings, roles: ["admin"], group: "Setup", blurb: "Who can sign in, and who can approve." },
  { label: "System status", href: "/settings/status", icon: Activity, roles: ["admin"], group: "Setup", blurb: "Health, backups and what is connected." },
];
const SETTINGS: NavItem[] = [{ label: "Settings", href: "/settings", icon: Settings, roles: ["admin"] }];

/** Navigation for a role. Plain module so both server and client components can use it. */
export function navItemsFor(role: UserRole) {
  return { main: ITEMS.filter((i) => i.roles.includes(role)), settings: SETTINGS.filter((i) => i.roles.includes(role)), settingsPages: SETTINGS_PAGES.filter((i) => i.roles.includes(role)) };
}
