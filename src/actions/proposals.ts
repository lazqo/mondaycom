"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { products } from "@/db/schema";
import { requireAdmin, requireOffice } from "@/lib/auth";
import { assertApprover, humanFromUser, type Actor } from "@/lib/guard/actor";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { KNOWLEDGE_STATUSES } from "@/lib/brain/types";
import { updateQuoteContent } from "@/lib/quotes/workflow";
import { attachProposalToDraft, detachProposal, generateProposal } from "@/lib/proposals/workflow";
import { downloadImage, setProductImage, storeImage } from "@/lib/proposals/images";
import { saveProposalSettings, type ProposalSettings } from "@/lib/proposals/settings";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function office(): Promise<Extract<Actor, { kind: "human" }>> {
  return humanFromUser(await requireOffice()) as Extract<Actor, { kind: "human" }>;
}
async function admin(): Promise<Extract<Actor, { kind: "human" }>> {
  return humanFromUser(await requireAdmin()) as Extract<Actor, { kind: "human" }>;
}

function refresh(quoteId?: string) {
  if (quoteId) revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/approvals");
}

/** Make (or remake) the PDF from the approved quote. Nothing is sent. */
export async function generateProposalAction(quoteId: string): Promise<ActionResult<{ documentId: string; attachedTo: number }>> {
  try {
    const r = await generateProposal(quoteId, await office());
    refresh(quoteId);
    return ok({ documentId: r.documentId, attachedTo: r.attachedTo.length });
  } catch (err) {
    return fail(message(err));
  }
}

export async function attachProposalAction(draftId: string, quoteId: string): Promise<ActionResult<undefined>> {
  try {
    await attachProposalToDraft(draftId, quoteId, await office());
    refresh(quoteId);
    return ok(undefined);
  } catch (err) {
    return fail(message(err));
  }
}

export async function detachProposalAction(draftId: string): Promise<ActionResult<undefined>> {
  try {
    await detachProposal(draftId, await office());
    refresh();
    return ok(undefined);
  } catch (err) {
    return fail(message(err));
  }
}

/**
 * This quote's proposal validity: null = the standard, 0 = none, n = n days. It is printed on the
 * proposal, so changing it on an approved quote takes the approval (and the PDF) away.
 */
export async function setQuoteValidityAction(quoteId: string, validityDays: number | null): Promise<ActionResult<{ approvalVoided: boolean }>> {
  try {
    const v = z.number().int().min(0).max(365).nullable().parse(validityDays);
    const r = await updateQuoteContent(quoteId, { validityDays: v }, await office());
    refresh(quoteId);
    return ok(r);
  } catch (err) {
    return fail(message(err));
  }
}

// ---------- product proposal content ----------

const contentInput = z.object({
  productId: z.string().uuid(),
  displayName: z.string().trim().max(80).nullable(),
  description: z.string().trim().max(220).nullable(),
  highlights: z.array(z.string().trim().max(60)).max(4),
  featureNotes: z.string().trim().max(240).nullable(),
  showCard: z.boolean().nullable(),
  status: z.enum(KNOWLEDGE_STATUSES),
});

export async function saveProductQuoteContentAction(input: unknown): Promise<ActionResult<undefined>> {
  try {
    const actor = await admin();
    const parsed = contentInput.safeParse(input);
    if (!parsed.success) return fail(`${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    const d = parsed.data;
    if (d.status === "getsecure_approved") assertApprover(actor);
    await db
      .update(products)
      .set({
        quoteDisplayName: d.displayName || null,
        quoteDescription: d.description || null,
        quoteHighlights: d.highlights.filter(Boolean),
        quoteFeatureNotes: d.featureNotes || null,
        quoteShowCard: d.showCard,
        quoteContentStatus: d.status,
        quoteContentUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(products.id, d.productId));
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(message(err));
  }
}

/** Upload the product's proposal image (stored once, converted for print). */
export async function uploadProductImageAction(form: FormData): Promise<ActionResult<{ imageId: string }>> {
  try {
    const actor = await admin();
    const productId = z.string().uuid().parse(form.get("productId"));
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return fail("Choose an image file.");
    const imageId = await storeImage({ content: Buffer.from(await file.arrayBuffer()), filename: file.name, uploadedById: actor.userId });
    await setProductImage(productId, imageId);
    revalidatePath("/settings/brain");
    return ok({ imageId });
  } catch (err) {
    return fail(message(err));
  }
}

/** Download the image once from the manufacturer's page address and store it. */
export async function fetchProductImageAction(productId: string, url: string): Promise<ActionResult<{ imageId: string }>> {
  try {
    const actor = await admin();
    z.string().uuid().parse(productId);
    const content = await downloadImage(url);
    const name = new URL(url).pathname.split("/").pop() || "image";
    const imageId = await storeImage({ content, filename: name, sourceUrl: url, uploadedById: actor.userId });
    await setProductImage(productId, imageId);
    revalidatePath("/settings/brain");
    return ok({ imageId });
  } catch (err) {
    return fail(message(err));
  }
}

export async function removeProductImageAction(productId: string): Promise<ActionResult<undefined>> {
  try {
    await admin();
    await setProductImage(z.string().uuid().parse(productId), null);
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(message(err));
  }
}

// ---------- company details and standard wording ----------

const settingsInput = z.object({
  companyName: z.string().trim().min(1).max(80),
  legalName: z.string().trim().max(120),
  phone: z.string().trim().max(40),
  email: z.string().trim().max(120),
  website: z.string().trim().max(120),
  address: z.string().trim().max(200),
  gstNumber: z.string().trim().max(20),
  validityDays: z.number().int().min(1).max(365).nullable(),
  warranty: z.string().max(1500),
  installationIncludes: z.string().max(1500),
  nextSteps: z.string().max(500),
});

export async function saveProposalSettingsAction(input: unknown): Promise<ActionResult<undefined>> {
  try {
    await admin();
    const parsed = settingsInput.safeParse(input);
    if (!parsed.success) return fail(`${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    await saveProposalSettings(parsed.data as ProposalSettings);
    revalidatePath("/settings/proposals");
    return ok(undefined);
  } catch (err) {
    return fail(message(err));
  }
}
