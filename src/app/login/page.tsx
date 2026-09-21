import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  const { next } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
            GS
          </span>
          <div>
            <h1 className="text-base font-semibold text-gray-900">Get Secure CRM</h1>
            <p className="text-xs text-gray-500">Sign in to continue</p>
          </div>
        </div>
        <LoginForm next={next} />
      </div>
    </div>
  );
}
