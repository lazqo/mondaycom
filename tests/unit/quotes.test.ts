import { describe, it, expect } from "vitest";
import { computeTotals } from "@/lib/quotes";

describe("computeTotals", () => {
  it("applies GST to the subtotal", () => {
    const t = computeTotals(
      [
        { description: "Cameras", quantity: 4, unitPrice: 250 },
        { description: "Labour", quantity: 2.5, unitPrice: 120 },
      ],
      15,
    );
    expect(t.subtotal).toBe("1300.00");
    expect(t.tax).toBe("195.00");
    expect(t.total).toBe("1495.00");
  });

  it("handles empty quotes and zero tax", () => {
    expect(computeTotals([], 15)).toEqual({ subtotal: "0.00", tax: "0.00", total: "0.00" });
    expect(computeTotals([{ description: "x", quantity: 1, unitPrice: 99.99 }], 0).total).toBe("99.99");
  });
});
