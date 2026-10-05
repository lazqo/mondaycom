"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { saveHermesAutonomyAction } from "@/actions/hermes";
import { Button, Select } from "@/components/ui";
import { AUTONOMY_LEVELS, DIAL_CLASSES, DIAL_LABELS, type AutonomyLevel, type AutonomySettings, type DialClass } from "@/lib/hermes/dial";

const LEVEL_LABELS: Record<AutonomyLevel, string> = { do: "Do it", do_and_ask: "Do it, then ask me", ask_first: "Ask me first", never: "Never" };
const rank = (l: AutonomyLevel) => AUTONOMY_LEVELS.indexOf(l);

/** The autonomy dial: one row per class, a level and a confidence threshold. The floor is fixed in code. */
export function HermesAutonomyForm({ initial }: { initial: AutonomySettings }) {
  const router = useRouter();
  const [levels, setLevels] = React.useState(initial.levels);
  const [thresholds, setThresholds] = React.useState(initial.thresholds);
  const [pending, startTransition] = React.useTransition();
  const [note, setNote] = React.useState<string | null>(null);
  const save = () =>
    startTransition(async () => {
      setNote(null);
      const res = await saveHermesAutonomyAction({ levels, thresholds });
      if (!res.ok) return setNote(res.error);
      setLevels(res.data.levels);
      setThresholds(res.data.thresholds);
      setNote("Saved. New emails and conversations use it from now.");
      router.refresh();
    });
  return (
    <div className="space-y-3 px-4 py-3" data-testid="hermes-autonomy">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500">
            <th className="py-1 pr-3 font-medium">What Hermes may do</th>
            <th className="py-1 pr-3 font-medium">How far</th>
            <th className="py-1 font-medium">Only when at least … sure</th>
          </tr>
        </thead>
        <tbody>
          {DIAL_CLASSES.map((c: DialClass) => (
            <tr key={c} className="border-t border-gray-100 align-top">
              <td className="py-2 pr-3">
                <p className="font-medium text-gray-900">{DIAL_LABELS[c].label}</p>
                <p className="text-xs text-gray-500">{DIAL_LABELS[c].examples}</p>
              </td>
              <td className="py-2 pr-3">
                <Select value={levels[c]} aria-label={`${DIAL_LABELS[c].label} level`} onChange={(e) => setLevels({ ...levels, [c]: e.target.value as AutonomyLevel })}>
                  {AUTONOMY_LEVELS.filter((l) => rank(l) >= rank(DIAL_LABELS[c].floor)).map((l) => (
                    <option key={l} value={l}>
                      {LEVEL_LABELS[l]}
                    </option>
                  ))}
                </Select>
              </td>
              <td className="py-2">
                <div className="flex items-center gap-2">
                  <input type="range" min={30} max={100} step={5} value={Math.round(thresholds[c] * 100)} aria-label={`${DIAL_LABELS[c].label} confidence`} onChange={(e) => setThresholds({ ...thresholds, [c]: Number(e.target.value) / 100 })} />
                  <span className="w-10 text-xs text-gray-700">{Math.round(thresholds[c] * 100)}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={save} data-testid="save-autonomy">
          {pending ? "Saving…" : "Save"}
        </Button>
        {note ? <span className="text-xs text-gray-600">{note}</span> : null}
      </div>
    </div>
  );
}
