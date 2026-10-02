/**
 * The CCTV decision engine: enquiry + catalogue + policies in, decision packet out.
 *
 * Deterministic and side-effect free. It never contacts anyone and never invents a product, a
 * specification or a price. What it cannot settle from approved data it reports as missing,
 * unresolved, or needing Chris's approval.
 */
import { candidateCameras, chooseCameras } from "./cameras";
import { costQuote } from "./costing";
import { installationPlan, labourPlan } from "./installation";
import { networkPlan } from "./network";
import { channelsNeeded, isNvr, selectNvr } from "./nvr";
import { cameraPlan, missingInformation, requirementsSummary } from "./requirements";
import { salesRead } from "./sales";
import { siteVisitDecision } from "./site-visit";
import { requiredStorageGb, storagePlan } from "./storage";
import type {
  Approval,
  CameraChoice,
  CameraProduct,
  Catalogue,
  Confidence,
  DecisionPacket,
  EnquiryInput,
  KnowledgeStatus,
  Level,
  Policies,
  Tier,
  TierOption,
} from "./types";
import { TIERS, TRUSTED_STATUSES } from "./types";

export const ENGINE_VERSION = "cctv-0.1.0";

const LEVELS: Level[] = ["low", "medium", "high"];
const minLevel = (...ls: Level[]) => LEVELS[Math.min(...ls.map((l) => LEVELS.indexOf(l)))];

type Build = ReturnType<typeof buildSystem>;

/** Cameras, recorder, storage, network, installation and cost for one tier (or commercial). */
function buildSystem(input: EnquiryInput, catalogue: Catalogue, policies: Policies, tier: Tier | null, markupOverride: number | null | undefined) {
  const plan = cameraPlan(input, policies);
  const cams = candidateCameras(catalogue.products, input.propertyType, tier);
  const cameras = chooseCameras(plan.cameras, cams, policies);
  const chosen = cameras.map((c) => c.product).filter((p): p is CameraProduct => !!p);
  const allChosen = chosen.length === cameras.length && cameras.length > 0;

  const mode = input.recordingMode ?? policies.residentialDefaultRecording.value;
  const retention = input.retentionDays ?? policies.retentionTargetDays.value;
  const bitrates = chosen.map((c) => c.expectedBitrateMbps);
  const totalMbps = allChosen && bitrates.every((b) => b != null) ? (bitrates as number[]).reduce((s, b) => s + b, 0) : null;
  const requiredGb = totalMbps != null ? requiredStorageGb(totalMbps, retention, policies).requiredGb : null;

  const sizing = channelsNeeded(cameras.length, input.propertyType, input.commercial?.futureCameras, policies);
  const small = policies.residentialSmallRecorderChannels.value;
  const exact = input.propertyType !== "commercial" && cameras.length <= small.maxCameras ? small.channels : null;
  const nvrPick = allChosen
    ? selectNvr(catalogue.products.filter(isNvr), {
        cameras: chosen,
        channelsNeeded: sizing.channels,
        requiredGb,
        requiredFeatures: input.analytics.filter((a) => a !== "audio"),
        audio: input.audioRequested && (input.propertyType !== "commercial" || !!input.commercial?.audioJustification),
        alarmIo: false,
        products: catalogue.products,
        policies,
        propertyType: input.propertyType,
        tier,
        exactChannels: exact,
      })
    : { selected: null, evaluated: [], storageShortfall: false, notes: ["Cameras not all chosen, so no recorder was evaluated."] };

  const storage = storagePlan({ totalMbps, customerRetentionDays: input.retentionDays, nvr: nvrPick.selected, products: catalogue.products, policies });
  const network = networkPlan(input);
  const installation = installationPlan({ enquiry: input, cameras, nvr: nvrPick.selected, network, products: catalogue.products, policies });
  const labour = labourPlan({ enquiry: input, cameraCount: cameras.length, packages: catalogue.packages, policies });
  const costing = costQuote({
    cameras,
    nvr: nvrPick.selected,
    storage,
    materials: installation.materials,
    labour,
    residential: input.propertyType !== "commercial",
    policies,
    markupOverride,
  });
  return { plan, cameras, nvrPick, sizing, storage, network, installation, labour, costing, mode };
}

function chooseTier(input: EnquiryInput, policies: Policies, builds: Map<Tier, Build>): { tier: Tier | null; reason: string; needsChoice: boolean } {
  if (input.propertyType === "commercial") return { tier: null, reason: "Commercial: products chosen from requirements, not the residential tier ladder.", needsChoice: false };
  const tiers = policies.tiers.value;
  if (input.requestedBrand) {
    const want = input.requestedBrand.toLowerCase();
    const t = TIERS.find((x) => tiers[x].brands.some((b) => b.toLowerCase().includes(want) || want.includes(b.toLowerCase())));
    if (t) return { tier: t, reason: `Customer asked for ${input.requestedBrand}.`, needsChoice: false };
  }
  const def = policies.defaultResidentialTier.value;
  if (def) return { tier: def, reason: `Get Secure default tier (${policies.defaultResidentialTier.status}).`, needsChoice: !TRUSTED_STATUSES.includes(policies.defaultResidentialTier.status) };
  const firstComplete = TIERS.find((t) => builds.get(t)?.costing.complete);
  if (firstComplete) return { tier: firstComplete, reason: "No default tier set: showing the first fully priced option. Chris to choose.", needsChoice: true };
  const firstWithCameras = TIERS.find((t) => builds.get(t)?.cameras.some((c) => c.product));
  return { tier: firstWithCameras ?? "good", reason: "No default tier set and no tier fully priced. Chris to choose.", needsChoice: true };
}

function confidenceFor(b: Build, siteVisit: ReturnType<typeof siteVisitDecision>, policies: Policies, now: Date): Confidence {
  const reasons: string[] = [];
  let technical: Level = "high";
  if (b.cameras.some((c) => !c.product) || !b.nvrPick.selected || b.storage.status === "below_minimum" || b.storage.status === "cannot_calculate") {
    technical = "low";
    reasons.push("Technical: system incomplete (camera, recorder or storage not settled).");
  } else {
    if (b.cameras.some((c) => c.pixelDensity == null)) {
      technical = "medium";
      reasons.push("Technical: camera distances not known, pixel density not validated.");
    }
    if (b.storage.status === "below_target" || b.nvrPick.storageShortfall) {
      technical = "medium";
      reasons.push("Technical: retention below the target.");
    }
    if (b.network.method === "unresolved") {
      technical = minLevel(technical, "medium");
      reasons.push("Technical: network not resolved.");
    }
  }

  let pricing: Level = "high";
  if (!b.costing.complete) {
    pricing = "low";
    reasons.push(`Pricing: incomplete (${b.costing.unpriced.length} item(s) unpriced).`);
  } else {
    const stale = policies.priceStaleDays.value;
    const products = [...b.cameras.map((c) => c.product), b.nvrPick.selected, b.storage.drives?.product].filter(Boolean);
    const old = products.filter((p) => !p!.price?.lastChecked || (now.getTime() - new Date(p!.price!.lastChecked!).getTime()) / 86400000 > stale);
    if (old.length) {
      pricing = "medium";
      reasons.push(`Pricing: ${old.length} price(s) older than ${stale} days.`);
    }
    if (b.costing.markupSource === "suggested" && !TRUSTED_STATUSES.includes(policies.suggestedMarkupPct.status)) {
      pricing = minLevel(pricing, "medium");
      reasons.push("Pricing: markup is a provisional suggestion.");
    }
    if (b.labour.package && !TRUSTED_STATUSES.includes(b.labour.package.status)) {
      pricing = minLevel(pricing, "medium");
      reasons.push("Pricing: installation package not approved.");
    }
  }

  const site: Level = siteVisit.required ? "low" : siteVisit.remoteQuoteConfidence;
  if (siteVisit.required) reasons.push("Site: visit required.");
  else if (site !== "high") reasons.push(`Site: ${siteVisit.reasons.join(" ")}`);
  return { technical, pricing, site, overall: minLevel(technical, pricing, site), reasons };
}

export function assessCctv(input: EnquiryInput, catalogue: Catalogue, policies: Policies, opts: { markupOverride?: number | null; now?: Date } = {}): DecisionPacket {
  const now = opts.now ?? new Date();
  const commercial = input.propertyType === "commercial";

  // Build every residential tier so the packet can offer good/better/best.
  const builds = new Map<Tier, Build>();
  if (!commercial) for (const t of TIERS) builds.set(t, buildSystem(input, catalogue, policies, t, opts.markupOverride));
  const tierChoice = chooseTier(input, policies, builds);
  const b = commercial ? buildSystem(input, catalogue, policies, null, opts.markupOverride) : builds.get(tierChoice.tier ?? "good")!;

  const siteVisit = siteVisitDecision(input, policies);
  const missing = missingInformation(input);
  const confidence = confidenceFor(b, siteVisit, policies, now);

  const tierOptions: TierOption[] = commercial
    ? []
    : TIERS.map((t) => {
        const x = builds.get(t)!;
        return {
          tier: t,
          complete: x.costing.complete,
          totalIncGst: x.costing.complete ? x.costing.totalIncGst : null,
          cameraModels: [...new Set(x.cameras.filter((c) => c.product).map((c) => `${c.product!.manufacturer} ${c.product!.model}`))],
        };
      });
  const idx = tierChoice.tier ? TIERS.indexOf(tierChoice.tier) : -1;
  const alternativeTier = idx >= 0 ? (TIERS.slice(idx + 1).find((t) => builds.get(t)?.cameras.some((c) => c.product)) ?? null) : null;

  // Interoperability notes.
  const interoperability: string[] = [];
  const nvr = b.nvrPick.selected;
  const chosen = b.cameras.map((c) => c.product).filter((p): p is CameraProduct => !!p);
  if (nvr && chosen.some((c) => c.manufacturer.toLowerCase() !== nvr.manufacturer.toLowerCase())) {
    interoperability.push("Mixed brands: ONVIF covers streaming, imaging settings and motion/tamper events, not every proprietary analytic.");
    if (input.analytics.length) interoperability.push(`Verify ${input.analytics.join(", ")} work between these brands before quoting.`);
  }

  // Privacy (commercial).
  const audioAsked = input.audioRequested;
  const audioJustified = !!input.commercial?.audioJustification;
  const privacy = commercial
    ? {
        // Never on by default: even with a stated purpose it stays off until Chris approves it.
        audioRecording: policies.audioDefault.value,
        checklist: [
          { item: "Surveillance purpose", answer: input.commercial?.surveillancePurpose ?? null },
          { item: "Areas monitored", answer: input.commercial?.areasMonitored ?? (input.areas.length ? input.areas.join(", ") : null) },
          { item: "Retention requirement", answer: input.retentionDays ? `${input.retentionDays} days` : null },
          { item: "Who can access footage", answer: input.commercial?.footageAccess ?? null },
          { item: "Signage responsibility", answer: input.commercial?.signageResponsibility ?? null },
          { item: "Audio requirement", answer: audioAsked ? (audioJustified ? `Requested: ${input.commercial!.audioJustification}` : "Requested, no purpose given") : "Not requested" },
        ],
        flags: audioAsked
          ? [
              "Audio recording requested. Audio is more intrusive than video; the Privacy Commissioner's guidance is to avoid it where video alone is enough.",
              audioJustified ? "A business purpose was given: Chris to review before audio is enabled." : "No business purpose given: audio stays off.",
            ]
          : [],
      }
    : null;

  // Assumptions, exclusions, risks, unresolved.
  const assumptions: string[] = [];
  const exclusions: string[] = [];
  const risks: string[] = [];
  const unresolved: string[] = [...b.network.unresolved, ...b.plan.notes];
  if (!commercial && !siteVisit.required) assumptions.push("Standard residential construction with accessible cable routes");
  if (b.installation.doubleStorey) assumptions.push("Upper-storey cable runs are reachable from the roof space or with conduit");
  if (b.cameras.some((c) => c.pixelDensity == null)) assumptions.push("Camera positions at typical residential distances");
  if (b.network.method === "wired_extension") assumptions.push("A cable route exists from the recorder to the router");
  if (b.network.method === "direct_lan") assumptions.push("The recorder sits next to the router");
  assumptions.push(`${b.mode === "continuous" ? "24/7 continuous" : "Motion"} recording, ${b.storage.retentionTargetDays} days target`);
  exclusions.push("Monitor/TV unless listed", "Electrical work beyond standard installation", "Internet connection and data costs");
  if (b.network.method === "cellular_option") exclusions.push("4G/5G router and data plan (offered as an option)");
  if (b.storage.status === "below_target") risks.push(`Only about ${b.storage.expectedRetentionDays} days of recording achievable against a ${b.storage.retentionTargetDays}-day target.`);
  if (b.storage.status === "below_minimum") risks.push(`Only about ${b.storage.expectedRetentionDays} days achievable: below the ${policies.retentionMinimumDays.value}-day minimum.`);
  if (b.installation.junctionBoxRecommended) risks.push(b.installation.junctionBoxReason!);
  for (const c of b.cameras) if (!c.product) unresolved.push(`${c.requirement.targetArea}: ${c.reasons[0]}`);
  if (!nvr) unresolved.push(...b.nvrPick.notes);
  unresolved.push(...b.labour.notes.filter((n) => n.startsWith("No installation package")));

  // Approvals Chris must give.
  const approvals: Approval[] = [
    { key: "customer_email", description: "Any email to the customer needs Chris's approval before it is sent." },
    { key: "quote", description: "Any quote needs Chris's approval before it is sent." },
  ];
  if (tierChoice.needsChoice) approvals.push({ key: "tier", description: "Choose the system tier (no approved default)." });
  if (b.installation.junctionBoxRecommended) approvals.push({ key: "junction_box", description: "Confirm junction boxes before they are charged." });
  if (b.costing.markupSource === "suggested" && !TRUSTED_STATUSES.includes(policies.suggestedMarkupPct.status)) approvals.push({ key: "markup", description: `Confirm the ${b.costing.markupPct}% markup (provisional).` });
  if (b.costing.markupSource === "override") approvals.push({ key: "markup_override", description: b.costing.markupLogic });
  const unapproved = [...chosen, nvr, b.storage.drives?.product].filter((p) => p && !TRUSTED_STATUSES.includes(p.status));
  if (unapproved.length) approvals.push({ key: "products", description: `Approve products: ${[...new Set(unapproved.map((p) => `${p!.manufacturer} ${p!.model}`))].join(", ")}.` });
  if (b.storage.status === "below_target" || b.storage.status === "below_minimum") approvals.push({ key: "retention", description: "Accept or change the reduced retention before quoting." });
  if (b.network.customerDecisions.length) approvals.push({ key: "connectivity", description: "4G/5G option and its ongoing data cost to be offered as a separate decision." });
  if (interoperability.length && input.analytics.length) approvals.push({ key: "interoperability", description: "Verify cross-brand analytics." });
  if (privacy?.flags.length) approvals.push({ key: "audio", description: "Audio recording requested: review the purpose; it stays off unless approved." });
  if (commercial) approvals.push({ key: "commercial_site_visit", description: "No final commercial BOM or fixed price before the site visit." });
  for (const m of b.installation.materials) if (m.approvalRequired && !["junction_box", "router_4g"].includes(m.key)) approvals.push({ key: `material:${m.key}`, description: `${m.description}: ${m.reason}` });

  const provisionalPolicies = (Object.entries(policies) as [string, { status: KnowledgeStatus; value: unknown }][])
    .filter(([, v]) => !TRUSTED_STATUSES.includes(v.status))
    .map(([key, v]) => ({ key, status: v.status, value: v.value }));

  const partial = {
    cameras: b.cameras,
    nvr: { selected: nvr, channelsNeeded: b.cameras.length ? b.sizing.channels : null, expansionChannels: b.sizing.expansion, evaluated: b.nvrPick.evaluated, notes: [...b.sizing.notes, ...b.nvrPick.notes] },
    recording: { mode: b.mode, storage: b.storage },
    costing: b.costing,
    labour: b.labour,
  };
  const blocking = missing.filter((m) => m.importance === "blocks_quote").length;
  const sales = salesRead({ enquiry: input, siteVisitRequired: siteVisit.required, confidence, blockingMissing: blocking, priceComplete: b.costing.complete, packet: partial });

  const nextAction =
    sales.recommendedAction === "arrange_site_visit"
      ? "Draft a reply proposing a site visit (Chris to approve)."
      : sales.recommendedAction === "ask_one_question"
        ? `Draft a reply asking: ${missing[0]?.question ?? "the one detail that changes the price"} (Chris to approve).`
        : sales.recommendedAction === "explain_value_difference"
          ? "Draft a factual like-for-like comparison (Chris to approve; no discount without Chris)."
          : sales.recommendedAction === "do_nothing_yet"
            ? "No action."
            : "Draft the quote and reply for Chris to review.";

  return {
    engineVersion: ENGINE_VERSION,
    customer: input.customerName ?? null,
    propertyType: input.propertyType,
    requirements: requirementsSummary(input, b.storage.retentionTargetDays, b.mode),
    missing,
    siteVisit,
    recommendedTier: tierChoice.tier,
    tierReason: tierChoice.reason,
    alternativeTier,
    tierOptions,
    ...partial,
    network: b.network,
    installation: {
      storeys: b.installation.storeys,
      doubleStorey: b.installation.doubleStorey,
      junctionBoxRecommended: b.installation.junctionBoxRecommended,
      junctionBoxReason: b.installation.junctionBoxReason,
      conduitRequired: b.installation.conduitRequired,
      complexity: b.installation.complexity,
      materials: b.installation.materials,
    },
    privacy,
    interoperability,
    assumptions,
    exclusions,
    risks,
    unresolved,
    confidence,
    sales,
    nextAction,
    approvals,
    provisionalPolicies,
  };
}

export type { CameraChoice };
