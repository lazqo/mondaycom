/**
 * Get Secure CCTV Business Brain: shared types.
 *
 * The engine is deterministic: given the same enquiry, catalogue, policies and installation
 * packages it always produces the same decision packet. Nothing in it invents a product, a
 * specification or a price; anything it cannot decide from approved data is reported as missing,
 * unresolved or needing approval.
 */

// ---------- provenance ----------

export const KNOWLEDGE_STATUSES = [
  "industry_fact",
  "manufacturer_verified",
  "getsecure_approved",
  "getsecure_provisional",
  "historical_reference",
  "requires_review",
  "deprecated",
] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_STATUS_LABELS: Record<KnowledgeStatus, string> = {
  industry_fact: "Industry fact",
  manufacturer_verified: "Manufacturer verified",
  getsecure_approved: "Get Secure approved",
  getsecure_provisional: "Get Secure provisional",
  historical_reference: "Historical reference",
  requires_review: "Requires review",
  deprecated: "Deprecated",
};

/** Statuses a quote may rely on without flagging it for Chris. */
export const TRUSTED_STATUSES: KnowledgeStatus[] = ["industry_fact", "manufacturer_verified", "getsecure_approved"];

export type Provenance = {
  status: KnowledgeStatus;
  source: string | null;
  sourceUrl?: string | null;
  createdAt?: Date | string | null;
  reviewedAt?: Date | string | null;
  approvedBy?: string | null;
  confidence?: number | null;
  notes?: string | null;
};

// ---------- enquiry ----------

export type PropertyType = "residential" | "commercial";
export type JobType = "new" | "upgrade" | "repair";
export type Tri = "yes" | "no" | "unknown";
export type MountingSurface = "timber" | "weatherboard" | "brick" | "concrete" | "plaster" | "metal" | "unknown";
export type Lighting = "good" | "low" | "backlit" | "none" | "unknown";
export type Urgency = "low" | "normal" | "high" | "urgent";
export type Tier = "good" | "better" | "best" | "premium";
export const TIERS: Tier[] = ["good", "better", "best", "premium"];

export const CAMERA_PURPOSES = [
  "overview",
  "driveway",
  "entrance_identification",
  "vehicle",
  "side_access",
  "backyard",
  "cash_register",
  "loading_area",
  "perimeter",
  "general",
] as const;
export type CameraPurpose = (typeof CAMERA_PURPOSES)[number];

/** IEC 62676-4 detail levels (detect, observe, recognise, identify). */
export type DetailLevel = "detect" | "observe" | "recognise" | "identify";

export type CameraRequirementInput = {
  purpose: CameraPurpose;
  targetArea: string;
  requiredDetail?: DetailLevel | null;
  distanceM?: number | null;
  sceneWidthM?: number | null;
  lighting?: Lighting;
  analyticsRequired?: string[];
  nightRequired?: boolean;
  mounting?: MountingSurface;
};

export type CommercialDetails = {
  futureCameras?: number | null;
  siteExpansionNotes?: string | null;
  vmsRequired?: boolean | null;
  redundancyRequired?: boolean | null;
  surveillancePurpose?: string | null;
  areasMonitored?: string | null;
  footageAccess?: string | null;
  signageResponsibility?: string | null;
  /** Why audio is needed, if it is asked for. Without it audio stays off. */
  audioJustification?: string | null;
};

export type CompetitorQuote = { price?: number | null; description?: string | null };

export type EnquiryInput = {
  propertyType: PropertyType | null;
  jobType: JobType | null;
  cameraCount: number | null;
  areas: string[];
  storeys: number | null;
  address: string | null;
  recordingMode: "continuous" | "motion" | null;
  /** Retention the customer asked for. Overrides the standard target. */
  retentionDays: number | null;
  remoteViewing: boolean | null;
  internet: Tri;
  recorderNearRouter: Tri;
  wiredRoutePossible: Tri;
  requestedBrand: string | null;
  /** NZD, as the customer stated it. */
  budget: number | null;
  siteVisitRequested: boolean;
  urgency: Urgency | null;
  /** Can the property be assessed from aerial/street imagery? */
  remoteAssessable: Tri;
  construction: "standard" | "unusual" | "unknown";
  /** Is cable access/route unclear enough to change the scope materially? */
  accessUnclear: boolean;
  /** Unusual or custom system that makes a remote estimate unreliable. */
  customSystem: boolean;
  mountingSurface: MountingSurface;
  analytics: string[];
  audioRequested: boolean;
  cameraPlan?: CameraRequirementInput[];
  commercial?: CommercialDetails;
  competitorQuote?: CompetitorQuote | null;
  /** The customer's own words, for the sales read. */
  message: string | null;
  /** Lead status, for the sales stage. */
  leadStatus?: string | null;
  existingCustomer?: boolean;
  customerName?: string | null;
};

// ---------- catalogue ----------

export type ProductCategory =
  | "camera"
  | "nvr"
  | "hdd"
  | "poe_switch"
  | "network"
  | "router_4g"
  | "ups"
  | "monitor"
  | "cable"
  | "junction_box"
  | "conduit"
  | "accessory"
  | "other";

export type ProductPrice = {
  supplier: string;
  supplierSku: string | null;
  costExGst: number;
  lastChecked: Date | string | null;
  confidence: number | null;
  /** Approved for quoting; a price awaiting review is not used. */
  approved: boolean;
};

export type ProductBase = {
  id: string;
  manufacturer: string;
  model: string;
  category: ProductCategory;
  market: "residential" | "commercial" | "both";
  tier: Tier | null;
  status: KnowledgeStatus;
  price: ProductPrice | null;
  onvifProfiles?: string[];
  warranty?: string | null;
  alternatives?: string[];
};

export type CameraProduct = ProductBase & {
  category: "camera";
  resolutionMp: number;
  horizontalPixels: number;
  /** Horizontal field of view in degrees at the lens setting quoted. */
  hfovDeg: number;
  lensMm?: number | null;
  irRangeM?: number | null;
  colourNight?: boolean;
  wdrDb?: number | null;
  codecs: string[];
  /** Average bitrate at the settings Get Secure installs with, Mbps. */
  expectedBitrateMbps: number | null;
  maxBitrateMbps?: number | null;
  poeWatts: number | null;
  analytics: string[];
  audio?: boolean;
};

export type NvrProduct = ProductBase & {
  category: "nvr";
  channels: number;
  incomingMbps: number;
  /** 0 for a recorder without PoE ports. */
  poePorts: number;
  poePerPortW: number | null;
  poeBudgetW: number | null;
  hddBays: number;
  maxHddTb: number;
  maxTotalTb: number;
  features: string[];
  audio?: boolean;
  alarmIo?: boolean;
};

export type HddProduct = ProductBase & { category: "hdd"; capacityTb: number; surveillanceRated: boolean };

export type SwitchProduct = ProductBase & { category: "poe_switch"; poePorts: number; poePerPortW: number | null; poeBudgetW: number | null };

export type OtherProduct = ProductBase & { category: Exclude<ProductCategory, "camera" | "nvr" | "hdd" | "poe_switch"> };

export type Product = CameraProduct | NvrProduct | HddProduct | SwitchProduct | OtherProduct;

export type InstallationPackage = {
  id: string;
  name: string;
  propertyType: PropertyType;
  minCameras: number;
  maxCameras: number;
  storeys: number | null;
  estimatedHours: number;
  /** Installation allowance charged, ex GST. */
  allowanceExGst: number;
  includedMaterials: string[];
  assumptions: string[];
  exclusions: string[];
  version: number;
  status: KnowledgeStatus;
};

export type Catalogue = { products: Product[]; packages: InstallationPackage[] };

// ---------- policy ----------

export type PolicyValue<T> = { value: T } & Provenance;

export type Policies = {
  labourRateResidential: PolicyValue<number>;
  labourRateCommercial: PolicyValue<number>;
  /** Internal cost of an hour of labour, if known; without it labour is not counted as a cost. */
  labourCostRate: PolicyValue<number | null>;
  retentionTargetDays: PolicyValue<number>;
  retentionMinimumDays: PolicyValue<number>;
  residentialDefaultRecording: PolicyValue<"continuous">;
  gbPerMbpsDay: PolicyValue<number>;
  storageHeadroomPct: PolicyValue<number>;
  hddUsableFraction: PolicyValue<number>;
  gstRate: PolicyValue<number>;
  suggestedMarkupPct: PolicyValue<number>;
  markupRangePct: PolicyValue<[number, number]>;
  residentialSmallRecorderChannels: PolicyValue<{ maxCameras: number; channels: number }>;
  ppmThresholds: PolicyValue<Record<DetailLevel, number>>;
  purposeDetail: PolicyValue<Record<CameraPurpose, DetailLevel>>;
  wdrRequiredDb: PolicyValue<number>;
  standardMaterials: PolicyValue<{ sellExGst: number | null; costExGst: number | null; contents: string[] }>;
  junctionBoxSurfaces: PolicyValue<MountingSurface[]>;
  doubleStoreyConduit: PolicyValue<boolean>;
  priceStaleDays: PolicyValue<number>;
  priceChangeReviewPct: PolicyValue<number>;
  defaultResidentialTier: PolicyValue<Tier | null>;
  tiers: PolicyValue<Record<Tier, { targetMp: number | null; brands: string[] }>>;
  commercialSiteVisitMandatory: PolicyValue<boolean>;
  audioDefault: PolicyValue<boolean>;
};

// ---------- output ----------

export type Level = "high" | "medium" | "low";
export type Importance = "blocks_quote" | "affects_price" | "nice_to_have";

export type MissingItem = { field: string; question: string; importance: Importance };

export type CameraRequirement = Required<Omit<CameraRequirementInput, "requiredDetail" | "distanceM" | "sceneWidthM">> & {
  id: string;
  requiredDetail: DetailLevel;
  distanceM: number | null;
  sceneWidthM: number | null;
};

export type CameraChoice = {
  requirement: CameraRequirement;
  product: CameraProduct | null;
  pixelDensity: number | null;
  /** Why this camera, or why none fits. */
  reasons: string[];
};

export type Check = { name: string; pass: boolean; detail: string };

export type NvrEvaluation = { product: NvrProduct; pass: boolean; checks: Check[] };

export type StorageResult = {
  totalMbps: number | null;
  retentionTargetDays: number;
  retentionSource: "customer" | "policy";
  rawGb: number | null;
  headroomPct: number;
  requiredGb: number | null;
  drives: { product: HddProduct; count: number } | null;
  installedTb: number | null;
  expectedRetentionDays: number | null;
  status: "meets_target" | "below_target" | "below_minimum" | "cannot_calculate";
  notes: string[];
};

export type NetworkResult = {
  remoteViewingRequired: boolean | null;
  internetStatus: Tri;
  method: "none_required" | "direct_lan" | "wired_extension" | "approved_bridge" | "cellular_option" | "unresolved";
  description: string;
  unresolved: string[];
  customerDecisions: string[];
};

export type MaterialLine = {
  key: string;
  description: string;
  quantity: number;
  product: Product | null;
  charged: boolean;
  approvalRequired: boolean;
  reason: string;
};

export type LabourResult = {
  package: InstallationPackage | null;
  estimatedHours: number | null;
  allowanceExGst: number | null;
  internalRate: number;
  internalReferenceExGst: number | null;
  notes: string[];
};

export type CostLine = {
  key: string;
  customerDescription: string;
  quantity: number;
  unitCostExGst: number | null;
  unitSellExGst: number | null;
  markupPct: number | null;
  kind: "hardware" | "labour" | "materials" | "other";
  priced: boolean;
};

export type Costing = {
  lines: CostLine[];
  equipmentCost: number;
  labourCost: number;
  materialsCost: number;
  otherCost: number;
  sellExGst: number;
  gst: number;
  totalIncGst: number;
  grossProfit: number;
  grossMarginPct: number | null;
  markupPct: number;
  markupSource: "suggested" | "override";
  markupLogic: string;
  complete: boolean;
  unpriced: string[];
};

export type Confidence = {
  technical: Level;
  pricing: Level;
  site: Level;
  overall: Level;
  reasons: string[];
};

export type SalesRead = {
  intent: "information_gathering" | "comparing_options" | "price_enquiry" | "active_buyer" | "urgent_problem" | "existing_customer";
  primaryConcern:
    | "price"
    | "security_risk"
    | "reliability"
    | "image_quality"
    | "remote_access"
    | "false_alarms"
    | "complexity"
    | "installation_disruption"
    | "trust"
    | "timing"
    | "unknown";
  stage: "discovery" | "qualification" | "quote_ready" | "quote_sent" | "objection" | "decision" | "won_lost";
  recommendedAction:
    | "provide_indicative_price"
    | "recommend_one_system"
    | "ask_one_question"
    | "arrange_site_visit"
    | "explain_value_difference"
    | "follow_up"
    | "do_nothing_yet";
  responseStyle: "indicative_price" | "good_better_best" | "formal_quote" | "site_visit";
  notes: string[];
  objectionChecklist: { item: string; ours: string }[] | null;
};

export type Approval = { key: string; description: string };

export type TierOption = { tier: Tier; complete: boolean; totalIncGst: number | null; cameraModels: string[] };

export type DecisionPacket = {
  engineVersion: string;
  customer: string | null;
  propertyType: PropertyType | null;
  requirements: string[];
  missing: MissingItem[];
  siteVisit: { required: boolean; reasons: string[]; remoteQuoteConfidence: Level };
  recommendedTier: Tier | null;
  tierReason: string;
  alternativeTier: Tier | null;
  tierOptions: TierOption[];
  cameras: CameraChoice[];
  nvr: { selected: NvrProduct | null; channelsNeeded: number | null; expansionChannels: number; evaluated: NvrEvaluation[]; notes: string[] };
  recording: { mode: "continuous" | "motion"; storage: StorageResult };
  network: NetworkResult;
  installation: { storeys: number | null; doubleStorey: boolean; junctionBoxRecommended: boolean; junctionBoxReason: string | null; conduitRequired: boolean; complexity: Level; materials: MaterialLine[] };
  labour: LabourResult;
  costing: Costing;
  privacy: { audioRecording: boolean; checklist: { item: string; answer: string | null }[]; flags: string[] } | null;
  interoperability: string[];
  assumptions: string[];
  exclusions: string[];
  risks: string[];
  unresolved: string[];
  confidence: Confidence;
  sales: SalesRead;
  nextAction: string;
  approvals: Approval[];
  /** Policies relied on that are not yet approved, with their status. */
  provisionalPolicies: { key: string; status: KnowledgeStatus; value: unknown }[];
};
