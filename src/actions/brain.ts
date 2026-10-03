"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOffice } from "@/lib/auth";
import { humanFromUser } from "@/lib/guard/actor";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { prepareFromAssessment, repriceQuote, runAssessment } from "@/lib/brain/store";
import { assertApprover, GuardrailError } from "@/lib/guard/actor";
import { CAMERA_PURPOSES, type EnquiryInput } from "@/lib/brain/types";

const tri = z.enum(["yes", "no", "unknown"]);
const enquiry = z.object({
  propertyType: z.enum(["residential", "commercial"]).nullable(),
  jobType: z.enum(["new", "upgrade", "repair"]).nullable(),
  cameraCount: z.coerce.number().int().min(1).max(256).nullable(),
  areas: z.array(z.string().trim().max(120)).max(64),
  storeys: z.coerce.number().int().min(1).max(10).nullable(),
  address: z.string().trim().max(300).nullable(),
  recordingMode: z.enum(["continuous", "motion"]).nullable(),
  retentionDays: z.coerce.number().int().min(1).max(365).nullable(),
  remoteViewing: z.boolean().nullable(),
  internet: tri,
  recorderNearRouter: tri,
  wiredRoutePossible: tri,
  requestedBrand: z.string().trim().max(80).nullable(),
  budget: z.coerce.number().min(0).max(10_000_000).nullable(),
  siteVisitRequested: z.boolean(),
  urgency: z.enum(["low", "normal", "high", "urgent"]).nullable(),
  remoteAssessable: tri,
  construction: z.enum(["standard", "unusual", "unknown"]),
  accessUnclear: z.boolean(),
  customSystem: z.boolean(),
  mountingSurface: z.enum(["timber", "weatherboard", "brick", "concrete", "plaster", "metal", "unknown"]),
  analytics: z.array(z.string().trim().max(40)).max(10),
  audioRequested: z.boolean(),
  cameraPlan: z
    .array(
      z.object({
        purpose: z.enum(CAMERA_PURPOSES),
        targetArea: z.string().trim().max(120),
        distanceM: z.coerce.number().min(0).max(500).nullable().optional(),
        lighting: z.enum(["good", "low", "backlit", "none", "unknown"]).optional(),
      }),
    )
    .max(64)
    .optional(),
  commercial: z
    .object({
      futureCameras: z.coerce.number().int().min(0).max(512).nullable().optional(),
      surveillancePurpose: z.string().trim().max(500).nullable().optional(),
      areasMonitored: z.string().trim().max(500).nullable().optional(),
      footageAccess: z.string().trim().max(500).nullable().optional(),
      signageResponsibility: z.string().trim().max(200).nullable().optional(),
      audioJustification: z.string().trim().max(500).nullable().optional(),
    })
    .optional(),
  competitorQuote: z.object({ price: z.coerce.number().min(0).nullable().optional(), description: z.string().max(1000).nullable().optional() }).nullable().optional(),
  message: z.string().max(20000).nullable(),
  requestedTier: z.enum(["good", "better", "best", "premium"]).nullable().optional(),
  recordingProfileId: z.string().uuid().nullable().optional(),
  existing: z
    .object({
      systemType: z.enum(["ip_poe", "analogue_coax", "mixed", "unknown"]),
      recorder: z.string().trim().max(120).nullable(),
      cameraCount: z.coerce.number().int().min(0).max(256).nullable(),
      cableType: z.enum(["cat5e", "cat6", "coax", "other", "unknown"]),
      cableCondition: z.enum(["reusable", "not_reusable", "needs_testing", "unknown"]),
      locationsSuitable: tri,
      power: z.string().trim().max(300).nullable(),
      positions: z
        .object({ reuse: z.coerce.number().int().min(0).max(256), new: z.coerce.number().int().min(0).max(256), confirm: z.coerce.number().int().min(0).max(256) })
        .nullable()
        .optional(),
      coaxDecision: z.enum(["replace_with_cat6", "retain_coax"]).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export async function runAssessmentAction(leadId: string, input: unknown, markupOverride: number | null): Promise<ActionResult<{ id: string }>> {
  const user = await requireOffice();
  if (!z.string().uuid().safeParse(leadId).success) return fail("Invalid lead");
  const parsed = enquiry.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0] ? `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` : "Invalid input");
  try {
    const r = await runAssessment(leadId, parsed.data as EnquiryInput, humanFromUser(user), { markupOverride });
    revalidatePath(`/leads/${leadId}/assessment`);
    revalidatePath(`/leads/${leadId}`);
    return ok({ id: r.id });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Prepare the reply and/or quote for Chris. Lands in Approvals; nothing is sent. */
export async function prepareDraftsAction(assessmentId: string, what: { email?: boolean; quote?: boolean }): Promise<ActionResult<{ draftId?: string; quoteId?: string; quoteNumber?: number }>> {
  const user = await requireOffice();
  try {
    const r = await prepareFromAssessment(assessmentId, what, humanFromUser(user));
    revalidatePath("/approvals");
    revalidatePath("/quotes");
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Reprice a prepared quote with current supplier prices and rules. The quote goes back to Needs
 * Review; any approval is removed. A markup override needs an approver.
 */
export async function repriceQuoteAction(quoteId: string, markupOverride?: number | null): Promise<ActionResult<{ changed: boolean; complete: boolean }>> {
  const user = await requireOffice();
  try {
    const actor = humanFromUser(user);
    if (markupOverride != null) assertApprover(actor);
    const r = await repriceQuote(quoteId, actor, markupOverride !== undefined ? { markupOverride } : {});
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath("/approvals");
    return ok(r);
  } catch (err) {
    return fail(err instanceof GuardrailError || err instanceof Error ? err.message : String(err));
  }
}
