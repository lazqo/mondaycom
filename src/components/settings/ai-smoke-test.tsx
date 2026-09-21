"use client";

import * as React from "react";
import { runAiSmokeTest } from "@/actions/ai";
import { Button, FormError } from "@/components/ui";

type Result = Awaited<ReturnType<typeof runAiSmokeTest>>;

export function AiSmokeTest() {
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<Result | null>(null);
  function run() {
    startTransition(async () => setResult(await runAiSmokeTest()));
  }
  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" onClick={run} disabled={pending}>
        {pending ? "Classifying…" : "Run smoke test on sample enquiries"}
      </Button>
      <p className="text-xs text-gray-500">Classifies nine bundled Get Secure enquiries with the active provider. Writes nothing.</p>
      {result && !result.ok ? <FormError message={result.error} /> : null}
      {result?.ok ? (
        <ul className="space-y-1 text-xs">
          {result.data.map((r) => (
            <li key={r.label} className="rounded border border-gray-200 px-2 py-1">
              <span className={r.error ? "text-red-600" : r.isLead ? "font-semibold text-green-700" : "font-semibold text-gray-600"}>{r.error ? "ERROR" : r.isLead ? "LEAD" : "NOT LEAD"}</span>{" "}
              {r.confidence != null ? `${Math.round(r.confidence * 100)}% ` : ""}
              <span className="text-gray-800">{r.label}</span>
              {r.error ? <span className="text-red-600"> — {r.error}</span> : <span className="text-gray-500"> — {r.fields}</span>}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
