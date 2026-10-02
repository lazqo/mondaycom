"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { prepareDraftsAction, runAssessmentAction } from "@/actions/brain";
import { Button, Card, CardHeader, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import type { EnquiryInput, Tri } from "@/lib/brain/types";

const TRI: { value: Tri; label: string }[] = [
  { value: "unknown", label: "Unknown" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];
const ANALYTICS = [
  { key: "human_vehicle", label: "Human/vehicle detection" },
  { key: "smart_search", label: "Smart search" },
  { key: "lpr", label: "Number plate recognition" },
];

function TriSelect({ id, label, value, onChange }: { id: string; label: string; value: Tri; onChange: (v: Tri) => void }) {
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as Tri)}>
        {TRI.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

export function AssessmentForm({
  leadId,
  initial,
  assessmentId,
  canApprove,
  profiles = [],
}: {
  leadId: string;
  initial: EnquiryInput;
  assessmentId: string | null;
  canApprove: boolean;
  profiles?: { id: string; name: string; propertyType: string; isDefault: boolean; designed: boolean }[];
}) {
  const router = useRouter();
  const [v, setV] = React.useState<EnquiryInput>(initial);
  const [areas, setAreas] = React.useState(initial.areas.join("\n"));
  const [markup, setMarkup] = React.useState("");
  const [competitor, setCompetitor] = React.useState(initial.competitorQuote?.price != null ? String(initial.competitorQuote.price) : "");
  const [error, setError] = React.useState<string | null>(null);
  const [made, setMade] = React.useState<{ draftId?: string; quoteId?: string; quoteNumber?: number } | null>(null);
  const [pending, startTransition] = React.useTransition();
  const set = <K extends keyof EnquiryInput>(k: K, val: EnquiryInput[K]) => setV((cur) => ({ ...cur, [k]: val }));
  const setC = (k: keyof NonNullable<EnquiryInput["commercial"]>, val: string) =>
    setV((cur) => ({ ...cur, commercial: { ...(cur.commercial ?? {}), [k]: k === "futureCameras" ? (val === "" ? null : Number(val)) : val || null } }));
  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  function run() {
    setError(null);
    setMade(null);
    const payload: EnquiryInput = {
      ...v,
      areas: areas
        .split("\n")
        .map((a) => a.trim())
        .filter(Boolean),
      competitorQuote: competitor.trim() ? { price: Number(competitor) } : null,
    };
    startTransition(async () => {
      const res = await runAssessmentAction(leadId, payload, canApprove && markup.trim() ? Number(markup) : null);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  function prepare(what: { email?: boolean; quote?: boolean }) {
    if (!assessmentId) return;
    setError(null);
    startTransition(async () => {
      const res = await prepareDraftsAction(assessmentId, what);
      if (!res.ok) return setError(res.error);
      setMade((cur) => ({ ...cur, ...res.data }));
      router.refresh();
    });
  }

  const commercial = v.propertyType === "commercial";
  return (
    <Card data-testid="assessment-form">
      <CardHeader title="Enquiry" />
      <div className="space-y-4 p-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Property" htmlFor="a-type">
            <Select id="a-type" value={v.propertyType ?? ""} onChange={(e) => set("propertyType", (e.target.value || null) as EnquiryInput["propertyType"])}>
              <option value="">Unknown</option>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
            </Select>
          </Field>
          <Field label="Job" htmlFor="a-job">
            <Select id="a-job" value={v.jobType ?? ""} onChange={(e) => set("jobType", (e.target.value || null) as EnquiryInput["jobType"])}>
              <option value="">Unknown</option>
              <option value="new">New system</option>
              <option value="upgrade">Upgrade</option>
              <option value="repair">Repair</option>
            </Select>
          </Field>
          <Field label="Address" htmlFor="a-address" className="col-span-2">
            <Input id="a-address" value={v.address ?? ""} onChange={(e) => set("address", e.target.value || null)} />
          </Field>
          <Field label="Cameras" htmlFor="a-count">
            <Input id="a-count" type="number" min={1} value={v.cameraCount ?? ""} onChange={(e) => set("cameraCount", num(e.target.value))} />
          </Field>
          {!commercial ? (
            <Field label="Storeys" htmlFor="a-storeys">
              <Input id="a-storeys" type="number" min={1} value={v.storeys ?? ""} onChange={(e) => set("storeys", num(e.target.value))} />
            </Field>
          ) : (
            <Field label="Future cameras" htmlFor="a-future">
              <Input id="a-future" type="number" min={0} value={v.commercial?.futureCameras ?? ""} onChange={(e) => setC("futureCameras", e.target.value)} />
            </Field>
          )}
          <Field label="Areas to cover (one per line)" htmlFor="a-areas" className="col-span-2">
            <Textarea id="a-areas" value={areas} onChange={(e) => setAreas(e.target.value)} className="min-h-20" placeholder={"Driveway\nFront door\nBackyard"} />
          </Field>
          <Field label="Outside walls" htmlFor="a-wall">
            <Select id="a-wall" value={v.mountingSurface} onChange={(e) => set("mountingSurface", e.target.value as EnquiryInput["mountingSurface"])}>
              {["unknown", "weatherboard", "timber", "brick", "concrete", "plaster", "metal"].map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Construction" htmlFor="a-construction">
            <Select id="a-construction" value={v.construction} onChange={(e) => set("construction", e.target.value as EnquiryInput["construction"])}>
              <option value="unknown">Unknown</option>
              <option value="standard">Standard house</option>
              <option value="unusual">Unusual</option>
            </Select>
          </Field>
          <TriSelect id="a-remote" label="Visible on aerial/street imagery" value={v.remoteAssessable} onChange={(x) => set("remoteAssessable", x)} />
          <Field label="Requested brand" htmlFor="a-brand">
            <Input id="a-brand" value={v.requestedBrand ?? ""} onChange={(e) => set("requestedBrand", e.target.value || null)} />
          </Field>
        </div>

        <fieldset className="grid grid-cols-2 gap-3 border-t border-gray-100 pt-3">
          <legend className="sr-only">Recording and network</legend>
          <Field label="Remote viewing on phone" htmlFor="a-rv">
            <Select id="a-rv" value={v.remoteViewing == null ? "" : v.remoteViewing ? "yes" : "no"} onChange={(e) => set("remoteViewing", e.target.value === "" ? null : e.target.value === "yes")}>
              <option value="">Unknown</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <TriSelect id="a-internet" label="Internet at property" value={v.internet} onChange={(x) => set("internet", x)} />
          <TriSelect id="a-router" label="Recorder next to router" value={v.recorderNearRouter} onChange={(x) => set("recorderNearRouter", x)} />
          <TriSelect id="a-wired" label="Cable route to router possible" value={v.wiredRoutePossible} onChange={(x) => set("wiredRoutePossible", x)} />
          <Field label="Recording profile" htmlFor="a-profile" hint="Sets design bitrates for bandwidth and storage">
            <Select id="a-profile" value={v.recordingProfileId ?? ""} onChange={(e) => set("recordingProfileId", e.target.value || null)}>
              <option value="">Default for the property type</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.designed ? "" : " (no design bitrates yet)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Retention asked for (days)" htmlFor="a-ret">
            <Input id="a-ret" type="number" min={1} value={v.retentionDays ?? ""} onChange={(e) => set("retentionDays", num(e.target.value))} placeholder="28 (standard)" />
          </Field>
          <Field label="Budget mentioned ($)" htmlFor="a-budget">
            <Input id="a-budget" type="number" min={0} value={v.budget ?? ""} onChange={(e) => set("budget", num(e.target.value))} />
          </Field>
        </fieldset>

        <div className="grid grid-cols-2 gap-2 border-t border-gray-100 pt-3">
          <Check label="Customer asked for a site visit" checked={v.siteVisitRequested} onChange={(x) => set("siteVisitRequested", x)} />
          <Check label="Cable access unclear" checked={v.accessUnclear} onChange={(x) => set("accessUnclear", x)} />
          <Check label="Unusual/custom system" checked={v.customSystem} onChange={(x) => set("customSystem", x)} />
          <Check label="Audio asked for" checked={v.audioRequested} onChange={(x) => set("audioRequested", x)} />
          {ANALYTICS.map((a) => (
            <Check key={a.key} label={a.label} checked={v.analytics.includes(a.key)} onChange={(x) => set("analytics", x ? [...v.analytics, a.key] : v.analytics.filter((k) => k !== a.key))} />
          ))}
        </div>

        {commercial ? (
          <div className="grid grid-cols-2 gap-3 border-t border-gray-100 pt-3">
            <Field label="Surveillance purpose" htmlFor="a-purpose" className="col-span-2">
              <Input id="a-purpose" value={v.commercial?.surveillancePurpose ?? ""} onChange={(e) => setC("surveillancePurpose", e.target.value)} />
            </Field>
            <Field label="Who can access footage" htmlFor="a-access">
              <Input id="a-access" value={v.commercial?.footageAccess ?? ""} onChange={(e) => setC("footageAccess", e.target.value)} />
            </Field>
            <Field label="Signage responsibility" htmlFor="a-signage">
              <Input id="a-signage" value={v.commercial?.signageResponsibility ?? ""} onChange={(e) => setC("signageResponsibility", e.target.value)} />
            </Field>
            {v.audioRequested ? (
              <Field label="Why audio is needed" htmlFor="a-audio" className="col-span-2">
                <Input id="a-audio" value={v.commercial?.audioJustification ?? ""} onChange={(e) => setC("audioJustification", e.target.value)} />
              </Field>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 border-t border-gray-100 pt-3">
          <Field label="Competitor's price, if mentioned ($)" htmlFor="a-comp">
            <Input id="a-comp" type="number" min={0} value={competitor} onChange={(e) => setCompetitor(e.target.value)} />
          </Field>
          {canApprove ? (
            <Field label="Markup override (%)" htmlFor="a-markup" hint="Blank uses the suggested markup">
              <Input id="a-markup" type="number" min={0} max={100} value={markup} onChange={(e) => setMarkup(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Customer's words" htmlFor="a-msg" className="col-span-2">
            <Textarea id="a-msg" value={v.message ?? ""} onChange={(e) => set("message", e.target.value || null)} className="min-h-24" />
          </Field>
        </div>

        <FormError message={error} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={run} disabled={pending} data-testid="run-assessment">
            {pending ? "Working…" : "Run assessment"}
          </Button>
          {assessmentId ? (
            <>
              <Button variant="secondary" onClick={() => prepare({ email: true })} disabled={pending} data-testid="prepare-email">
                Prepare reply draft
              </Button>
              <Button variant="secondary" onClick={() => prepare({ quote: true })} disabled={pending} data-testid="prepare-quote">
                Prepare quote
              </Button>
            </>
          ) : null}
        </div>
        {made ? (
          <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800" data-testid="prepared">
            Prepared for Chris to review:{" "}
            {made.draftId ? (
              <Link href="/approvals" className="underline">
                reply draft
              </Link>
            ) : null}
            {made.draftId && made.quoteId ? " and " : null}
            {made.quoteId ? (
              <Link href={`/quotes/${made.quoteId}`} className="underline">
                quote Q-{made.quoteNumber}
              </Link>
            ) : null}
            . Nothing has been sent.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
