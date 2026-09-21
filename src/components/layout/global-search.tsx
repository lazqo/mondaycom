"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search } from "lucide-react";

export function GlobalSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const initial = pathname === "/search" ? (sp.get("q") ?? "") : "";
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = String(new FormData(e.currentTarget).get("q") ?? "").trim();
        if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
      }}
      className="relative"
    >
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input
        name="q"
        type="search"
        defaultValue={initial}
        placeholder="Search name, phone, email, address"
        aria-label="Search"
        className="h-9 w-full rounded-md border border-gray-300 bg-gray-50 pl-8 pr-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
    </form>
  );
}
