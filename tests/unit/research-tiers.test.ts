/** Research source trust tiers: manufacturer first, the general web only as supporting evidence. */
import { describe, it, expect } from "vitest";
import { gradeFindings, tierOf } from "@/lib/hermes/research";

const ctx = { supplierHosts: ["itplus.co.nz", "cleardigital.co.nz"], manufacturerWords: ["hikvision", "tplink", "westerndigital"] };

describe("tierOf", () => {
  it("ranks manufacturer, approved supplier, standards, technical and general sources", () => {
    expect(tierOf("crm:product:123", ctx)).toBe(0);
    expect(tierOf("https://www.hikvision.com/en/products/ds-2cd", ctx)).toBe(1);
    expect(tierOf("https://www.tp-link.com/nz/vigi", ctx)).toBe(1);
    expect(tierOf("https://www.itplus.co.nz/product/x", ctx)).toBe(2);
    expect(tierOf("https://www.standards.govt.nz/shop/as-nzs-62676", ctx)).toBe(3);
    expect(tierOf("https://ipvm.com/reports/x", ctx)).toBe(4);
    expect(tierOf("https://www.reddit.com/r/homesecurity", ctx)).toBe(5);
    expect(tierOf("not a url", ctx)).toBeNull();
    expect(tierOf("javascript:alert(1)", ctx)).toBeNull();
  });

  it("drops unsourced claims, caps general-web-only claims, and only CRM-backed claims are approved knowledge", () => {
    const g = gradeFindings(
      {
        summary: "",
        findings: [
          { claim: "a", confidence: 0.95, knowledge: "approved", sources: [{ url: "https://www.hikvision.com/x" }] },
          { claim: "b", confidence: 0.95, knowledge: "new", sources: [{ url: "https://someblog.example/x" }] },
          { claim: "c", confidence: 0.95, knowledge: "new", sources: [] },
        ],
      },
      ctx,
    );
    expect(g.map((x) => x.claim)).toEqual(["a", "b"]);
    expect(g[0]).toMatchObject({ knowledge: "new", bestTier: 1, confidence: 0.95 });
    expect(g[1]).toMatchObject({ confidence: 0.4, bestTier: 5 });
  });
});
