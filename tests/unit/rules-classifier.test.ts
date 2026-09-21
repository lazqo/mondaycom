import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseRawEmail } from "@/lib/email/parse";
import { RulesClassifier } from "@/lib/ai/rules-classifier";
import type { ClassificationInput } from "@/lib/ai/types";

async function inputFor(name: string): Promise<ClassificationInput> {
  const p = await parseRawEmail(readFileSync(`tests/fixtures/emails/${name}`));
  return { from: p.from, to: p.to.map((t) => t.address), subject: p.subject, receivedAt: p.date.toISOString(), text: p.text, attachments: [] };
}

const c = new RulesClassifier();

describe("RulesClassifier on realistic Get Secure enquiries", () => {
  it.each([
    ["01-cctv-quote.eml", "CCTV", "12 Quay St", "021 555 0142"],
    ["02-ajax-alarm.eml", "Ajax alarm", "27 Kauri Grove", "027 555 0311"],
    ["03-access-control.eml", "Access control", null, "09 555 0123"],
    ["04-intercom.eml", "Intercom", "8 Wharf Rd", "022 555 0107"],
    ["05-service-call.eml", "Alarm service", "45 Great South Rd", "027 555 0199"],
  ])("%s is a confident lead", async (file, service, address, phone) => {
    const r = (await c.classify(await inputFor(file))).result;
    expect(r.is_lead).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.75);
    expect(r.service).toBe(service);
    if (address) expect(r.site_address).toContain(address);
    expect(r.phone).toBe(phone);
    expect(r.email).toBeTruthy();
    expect(r.summary.length).toBeGreaterThan(10);
  });

  it("marks the urgent service call as urgent with a service next action", async () => {
    const r = (await c.classify(await inputFor("05-service-call.eml"))).result;
    expect(r.urgency).toBe("urgent");
    expect(r.next_action.toLowerCase()).toContain("service");
  });

  it("treats a maintenance request as a lead", async () => {
    const r = (await c.classify(await inputFor("06-maintenance.eml"))).result;
    expect(r.is_lead).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.75);
    expect(r.contact_name).toBe("Karen Liu");
  });

  it("rejects a newsletter and an invoice with high confidence", async () => {
    for (const f of ["07-newsletter.eml", "08-invoice.eml"]) {
      const r = (await c.classify(await inputFor(f))).result;
      expect(r.is_lead).toBe(false);
      expect(r.confidence).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("sends a vague one-liner to review (lead but low confidence)", async () => {
    const r = (await c.classify(await inputFor("09-vague.eml"))).result;
    expect(r.is_lead).toBe(true);
    expect(r.confidence).toBeLessThan(0.75);
  });

  it("extracts company from signature or domain", async () => {
    const a = (await c.classify(await inputFor("03-access-control.eml"))).result;
    expect(a.company).toBe("Westgate Retail Ltd");
    const b = (await c.classify(await inputFor("02-ajax-alarm.eml"))).result;
    expect(b.company).toBeNull();
  });
});
