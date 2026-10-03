"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { fetchProductImageAction, removeProductImageAction, saveProductQuoteContentAction, uploadProductImageAction } from "@/actions/proposals";
import { Badge, Button, Field, FormError, Input, Select } from "@/components/ui";
import { KNOWLEDGE_STATUS_LABELS, KNOWLEDGE_STATUSES, type KnowledgeStatus } from "@/lib/brain/types";

export type ProductQuoteContent = {
  displayName: string | null;
  description: string | null;
  highlights: string[];
  featureNotes: string | null;
  imageId: string | null;
  showCard: boolean | null;
  status: KnowledgeStatus;
};

/**
 * What a customer sees about a product on a proposal: a friendly name, one short sentence, 2–4
 * highlights and a photo. Kept apart from the technical specification and reused by every quote.
 */
export function ProductProposalContent({ productId, content, canApprove }: { productId: string; content: ProductQuoteContent; canApprove: boolean }) {
  const router = useRouter();
  const [name, setName] = React.useState(content.displayName ?? "");
  const [description, setDescription] = React.useState(content.description ?? "");
  const [highlights, setHighlights] = React.useState<string[]>([...content.highlights, "", "", "", ""].slice(0, 4));
  const [notes, setNotes] = React.useState(content.featureNotes ?? "");
  const [card, setCard] = React.useState(content.showCard == null ? "auto" : content.showCard ? "yes" : "no");
  const [status, setStatus] = React.useState<KnowledgeStatus>(content.status);
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const fileRef = React.useRef<HTMLInputElement>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setError(null);
    setMsg(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Failed");
      setMsg(done);
      router.refresh();
    });
  }

  const save = () =>
    run(
      () =>
        saveProductQuoteContentAction({
          productId,
          displayName: name.trim() || null,
          description: description.trim() || null,
          highlights: highlights.map((h) => h.trim()).filter(Boolean),
          featureNotes: notes.trim() || null,
          showCard: card === "auto" ? null : card === "yes",
          status,
        }),
      "Proposal content saved.",
    );

  return (
    <div className="space-y-2 border-t border-gray-200 px-4 py-3" data-testid="proposal-content">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-semibold text-gray-700">Proposal content (what the customer sees)</p>
        <Badge className={status === "getsecure_approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>{KNOWLEDGE_STATUS_LABELS[status]}</Badge>
      </div>
      <div className="flex flex-wrap gap-4">
        <div className="w-28 shrink-0 space-y-1">
          {content.imageId ? (
            // eslint-disable-next-line @next/next/no-img-element -- authenticated API image
            <img src={`/api/catalogue-images/${content.imageId}`} alt={name || "Product photo"} className="h-28 w-28 rounded border border-gray-200 bg-white object-contain" data-testid="proposal-image" />
          ) : (
            <div className="flex h-28 w-28 items-center justify-center rounded border border-dashed border-gray-300 text-center text-[11px] text-gray-400">No photo: the PDF shows none</div>
          )}
          {content.imageId ? (
            <button type="button" className="text-[11px] text-red-600 hover:underline" disabled={pending} onClick={() => run(() => removeProductImageAction(productId), "Photo removed.")}>
              Remove photo
            </button>
          ) : null}
        </div>
        <div className="grid min-w-0 flex-1 gap-2 text-sm sm:grid-cols-2">
          <Field label="Name on proposals" htmlFor={`qn-${productId}`} hint="e.g. VIGI 5MP Full-Colour Turret Camera">
            <Input id={`qn-${productId}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Show as a product card" htmlFor={`qc-${productId}`}>
            <Select id={`qc-${productId}`} value={card} onChange={(e) => setCard(e.target.value)}>
              <option value="auto">By category (cameras, recorders, drives)</option>
              <option value="yes">Yes</option>
              <option value="no">No: list it only</option>
            </Select>
          </Field>
          <Field label="Short description" htmlFor={`qd-${productId}`} className="sm:col-span-2" hint="One sentence: what it is and what it does">
            <Input id={`qd-${productId}`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={220} />
          </Field>
          {highlights.map((h, i) => (
            <Field key={i} label={`Highlight ${i + 1}`} htmlFor={`qh-${productId}-${i}`}>
              <Input id={`qh-${productId}-${i}`} value={h} onChange={(e) => setHighlights((cur) => cur.map((x, n) => (n === i ? e.target.value : x)))} maxLength={60} />
            </Field>
          ))}
          <Field label="Feature notes (optional)" htmlFor={`qf-${productId}`} className="sm:col-span-2">
            <Input id={`qf-${productId}`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={240} />
          </Field>
          <Field label="Wording status" htmlFor={`qs-${productId}`}>
            <Select id={`qs-${productId}`} value={status} onChange={(e) => setStatus(e.target.value as KnowledgeStatus)}>
              {KNOWLEDGE_STATUSES.map((s) => (
                <option key={s} value={s} disabled={s === "getsecure_approved" && !canApprove}>
                  {KNOWLEDGE_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={pending} onClick={save} data-testid="save-proposal-content">
          Save proposal content
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label="Product photo file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const form = new FormData();
            form.set("productId", productId);
            form.set("file", f);
            run(() => uploadProductImageAction(form), "Photo stored.");
            e.target.value = "";
          }}
        />
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => fileRef.current?.click()}>
          Upload photo
        </Button>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="or paste the manufacturer's image address (https://…)" className="h-8 min-w-60 flex-1 text-xs" aria-label="Image address" />
        <Button size="sm" variant="secondary" disabled={pending || !url.trim()} onClick={() => run(() => fetchProductImageAction(productId, url), "Photo downloaded once and stored.")}>
          Fetch once
        </Button>
      </div>
      <p className="text-[11px] text-gray-500">The photo is stored in the CRM once (converted for print) and never fetched again when a PDF is made.</p>
      {msg ? <p className="text-xs text-green-700">{msg}</p> : null}
      <FormError message={error} />
    </div>
  );
}
