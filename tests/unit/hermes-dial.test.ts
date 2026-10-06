/** The dial's three positions (src/lib/hermes/dial.ts): presets, the position a setting is on, confidence words. */
import { describe, it, expect } from "vitest";
import { AUTONOMY_DEFAULTS, DIAL_CLASSES, DIAL_LABELS, PRESETS, confidenceWord, normaliseAutonomy, positionOf } from "@/lib/hermes/dial";

describe("positions", () => {
  it("Normal is the default; every preset respects the floor and is recognised back", () => {
    expect(positionOf(AUTONOMY_DEFAULTS)).toBe("normal");
    for (const p of ["careful", "normal", "autonomous"] as const) {
      expect(positionOf(normaliseAutonomy(PRESETS[p]))).toBe(p);
      for (const c of DIAL_CLASSES) expect(normaliseAutonomy(PRESETS[p]).levels[c]).toBe(PRESETS[p].levels[c]);
    }
    // Quotes, replies and bookings never go below "do and ask" on any position.
    for (const p of ["careful", "normal", "autonomous"] as const) {
      expect(PRESETS[p].levels.prepare_customer_facing).not.toBe("do");
      expect(PRESETS[p].levels.proposal).not.toBe("do");
      expect(DIAL_LABELS.prepare_customer_facing.floor).toBe("do_and_ask");
    }
  });
  it("Careful needs more confidence than Normal, Autonomous less", () => {
    for (const c of DIAL_CLASSES) {
      expect(PRESETS.careful.thresholds[c]).toBeGreaterThanOrEqual(PRESETS.normal.thresholds[c]);
      expect(PRESETS.autonomous.thresholds[c]).toBeLessThanOrEqual(PRESETS.normal.thresholds[c]);
    }
  });
  it("a hand-set table is Custom", () => {
    expect(positionOf({ ...AUTONOMY_DEFAULTS, thresholds: { ...AUTONOMY_DEFAULTS.thresholds, internal_work: 0.45 } })).toBe("custom");
  });
});

describe("confidence words", () => {
  it("sure, fairly sure, guessing", () => {
    expect(confidenceWord(0.92)).toBe("sure");
    expect(confidenceWord("0.7")).toBe("fairly sure");
    expect(confidenceWord(0.45)).toBe("guessing");
    expect(confidenceWord(null)).toBeNull();
  });
});
