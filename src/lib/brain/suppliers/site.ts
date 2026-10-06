/**
 * A supplier website the connector runner can log in to. Every site keeps the same rules (see
 * html.ts and connector.ts): the stored login is used server-side only, the only cost read is an
 * unambiguous price on a logged-in page with a known GST basis, CAPTCHA / MFA / challenges stop
 * the run, and failure text never carries the username, password or a cookie.
 */
import type { ConnectorError, WebResponse, WebSession } from "./web-session";
import type { CatalogueEntry, ParsedProductPage } from "./html";

export type SupplierSite = {
  /** The connector key stored on supplier_connectors.connector. */
  key: string;
  /** The supplier's name as shown in messages. */
  name: string;
  /** Where the site lives; the only host (besides a local test server) the login may be sent to. */
  baseUrl: string;
  /** Environment variable that may point the connector at a local stand-in for tests. */
  envVar: string;
  login: (session: WebSession, credential: { username: string | null; secret: string }) => Promise<void>;
  findInCatalogue: (session: WebSession, q: { skus?: string[]; search?: string }) => Promise<CatalogueEntry[]>;
  parseProductPage: (html: string) => ParsedProductPage;
  blockOf: (res: WebResponse) => ConnectorError | null;
};
