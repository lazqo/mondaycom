"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/constants";
import { navItemsFor, type NavItem as Item } from "@/lib/nav";

const BADGE_TITLES: Record<string, string> = { "/dashboard": "Decisions waiting for you" };

/** `badges`: a count per nav href (emails needing review, Inspector items waiting). */
export function SidebarNav({ role, badges = {} }: { role: UserRole; badges?: Record<string, number> }) {
  const pathname = usePathname();
  const { main, settings } = navItemsFor(role);
  const render = (items: Item[]) =>
    items.map(({ label, href, icon: Icon }) => {
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
          {(badges[href] ?? 0) > 0 ? (
            <span className="ml-auto rounded-full bg-[#ffcb00] px-1.5 text-[10px] font-semibold text-gray-900" title={BADGE_TITLES[href]}>
              {badges[href]}
            </span>
          ) : null}
        </Link>
      );
    });
  return (
    <nav className="flex flex-col gap-0.5 p-2">
      {render(main)}
      {settings.length ? <p className="mt-3 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Settings</p> : null}
      {render(settings)}
    </nav>
  );
}
