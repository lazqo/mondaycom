/**
 * Company details and standard wording printed on customer proposals. Kept in app settings so Chris
 * can change them without a release. Customers see the trading name, Get Secure Ltd; the legal entity,
 * GE Secure Limited, is printed small in the footer. Contact details and warranty wording come from
 * Get Secure's own website (getsecure.co.nz and its published warranty page).
 */

export type ProposalSettings = {
  /** The name customers see (trading name). */
  companyName: string;
  /** Registered legal entity, printed small in the footer. Empty omits it. */
  legalName: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  /** NZ GST number, printed when set. */
  gstNumber: string;
  /** Standard days a proposal is valid for; null prints no validity. A quote can override it. */
  validityDays: number | null;
  /** Warranty and support wording (one point per line). Empty omits the section. */
  warranty: string;
  /** What the installation line covers, one point per line (CCTV). */
  installationIncludes: string;
  /** Closing "next steps" wording. Empty omits it. */
  nextSteps: string;
};

const KEY = "proposal";

export const PROPOSAL_DEFAULTS: ProposalSettings = {
  companyName: "Get Secure Ltd",
  legalName: "GE Secure Limited",
  phone: "09 977 9990",
  email: "info@getsecure.co.nz",
  website: "getsecure.co.nz",
  address: "",
  gstNumber: "",
  validityDays: 30,
  warranty: [
    "Every product carries the manufacturer's warranty (TP-Link VIGI: 2 years).",
    "Warranty claims are handled locally by Get Secure: you contact us, not the manufacturer.",
    "Installation labour (where Get Secure installed it): 12 months.",
  ].join("\n"),
  installationIncludes: [
    "Installation of the equipment listed in this proposal",
    "Cabling and standard installation materials",
    "Commissioning: recorder set-up and testing of every camera",
  ].join("\n"),
  nextSteps: "To go ahead, simply reply to this email or call us, and we'll arrange a time that suits you.",
};

/**
 * Settings saved by the first version (before the company identity and the 30-day standard were
 * decided) still carry that version's defaults; those two values move to the new defaults. Anything
 * Chris changed is kept.
 */
export function upgradeProposalSettings(stored: Partial<ProposalSettings> & { version?: number }): Partial<ProposalSettings> {
  if (stored.version && stored.version >= 2) return stored;
  const out: Partial<ProposalSettings> = { ...stored };
  if (out.companyName === "Get Secure Limited") delete out.companyName;
  if (out.validityDays === null) delete out.validityDays;
  return out;
}

export async function getProposalSettings(): Promise<ProposalSettings> {
  const { getSetting } = await import("@/lib/settings");
  const stored = (await getSetting<Partial<ProposalSettings> & { version?: number }>(KEY)) ?? {};
  const { version: _v, ...rest } = upgradeProposalSettings(stored) as Partial<ProposalSettings> & { version?: number };
  void _v;
  return { ...PROPOSAL_DEFAULTS, ...rest };
}

export async function saveProposalSettings(patch: Partial<ProposalSettings>): Promise<ProposalSettings> {
  const { setSetting } = await import("@/lib/settings");
  const next = { ...(await getProposalSettings()), ...patch };
  await setSetting(KEY, { ...next, version: 2 });
  return next;
}
