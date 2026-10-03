/**
 * The proposal's customer-facing data and PDF: built only from the approved quote lines and the
 * products' customer content, with nothing internal in it, and rendering cleanly with or without
 * product photos.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildProposalData, noteSections, RECORDING_DURATION_NOTE, type ProposalProductSource } from "@/lib/proposals/data";
import { PROPOSAL_DEFAULTS, upgradeProposalSettings } from "@/lib/proposals/settings";
import { ATTACHMENT_LINE, withAttachmentLine, withoutAttachmentLine } from "@/lib/proposals/email-line";
import { prepareImage } from "@/lib/proposals/image-prep";
import { renderProposalPdf } from "@/lib/proposals/render";

const product = (id: string, category: string, over: Partial<ProposalProductSource> = {}): ProposalProductSource => ({
  id,
  manufacturer: "TP-Link",
  model: `VIGI ${id.toUpperCase()}`,
  category,
  specs: category === "hdd" ? { capacityTb: 4 } : {},
  quoteDisplayName: null,
  quoteDescription: null,
  quoteHighlights: [],
  quoteFeatureNotes: null,
  quoteImageId: null,
  quoteShowCard: null,
  ...over,
});

const lines = [
  { description: "5 MP TP-Link VIGI InSight S455(2.8mm) camera", quantity: 4, unitPrice: 189.13 },
  { description: "4-channel TP-Link recorder (VIGI NVR1004H-4P)", quantity: 1, unitPrice: 262.5 },
  { description: "4 TB surveillance hard drive", quantity: 1, unitPrice: 236.25 },
  { description: "TP-Link VJB-240", quantity: 4, unitPrice: 32.25 },
  { description: "Installation, commissioning, cabling and standard installation materials", quantity: 1, unitPrice: 990 },
];
// The snapshot carries internal fields; the builder must ignore all of them.
const snapshot = {
  lines: [
    { customerDescription: lines[0].description, productId: "cam", kind: "hardware", supplier: "IT Plus", supplierSku: "S455-2.8", unitCostExGst: 151.3, markupPct: 25 },
    { customerDescription: lines[1].description, productId: "nvr", kind: "hardware", supplier: "IT Plus", supplierSku: "NVR1004H-4P", unitCostExGst: 210 },
    { customerDescription: lines[2].description, productId: "hdd", kind: "hardware", supplier: "IT Plus", supplierSku: "WD43PURZ-SUP", unitCostExGst: 189 },
    { customerDescription: lines[3].description, productId: "jb", kind: "hardware", supplier: "IT Plus", supplierSku: "VJB-240", unitCostExGst: 25.8 },
    { customerDescription: lines[4].description, productId: null, kind: "labour", unitCostExGst: 570 },
    { customerDescription: "Standard installation materials", productId: null, kind: "materials", internalOnly: true, unitCostExGst: 80 },
  ],
  labour: { hours: 6, rate: 95, labourCost: 570, materialCost: 80, complexityAllowance: 0, sellAllowance: 990 },
  markupPct: 25,
  grossProfit: 512.4,
  grossMarginPct: 31.2,
};
const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
const quote = {
  number: 1042,
  title: "4-camera CCTV system",
  lineItems: lines,
  taxRate: "15.00",
  subtotal: subtotal.toFixed(2),
  total: (Math.round(subtotal * 115) / 100).toFixed(2),
  approvedAt: "2026-10-03T22:00:00Z",
  internalCosting: snapshot,
  notes: "Assumptions:\n- Standard residential construction\n- 24/7 continuous recording\n\nExclusions:\n- Monitor/TV unless listed\n\nSubject to confirmation of site conditions on the day.",
};
const products = [
  product("cam", "camera", { quoteDisplayName: "VIGI 5MP Full-Colour Turret Camera", quoteDescription: "Outdoor 5MP camera.", quoteHighlights: ["5MP image quality", "Night vision", "Person detection", "Two-way audio", "a fifth one"], quoteImageId: "img-cam" }),
  product("nvr", "nvr", { quoteDisplayName: "VIGI 4-Channel PoE+ Recorder" }),
  product("hdd", "hdd", { manufacturer: "Western Digital", model: "WD43PURZ" }),
  product("jb", "junction_box", { quoteDisplayName: "VIGI Camera Junction Box" }),
];
const build = (over: Partial<Parameters<typeof buildProposalData>[0]> = {}) =>
  buildProposalData({ quote, products, customer: { name: "Aroha Ngata", site: "4 Kauri Street, Grey Lynn" }, coverage: ["Driveway", "Front door"], settings: PROPOSAL_DEFAULTS, ...over });

describe("proposal data", () => {
  it("cards for the main products only, with friendly names, the approved quantities and at most 4 highlights", () => {
    const d = build();
    expect(d.products.map((p) => [p.category, p.name, p.quantity])).toEqual([
      ["camera", "VIGI 5MP Full-Colour Turret Camera", 4],
      ["nvr", "VIGI 4-Channel PoE+ Recorder", 1],
      ["hdd", "Western Digital WD43PURZ", 1],
    ]);
    expect(d.products[0].highlights).toHaveLength(4);
    expect(d.products[0].model).toBe("TP-Link VIGI CAM");
    expect(d.items.map((i) => i.description)).toEqual([
      "VIGI 5MP Full-Colour Turret Camera",
      "VIGI 4-Channel PoE+ Recorder",
      "4 TB surveillance hard drive",
      "VIGI Camera Junction Box",
      "Installation, commissioning, cabling and standard installation materials",
    ]);
    expect(d.installation?.includes.length).toBeGreaterThan(0);
    expect(d.summary).toMatch(/4-camera security system, covering the driveway and front door, recording to a VIGI 4-Channel PoE\+ Recorder with 4 TB of storage/);
  });

  it("totals come from the approved lines (ex GST, GST, inc GST)", () => {
    const t = build().totals;
    expect(t.subtotalExGst).toBeCloseTo(subtotal, 2);
    expect(t.gst).toBeCloseTo(subtotal * 0.15, 2);
    expect(t.totalIncGst).toBe(Number(quote.total));
    expect(() => build({ quote: { ...quote, total: "1.00" } })).toThrow(/does not match/);
  });

  it("carries nothing internal: no supplier, SKU, cost, markup, margin, labour hours or rate", () => {
    const d = build();
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/IT Plus|S455-2\.8|WD43PURZ-SUP|151\.3|supplier|markup|margin|grossProfit|unitCost|"hours"|"rate"/i);
    // The internal-only materials line is not listed.
    expect(d.items.map((i) => i.description)).not.toContain("Standard installation materials");
  });

  it("a line Chris added or reworded is listed without a product card", () => {
    const extra = [...lines, { description: "Extra cable run to the garage", quantity: 1, unitPrice: 150 }];
    const sub = extra.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const d = build({ quote: { ...quote, lineItems: extra, subtotal: sub.toFixed(2), total: (Math.round(sub * 115) / 100).toFixed(2) } });
    expect(d.items.at(-1)).toEqual({ description: "Extra cable run to the garage", quantity: 1 });
    expect(d.products).toHaveLength(3);
  });

  it("notes become sections, and the recording-duration wording is always there for CCTV (never a number of days)", () => {
    expect(noteSections(quote.notes)).toEqual([
      { heading: "Assumptions", items: ["Standard residential construction", "24/7 continuous recording"] },
      { heading: "Exclusions", items: ["Monitor/TV unless listed"] },
      { heading: "Please note", items: ["Subject to confirmation of site conditions on the day."] },
    ]);
    const d = build();
    expect(d.notes.find((n) => n.heading === "Recording")?.items).toEqual([RECORDING_DURATION_NOTE]);
    expect(JSON.stringify(d)).not.toMatch(/\d+\s*days/i);
  });

  it("quotes are valid for 30 days by default; a quote can override or remove it", () => {
    expect(build().validUntil?.slice(0, 10)).toBe("2026-11-02"); // approved 3 Oct + 30 days
    expect(build({ quote: { ...quote, validityDays: 14 } }).validUntil?.slice(0, 10)).toBe("2026-10-17");
    expect(build({ quote: { ...quote, validityDays: 0 } }).validUntil).toBeNull();
    expect(build({ settings: { ...PROPOSAL_DEFAULTS, validityDays: null } }).validUntil).toBeNull();
    expect(build({ settings: { ...PROPOSAL_DEFAULTS, validityDays: null }, quote: { ...quote, validityDays: 10 } }).validUntil?.slice(0, 10)).toBe("2026-10-13");
  });

  it("customers see Get Secure Ltd; the legal entity GE Secure Limited is available for the footer", () => {
    expect(build().company).toMatchObject({ name: "Get Secure Ltd", legalName: "GE Secure Limited" });
  });

  it("warranty and next steps come from the settings (blank omits them)", () => {
    const d = build({ settings: { ...PROPOSAL_DEFAULTS, warranty: "", nextSteps: "" } });
    expect(d.warranty).toEqual([]);
    expect(d.nextSteps).toBeNull();
    expect(build().warranty.join(" ")).toMatch(/TP-Link VIGI: 2 years/);
  });
});

describe("settings saved by the first version", () => {
  it("move to the new company name and 30-day standard; anything Chris changed is kept", () => {
    expect(upgradeProposalSettings({ companyName: "Get Secure Limited", validityDays: null, phone: "09 111 1111" })).toEqual({ phone: "09 111 1111" });
    expect(upgradeProposalSettings({ companyName: "Get Secure NZ", validityDays: 14 })).toEqual({ companyName: "Get Secure NZ", validityDays: 14 });
    expect(upgradeProposalSettings({ version: 2, companyName: "Get Secure Limited", validityDays: null })).toMatchObject({ companyName: "Get Secure Limited", validityDays: null });
  });
});

describe("the email line added with the attached proposal", () => {
  const body = "Hi Aroha,\n\nThanks for getting in touch.\n\nI'd suggest 4 cameras.\n\nThanks,\nChris\nGet Secure";
  it("goes in before the sign-off, once", () => {
    const withLine = withAttachmentLine(body);
    expect(withLine).toBe("Hi Aroha,\n\nThanks for getting in touch.\n\nI'd suggest 4 cameras.\n\n" + ATTACHMENT_LINE + "\n\nThanks,\nChris\nGet Secure");
    expect(withAttachmentLine(withLine)).toBe(withLine);
  });
  it("is not added when the email already mentions an attachment, and is appended when there is no sign-off", () => {
    expect(withAttachmentLine("Hi, the quote is attached.")).toBe("Hi, the quote is attached.");
    expect(withAttachmentLine("Hi Aroha,\n\nHere it is.")).toBe("Hi Aroha,\n\nHere it is.\n\n" + ATTACHMENT_LINE);
  });
  it("comes out again when the attachment is removed", () => {
    expect(withoutAttachmentLine(withAttachmentLine(body))).toBe(body);
  });
});

describe("proposal PDF", () => {
  it("renders with the product photo, and without one, as a valid PDF", async () => {
    const img = await prepareImage(fs.readFileSync(path.join(process.cwd(), "src/lib/proposals/content/images/vigi-insight-s455.jpg")));
    const withImage = await renderProposalPdf(build(), { "img-cam": { data: img.content, contentType: img.contentType } });
    expect(withImage.subarray(0, 5).toString()).toBe("%PDF-");
    const noImages = await renderProposalPdf(build(), {});
    expect(noImages.subarray(0, 5).toString()).toBe("%PDF-");
    expect(noImages.length).toBeLessThan(withImage.length);
    const draft = await renderProposalPdf(build({ draft: true }), {});
    expect(draft.subarray(0, 5).toString()).toBe("%PDF-");
  }, 30_000);

  it("converts WebP or PNG photos to print-ready JPEG/PNG of at most 800 px", async () => {
    const sharp = (await import("sharp")).default;
    const webp = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#053225" } }).webp().toBuffer();
    const out = await prepareImage(webp);
    expect(out).toMatchObject({ contentType: "image/jpeg", width: 800, height: 600 });
    await expect(prepareImage(Buffer.from("not an image"))).rejects.toThrow(/not an image/);
  });
});
