import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type JourneyStep = { key: string; label: string; state: "done" | "current" | "todo" | "skipped"; href?: string | null; hint?: string | null };

/** Lead → Site visit → Quote → Job → Done, shown on lead, quote and job pages so they feel like one flow. */
export function JourneyBar({ steps, cta }: { steps: JourneyStep[]; cta?: { label: string; href: string } | null }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2" data-testid="journey-bar">
      <ol className="flex flex-1 flex-wrap items-center gap-1 text-xs">
        {steps.map((s, i) => {
          const inner = (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium",
                s.state === "done" && "bg-green-100 text-green-800",
                s.state === "current" && "bg-brand-600 text-white",
                s.state === "todo" && "bg-gray-100 text-gray-500",
                s.state === "skipped" && "bg-gray-50 text-gray-400 line-through",
              )}
              title={s.hint ?? undefined}
            >
              {s.state === "done" ? <Check className="h-3 w-3" /> : null}
              {s.label}
            </span>
          );
          return (
            <li key={s.key} className="flex items-center gap-1">
              {s.href ? <Link href={s.href}>{inner}</Link> : inner}
              {i < steps.length - 1 ? <span className="text-gray-300">›</span> : null}
            </li>
          );
        })}
      </ol>
      {cta ? (
        <Link href={cta.href} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
          {cta.label}
        </Link>
      ) : null}
    </div>
  );
}
