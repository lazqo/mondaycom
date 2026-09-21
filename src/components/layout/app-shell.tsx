import Link from "next/link";
import { Avatar } from "@/components/ui";
import { logoutAction } from "@/actions/auth";
import type { SessionUser } from "@/lib/auth";
import type { Notification } from "@/db/schema";
import { USER_ROLE_META } from "@/lib/constants";
import { SidebarNav } from "./sidebar-nav";
import { navItemsFor } from "@/lib/nav";
import { NotificationsBell } from "./notifications-bell";
import { GlobalSearch } from "./global-search";

export function AppShell({
  user,
  needsReview = 0,
  notifications = [],
  unread = 0,
  children,
}: {
  user: SessionUser;
  needsReview?: number;
  notifications?: Notification[];
  unread?: number;
  children: React.ReactNode;
}) {
  const home = user.role === "field" ? "/my-day" : "/dashboard";
  const { main, settings } = navItemsFor(user.role);
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-gray-200 bg-white md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-gray-200 px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">GS</span>
          <Link href={home} className="whitespace-nowrap text-sm font-semibold text-gray-900">
            Get Secure CRM
          </Link>
        </div>
        <div className="px-3 pt-3">
          <GlobalSearch />
        </div>
        <SidebarNav role={user.role} needsReview={needsReview} />
        <div className="mt-auto border-t border-gray-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">Notifications</span>
            <NotificationsBell items={notifications} unread={unread} />
          </div>
          <div className="flex items-center gap-2">
            <Avatar name={user.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-900">{user.name}</p>
              <p className="truncate text-xs text-gray-500">{USER_ROLE_META[user.role].label}</p>
            </div>
            <form action={logoutAction}>
              <button type="submit" className="rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-gray-200 bg-white px-3 md:hidden">
          <Link href={home} className="flex shrink-0 items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-xs font-bold text-white">GS</span>
          </Link>
          <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto whitespace-nowrap text-sm [scrollbar-width:none]">
            {[...main, ...settings].map((i) => (
              <Link key={i.href} href={i.href} className="rounded-md px-2 py-1 text-gray-700 hover:bg-gray-100">
                {i.label}
              </Link>
            ))}
          </nav>
          <NotificationsBell items={notifications} unread={unread} />
          <form action={logoutAction}>
            <button type="submit" className="rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100" aria-label="Sign out">
              Out
            </button>
          </form>
        </header>
        <div className="border-b border-gray-200 bg-white px-3 py-2 md:hidden">
          <GlobalSearch />
        </div>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
