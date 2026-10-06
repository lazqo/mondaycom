/** Spelled-out words, near-spelling correction and partial phone numbers (src/lib/inspector/text.ts). */
import { describe, it, expect } from "vitest";
import { applySpelling, digitsFitInside, spelledWordsIn } from "@/lib/inspector/text";

describe("spelled-out words", () => {
  it("finds letters said one by one", () => {
    expect(spelledWordsIn("Houston. Houston E U S T O N. Houston Road.")).toEqual(["EUSTON"]);
    expect(spelledWordsIn("Twelve Houston Road, Mount Eden. That's E U S T O N.")).toEqual(["EUSTON"]);
    expect(spelledWordsIn("My name is Ngaire, N G A I R E, Kamu")).toEqual(["NGAIRE"]);
    expect(spelledWordsIn("Nothing spelled here, just a TV and an NVR")).toEqual([]);
  });
  it("corrects the transcriber's near-miss, leaves the rest", () => {
    expect(applySpelling("Houston Road", ["EUSTON"])).toEqual({ value: "Euston Road", from: "Houston", to: "Euston" });
    expect(applySpelling("Euston Road", ["EUSTON"])).toBeNull();
    expect(applySpelling("Great South Road", ["EUSTON"])).toBeNull();
  });
});

describe("a number read out with digits missing", () => {
  it("fits inside the real number", () => {
    expect(digitsFitInside("021283406", "02102839406")).toBe(true);
    expect(digitsFitInside("02128394", "02102839406")).toBe(true);
    expect(digitsFitInside("021999406", "02102839406")).toBe(false);
    expect(digitsFitInside("02128", "02102839406")).toBe(false); // too short to mean anything
  });
});
