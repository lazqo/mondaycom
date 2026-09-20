import Link from "next/link";
import { Avatar } from "@/components/ui";
import { logoutAction } from "@/actions/auth";
import type { SessionUser } from "@/lib/auth";
import { SidebarNav } from "./sidebar-nav";

export function AppShell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-gray-200 bg-white md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-gray-200 px-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
            GS
          </span>
          <Link href="/leads" className="text-sm font-semibold text-gray-900">
            Get Secure CRM
          </Link>
        </div>
        <SidebarNav isAdmin={user.role === "admin"} />
        <div className="mt-auto border-t border-gray-200 p-3">
          <div className="flex items-center gap-2">
            <Avatar name={user.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-900">{user.name}</p>
              <p className="truncate text-xs text-gray-500">{user.email}</p>
            </div>
          </div>
          <form action={logoutAction} className="mt-2">
            <button type="submit" className="w-full rounded-md px-2 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-100">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-4 md:hidden">
          <Link href="/leads" className="text-sm font-semibold text-gray-900">
            Get Secure CRM
          </Link>
          <MobileNav isAdmin={user.role === "admin"} />
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

function MobileNav({ isAdmin }: { isAdmin: boolean }) {
  const items = [
    ["Leads", "/leads"],
    ["Customers", "/contacts"],
    ["Quotes", "/quotes"],
    ["Jobs", "/jobs"],
    ["Calendar", "/calendar"],
    ...(isAdmin ? [["Users", "/settings/users"]] : []),
  ];
  return (
    <nav className="flex gap-3 overflow-x-auto text-sm">
      {items.map(([label, href]) => (
        <Link key={href} href={href} className="whitespace-nowrap text-gray-700 hover:text-brand-700">
          {label}
        </Link>
      ))}
    </nav>
  );
}
