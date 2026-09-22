import { describe, it, expect } from "vitest";
import { parseWebsiteLead } from "@/lib/email/website-lead";

// The exact shape the Get Secure landing page sends, HTML flattened to text.
const REAL = `New Lead · CCTV Landing


ISAPELA

Phone 02108856692 tel:02108856692 Email isapelamasoe@live.com ServiceCCTV Installation

Call back tel:02108856692 Reply isapelamasoe@live.com


REQUEST SUMMARY

PropertyResidential HomeStoreysSingle storeyCameras4Current SetupNew InstallationTimelineAs Soon As PossibleAddress7 solo place manurewa

Sent from the Get Secure website. Reply to this email to respond directly to Isapela.
`;

describe("website lead parser", () => {
  const parsed = parseWebsiteLead({
    subject: "New Lead · CCTV Landing",
    text: REAL,
    fromAddress: "noreply@updates.getsecure.co.nz",
  });

  it("recognises the email as a website enquiry", () => {
    expect(parsed).not.toBeNull();
    expect(parsed!.extraction.is_lead).toBe(true);
    expect(parsed!.extraction.confidence).toBe(1);
  });

  it("pulls the customer's own contact details, not the sending robot's", () => {
    const x = parsed!.extraction;
    expect(x.contact_name).toBe("Isapela");
    expect(x.email).toBe("isapelamasoe@live.com");
    expect(x.phone).toBe("02108856692");
  });

  it("pulls the service and the site address", () => {
    const x = parsed!.extraction;
    expect(x.service).toBe("CCTV Installation");
    expect(x.site_address).toBe("7 solo place manurewa");
  });

  it("keeps every field the form collected", () => {
    expect(parsed!.fields).toMatchObject({
      Property: "Residential Home",
      Storeys: "Single storey",
      Cameras: "4",
      "Current Setup": "New Installation",
      Timeline: "As Soon As Possible",
    });
  });

  it("reads 'As Soon As Possible' as urgent", () => {
    expect(parsed!.extraction.urgency).toBe("urgent");
  });

  it("writes a summary a person can act on", () => {
    const s = parsed!.extraction.summary;
    expect(s).toContain("CCTV Installation");
    expect(s).toContain("7 solo place manurewa");
    expect(s).toContain("Cameras: 4");
  });

  it("ignores email that is not a website enquiry", () => {
    expect(parseWebsiteLead({ subject: "Invoice 123", text: "Please find attached.", fromAddress: "billing@supplier.co.nz" })).toBeNull();
  });
});
