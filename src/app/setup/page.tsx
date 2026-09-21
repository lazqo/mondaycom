import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, homeFor } from "@/lib/auth";
import { getSetupSteps, hasAnyUser } from "@/lib/setup";
import { FirstAdminForm } from "@/components/setup/first-admin-form";
import { SetupChecklist } from "@/components/setup/setup-checklist";

export const metadata: Metadata = { title: "Set up" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!(await hasAnyUser())) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">GS</span>
            <div>
              <h1 className="text-base font-semibold text-gray-900">Welcome to Get Secure CRM</h1>
              <p className="text-xs text-gray-500">Step 1 of 6 · Create your admin login</p>
            </div>
          </div>
          <FirstAdminForm />
        </div>
      </div>
    );
  }
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/setup");
  if (user.role !== "admin") redirect(homeFor(user.role));
  const { steps, complete } = await getSetupSteps();
  return (
    <div className="mx-auto max-w-2xl p-4 md:p-8">
      <div className="mb-6">
        <Link href="/dashboard" className="text-xs text-gray-500 hover:text-brand-700">
          ← Today
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-gray-900">Set up Get Secure CRM</h1>
        <p className="text-sm text-gray-500">Work through these once. Each step checks itself, so you can come back any time.</p>
      </div>
      <SetupChecklist steps={steps} complete={complete} />
    </div>
  );
}
