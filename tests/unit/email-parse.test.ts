import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseRawEmail, normalizeSubject, isAutomatedMail, stripQuotedReply, makeSnippet } from "@/lib/email/parse";

const fx = (name: string) => readFileSync(`tests/fixtures/emails/${name}`);

describe("parseRawEmail", () => {
  it("parses a plain-text enquiry", async () => {
    const p = await parseRawEmail(fx("01-cctv-quote.eml"));
    expect(p.messageId).toBe("<cctv-quote-001@harbourview.co.nz>");
    expect(p.from).toEqual({ name: "Sarah Mitchell", address: "sarah@harbourview.co.nz" });
    expect(p.to[0].address).toBe("info@getsecure.co.nz");
    expect(p.subject).toBe("CCTV quote for apartment block");
    expect(p.text).toContain("12 Quay St");
    expect(p.attachments).toHaveLength(0);
  });

  it("keeps both text and html parts of a multipart message", async () => {
    const p = await parseRawEmail(fx("02-ajax-alarm.eml"));
    expect(p.text).toContain("Ajax alarm");
    expect(p.html).toContain("<p>");
  });

  it("captures attachments with metadata", async () => {
    const p = await parseRawEmail(fx("08-invoice.eml"));
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0].filename).toBe("INV-20419.pdf");
    expect(p.attachments[0].contentType).toBe("application/pdf");
    expect(p.attachments[0].content.length).toBeGreaterThan(10);
  });

  it("reads threading headers", async () => {
    const p = await parseRawEmail(fx("10-reply-on-thread.eml"));
    expect(p.inReplyTo).toBe("<cctv-quote-001@harbourview.co.nz>");
    expect(p.references).toEqual(["<cctv-quote-001@harbourview.co.nz>"]);
  });
});

describe("helpers", () => {
  it("normalises reply/forward subjects", () => {
    expect(normalizeSubject("Re: RE: Fwd: CCTV   quote")).toBe("cctv quote");
    expect(normalizeSubject("  Plain ")).toBe("plain");
  });

  it("flags automated mail by headers and sender", async () => {
    const p = await parseRawEmail(fx("07-newsletter.eml"));
    expect(isAutomatedMail(p)).toBeTruthy();
    const q = await parseRawEmail(fx("01-cctv-quote.eml"));
    expect(isAutomatedMail(q)).toBeNull();
    expect(isAutomatedMail({ headers: {}, from: { name: null, address: "mailer-daemon@x.example" }, subject: "x" })).toBe("bounce sender");
  });

  it("strips quoted replies and makes snippets", async () => {
    const p = await parseRawEmail(fx("10-reply-on-thread.eml"));
    const body = stripQuotedReply(p.text);
    expect(body).toContain("Tuesday or Wednesday");
    expect(body).not.toContain("Harbourview Apartments at 12 Quay St");
    expect(makeSnippet(p.text, 40).length).toBeLessThanOrEqual(40);
  });
});
