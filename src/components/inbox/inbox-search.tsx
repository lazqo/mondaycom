"use client";

import { useRouter } from "next/navigation";
import { Input } from "@/components/ui";

export function InboxSearch({ filter, q }: { filter: string; q: string }) {
  const router = useRouter();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = new FormData(e.currentTarget).get("q");
        router.push(`/inbox?filter=${filter}${v ? `&q=${encodeURIComponent(String(v))}` : ""}`);
      }}
      className="w-full sm:w-72"
    >
      <Input name="q" type="search" defaultValue={q} placeholder="Search sender, subject, body…" aria-label="Search inbox" className="h-9" />
    </form>
  );
}
