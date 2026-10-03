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
  /** A residential tier asked for (by the customer or Chris). Ignored, with a note, for commercial. */
  requestedTier?: Tier | null;
  /** Recording profile to design with; the default for the property type when not given. */
  recordingProfileId?: string | null;
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
  | "wall_bracket"
  | "pole_bracket"
  | "conduit"
  | "accessory"
  | "kit"
  | "other";

export type PriceFreshness = "current" | "aging" | "stale" | "unknown";

export type ProductPrice = {
  supplier: string;
  supplierSku: string | null;
  costExGst: number;
  lastChecked: Date | string | null;
  confidence: number | null;
  /** Approved for quoting; a price awaiting review is not used. */
  approved: boolean;
  /** Set by the engine from lastChecked and the freshness policy. */
  freshness?: PriceFreshness;
  ageDays?: number | null;
  /** 1 = the brand's preferred supplier; null when no route covers this brand. */
  routeRank?: number | null;
  /** Why this supplier's offer was used. */
  routeNote?: string | null;
  stock?: string | null;
  /** Other suppliers' usable listings, for the approver to compare. Never shown to the customer. */
  alternatives?: { supplier: string; costExGst: number; approved: boolean; freshness: PriceFreshness; stock: string | null; routeRank: number | null }[];
};

/** One supplier's listing for a product, before the engine picks which one to quote from. */
export type ProductOffer = {
  supplierId: string;
  supplier: string;
  supplierIsDefault: boolean;
  supplierPriority: number;
  supplierSku: string | null;
  costExGst: number | null;
  approved: boolean;
  /** A held cost change waiting for review. Never used for quoting. */
  pendingCostExGst: number | null;
  priceOnApplication: boolean;
  stock: string | null;
  lastChecked: Date | string | null;
  confidence: number | null;
};

/** Get Secure's preferred supplier(s) per brand. */
export type BrandRoute = { brand: string; supplierId: string; supplier: string; rank: number; market: "residential" | "commercial" | "both"; status: KnowledgeStatus };

export type CompatibilityKind = "camera_nvr" | "camera_junction_box" | "camera_wall_bracket" | "camera_pole_bracket" | "nvr_hdd" | "kit_component";
export const COMPATIBILITY_KINDS: CompatibilityKind[] = ["camera_nvr", "camera_junction_box", "camera_wall_bracket", "camera_pole_bracket", "nvr_hdd", "kit_component"];
export type CompatibilityLink = { kind: CompatibilityKind; fromId: string; toId: string; quantity: number; status: KnowledgeStatus };

export type ProductBase = {
  id: string;
  manufacturer: string;
  /** Brand/family for routing and tiers ("TP-Link VIGI", "HiLook", "WD Purple"…). Defaults to the manufacturer. */
  family?: string | null;
  model: string;
  category: ProductCategory;
  residentialAllowed: boolean;
  commercialAllowed: boolean;
  tier: Tier | null;
  tierStatus?: KnowledgeStatus;
  status: KnowledgeStatus;
  /** The offer the engine quotes from; filled from `offers` per job. */
  price: ProductPrice | null;
  offers?: ProductOffer[];
  onvifProfiles?: string[];
  ecosystem?: string[];
  formFactor?: string | null;
  sourceUrl?: string | null;
  lastVerifiedAt?: Date | string | null;
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
  /** Highest main-stream bitrate the manufacturer publishes, Mbps: a capability, not a design value. */
  maxBitrateMbps?: number | null;
  /** Maximum power draw, W. */
  poeWatts: number | null;
  poeStandard?: string | null;
  analytics: string[];
  /** Built-in microphone. */
  audio?: boolean;
  speaker?: boolean;
  whiteLightRangeM?: number | null;
  activeDeterrence?: string[];
  ingress?: string[];
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
  outgoingMbps?: number | null;
  /** Highest camera resolution the recorder can record, MP. */
  recordingResolutionMaxMp?: number | null;
  /** Simultaneous decoding: channels at each resolution (MP, or "1080p" ≈ 2 MP). */
  decoding?: Record<string, number> | null;
  decodingText?: string | null;
  /** Camera families the manufacturer says the recorder supports natively. */
  compatibleFamilies?: string[];
};

export type HddProduct = ProductBase & { category: "hdd"; capacityTb: number; surveillanceRated: boolean };

export type SwitchProduct = ProductBase & { category: "poe_switch"; poePorts: number; poePerPortW: number | null; poeBudgetW: number | null };

export type OtherProduct = ProductBase & { category: Exclude<ProductCategory, "camera" | "nvr" | "hdd" | "poe_switch"> };

export type Product = CameraProduct | NvrProduct | HddProduct | SwitchProduct | OtherProduct;

export type InstallationPackage = {
  id: string;
  /** Exact package key, e.g. RES_CCTV_SINGLE_4. */
  key?: string | null;
  name: string;
  propertyType: PropertyType;
  /** The exact camera count the package covers. */
  cameraCount?: number | null;
  storeyType?: "single" | "double" | null;
  minCameras: number;
  maxCameras: number;
  storeys: number | null;
  /** Expected labour hours. Null until Get Secure enters it. */
  estimatedHours: number | null;
  /** Internal labour rate for this package, NZD/hour; null uses the policy rate. */
  labourRate?: number | null;
  /** Customer sell allowance for the installation, ex GST. Null until Get Secure sets it. */
  allowanceExGst: number | null;
  /** Internal standard-material cost for this package, ex GST. */
  materialCostExGst?: number | null;
  materialsPackageId?: string | null;
  conduitIncluded?: boolean;
  /** Internal conduit allowance, ex GST. */
  conduitAllowanceExGst?: number | null;
  /** Internal installation-complexity allowance, ex GST. */
  complexityAllowanceExGst?: number | null;
  includedMaterials: string[];
  assumptions: string[];
  exclusions: string[];
  version: number;
  status: KnowledgeStatus;
};

export type MaterialsPackage = {
  id: string;
  name: string;
  propertyType: PropertyType;
  customerDescription: string;
  items: { description: string; quantity?: string | null; costExGst?: number | null }[];
  costExGst: number | null;
  sellExGst: number | null;
  isDefault: boolean;
  version: number;
  status: KnowledgeStatus;
};

export type RecordingRule = {
  id: string;
  scope: "product" | "family" | "resolution";
  productId?: string | null;
  family?: string | null;
  minMp?: number | null;
  maxMp?: number | null;
  designBitrateMbps: number | null;
  codec?: string | null;
  frameRate?: number | null;
  note?: string | null;
};

export type RecordingProfile = {
  id: string;
  key: string;
  name: string;
  propertyType: PropertyType | "any";
  isDefault: boolean;
  codec: string | null;
  frameRate: number | null;
  bitrateControl: "CBR" | "VBR" | null;
  recordingMode: "continuous" | "motion" | null;
  retentionTargetDays: number | null;
  retentionMinimumDays: number | null;
  rules: RecordingRule[];
  version: number;
  status: KnowledgeStatus;
  approvedBy?: string | null;
  reviewedAt?: Date | string | null;
};

/** How one chosen camera is designed to record under the profile. */
export type CameraDesign = {
  productId: string;
  model: string;
  resolutionMp: number;
  codec: string | null;
  frameRate: number | null;
  /** The bitrate used for bandwidth and storage. Null until the profile sets one for this camera. */
  designBitrateMbps: number | null;
  bitrateSource: string | null;
  bitrateApproved: boolean;
  publishedMaxBitrateMbps: number | null;
};

export type Catalogue = {
  products: Product[];
  packages: InstallationPackage[];
  materialsPackages?: MaterialsPackage[];
  compatibility?: CompatibilityLink[];
  routes?: BrandRoute[];
  recordingProfiles?: RecordingProfile[];
};

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
  junctionBoxSurfaces: PolicyValue<MountingSurface[]>;
  doubleStoreyConduit: PolicyValue<boolean>;
  priceAgingDays: PolicyValue<number>;
  priceStaleDays: PolicyValue<number>;
  priceChangeReviewPct: PolicyValue<number>;
  defaultResidentialTier: PolicyValue<Tier | null>;
  tiers: PolicyValue<Record<Tier, { targetMp: number | null; brands: string[]; description?: string; ecosystemOnly?: boolean }>>;
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

/**
 * `unverified`: passed because nothing contradicts it, but the catalogue lacks the data to prove it.
 * `warning`: passes the design, with a risk Chris should see (e.g. maximum possible bandwidth).
 */
export type Check = { name: string; pass: boolean; detail: string; unverified?: boolean; warning?: boolean };

export type NvrEvaluation = { product: NvrProduct; pass: boolean; checks: Check[] };

export type StorageResult = {
  totalMbps: number | null;
  retentionTargetDays: number;
  retentionSource: "customer" | "profile" | "policy";
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
  /** For an allowance line (conduit) charged as a set amount rather than a product. */
  allowanceExGst?: number | null;
};

export type LabourResult = {
  package: InstallationPackage | null;
  /** No exact package for this camera count/storey: a custom installation needing its own calculation. */
  customInstallation: boolean;
  estimatedHours: number | null;
  /** Customer sell allowance for the installation, ex GST. */
  allowanceExGst: number | null;
  /** "package_price" when the sell allowance is set; null otherwise. */
  basis: "package_price" | null;
  /** Internal costs, ex GST (null = not set). */
  labourCostExGst: number | null;
  materialCostExGst: number | null;
  conduitCostExGst: number | null;
  complexityCostExGst: number | null;
  /** Commercial inputs this package still needs before the installation is priced. */
  missing: string[];
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
  /** Snapshot of where the cost came from, kept with a prepared quote. */
  productId?: string | null;
  model?: string | null;
  supplier?: string | null;
  supplierSku?: string | null;
  lastChecked?: Date | string | null;
  freshness?: PriceFreshness | null;
  stock?: string | null;
  routeNote?: string | null;
  /** Other suppliers' listings for the approver (internal). */
  alternatives?: ProductPrice["alternatives"];
  /** Internal breakdown (materials package contents, kit components). Never shown to the customer. */
  detail?: string[];
  /** A cost Get Secure carries inside another customer line (materials, conduit, complexity). */
  internalOnly?: boolean;
};

export type Costing = {
  lines: CostLine[];
  equipmentCost: number;
  labourCost: number;
  materialsCost: number;
  /** Conduit and installation-complexity allowances. */
  allowancesCost: number;
  otherCost: number;
  /** Hardware + labour + materials + conduit + complexity + other: every known internal cost. */
  totalInternalCost: number;
  /** Gross profit and margin mean something only when `complete`; until then the sell side is partial. */
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
  /** Priced lines whose supplier price is stale or has no check date. */
  refreshRequired: { model: string; supplier: string | null; freshness: PriceFreshness }[];
  /** A supplier kit used for part of the hardware, if cheaper than its components. */
  kit: { productId: string; model: string; components: string[]; savingExGst: number } | null;
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
  recording: {
    mode: "continuous" | "motion";
    storage: StorageResult;
    profile: { id: string; key: string; name: string; status: KnowledgeStatus; codec: string | null; frameRate: number | null; bitrateControl: string | null } | null;
    /** Per chosen camera: design bitrate (used) and published maximum (warning only). */
    designs: CameraDesign[];
    designBandwidthMbps: number | null;
    maxPossibleBandwidthMbps: number | null;
  };
  network: NetworkResult;
  installation: {
    storeys: number | null;
    doubleStorey: boolean;
    junctionBoxRecommended: boolean;
    junctionBoxReason: string | null;
    conduitRequired: boolean;
    complexity: Level;
    materials: MaterialLine[];
    /** Documented accessories for the chosen cameras (junction boxes, brackets). */
    accessories?: { camera: string; kind: CompatibilityKind; product: string; productId: string }[];
  };
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
  /** Everything Get Secure must have entered and approved for this to be a real quote. */
  readiness: { ready: boolean; items: { key: string; label: string; ok: boolean; detail: string; fix: string | null }[] };
};
