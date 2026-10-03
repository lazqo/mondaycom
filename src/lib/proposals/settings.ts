/**
 * Company details and standard wording printed on customer proposals. Kept in app settings so Chris
 * can change them without a release. The defaults come from Get Secure's own website
 * (getsecure.co.nz, including its published warranty page); nothing here is invented.
 */

export type ProposalSettings = {
  companyName: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  /** NZ GST number, printed when set. */
  gstNumber: string;
  /** Days the price is valid for; null prints no validity. */
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
  companyName: "Get Secure Limited",
  phone: "09 977 9990",
  email: "info@getsecure.co.nz",
  website: "getsecure.co.nz",
  address: "",
  gstNumber: "",
  validityDays: null,
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

export async function getProposalSettings(): Promise<ProposalSettings> {
  const { getSetting } = await import("@/lib/settings");
  return { ...PROPOSAL_DEFAULTS, ...((await getSetting<Partial<ProposalSettings>>(KEY)) ?? {}) };
}

export async function saveProposalSettings(patch: Partial<ProposalSettings>): Promise<ProposalSettings> {
  const { setSetting } = await import("@/lib/settings");
  const next = { ...(await getProposalSettings()), ...patch };
  await setSetting(KEY, next);
  return next;
}
