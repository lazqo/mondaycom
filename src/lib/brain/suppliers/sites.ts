/** Every supplier website the connector runner knows, by its connector key. */
import { CLEARDIGITAL_SITE } from "./cleardigital";
import { ITPLUS_SITE } from "./itplus";
import type { SupplierSite } from "./site";
import { SWL_SITE, VESTA_SITE } from "./webninja";

export type { SupplierSite } from "./site";

export const SITES: Record<string, SupplierSite> = Object.fromEntries([ITPLUS_SITE, CLEARDIGITAL_SITE, SWL_SITE, VESTA_SITE].map((s) => [s.key, s]));

export function siteFor(connector: string): SupplierSite {
  const site = SITES[connector];
  if (!site) throw new Error(`No connector called ${connector}.`);
  return site;
}
