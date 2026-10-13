import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { navItemsFor } from "@/lib/nav";

export const metadata: Metadata = { title: "Settings" };

/** One page for every setting, grouped by how often it is touched. */
export default async function SettingsPage() {
  const user = await requireAdmin();
  const { settingsPages } = navItemsFor(user.role);
  const groups = ["Every day", "Setup"] as const;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-600">Three things you touch often; the rest is set up once.</p>
      </div>
      {groups.map((g) => (
        <section key={g} className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{g}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {settingsPages
              .filter((p) => p.group === g)
              .map(({ label, href, icon: Icon, blurb }) => (
                <Link key={href} href={href} className="flex gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm hover:border-brand-300 hover:bg-brand-50/40" data-testid="settings-link">
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">{label}</span>
                    <span className="block text-xs text-gray-600">{blurb}</span>
                  </span>
                </Link>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
