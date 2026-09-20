import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-semibold text-gray-900">Not found</h1>
      <p className="text-sm text-gray-500">That record doesn&apos;t exist or was removed.</p>
      <Link href="/leads" className="text-sm text-brand-700 hover:underline">
        Back to leads
      </Link>
    </div>
  );
}
