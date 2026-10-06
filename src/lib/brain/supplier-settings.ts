/**
 * How supplier prices and outside sources are handled, as Chris sets it in Settings → Business
 * Brain → Pricing. The floors stay in code: a public or retail price is never a supplier trade
 * cost, and a refresh never changes a quote already prepared.
 */
import { getSetting, setSetting } from "@/lib/settings";

export type SupplierPricingSettings = {
  /** A price read from a connected supplier, logged in, for a product already matched there: approved at once. */
  autoApprove: boolean;
  /** A change bigger than this (percent) is still held for Chris, auto-approval or not. */
  jumpPct: number;
  /** Retailers Get Secure buys from when no supplier stocks an item: valid research sources for a retail price (never a trade cost). */
  retailers: string[];
};

export const SUPPLIER_PRICING_DEFAULTS: SupplierPricingSettings = {
  autoApprove: false,
  jumpPct: 20,
  retailers: ["pbtech.co.nz", "noelleeming.co.nz", "harveynorman.co.nz", "bunnings.co.nz"],
};

const KEY = "supplier_pricing";

const host = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

export function normaliseSupplierPricing(raw: Partial<SupplierPricingSettings> | null | undefined): SupplierPricingSettings {
  const jump = Number(raw?.jumpPct);
  return {
    autoApprove: !!raw?.autoApprove,
    jumpPct: jump >= 0 && jump <= 100 ? Math.round(jump) : SUPPLIER_PRICING_DEFAULTS.jumpPct,
    retailers: Array.isArray(raw?.retailers) ? [...new Set(raw.retailers.map((r) => host(String(r))).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)))] : SUPPLIER_PRICING_DEFAULTS.retailers,
  };
}

export async function getSupplierPricingSettings(): Promise<SupplierPricingSettings> {
  return normaliseSupplierPricing(await getSetting<Partial<SupplierPricingSettings>>(KEY).catch(() => null));
}

export async function saveSupplierPricingSettings(patch: Partial<SupplierPricingSettings>): Promise<SupplierPricingSettings> {
  const next = normaliseSupplierPricing({ ...(await getSupplierPricingSettings()), ...patch });
  await setSetting(KEY, next);
  return next;
}
