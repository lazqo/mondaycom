import { describe, it, expect } from "vitest";
import { isWebsiteLeadSender, parseWebsiteLead, personalEmail } from "@/lib/email/website-lead";

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

// The home page form: different labels again. It calls the site "Location", has no Storeys or
// Cameras, sends the timeline as a slug, and repeats the word "Property" inside its own value.
const HOME_PAGE = `New Lead · Home Page


DAVE LINCOLN

Phone 021593014 tel:021593014 Email dave@drinkhonest.co.nz Servicecctv

Call back tel:021593014 Reply dave@drinkhonest.co.nz


REQUEST SUMMARY

PropertyCommercial PropertyCurrent SetupbrokenTimelinethis-weekLocationPonsonby
`;

describe("website lead parser, home page form", () => {
  const parsed = parseWebsiteLead({
    subject: "New Lead · Home Page",
    text: HOME_PAGE,
    fromAddress: "noreply@updates.getsecure.co.nz",
  });

  it("reads the customer's own details", () => {
    const x = parsed!.extraction;
    expect(x.contact_name).toBe("Dave Lincoln");
    expect(x.email).toBe("dave@drinkhonest.co.nz");
    expect(x.phone).toBe("021593014");
  });

  it("reads the site from a Location label, not just Address", () => {
    expect(parsed!.extraction.site_address).toBe("Ponsonby");
  });

  it("does not let a field run past its own line", () => {
    // "Service cctv" is followed by the Call back line; none of that is the service.
    expect(parsed!.extraction.service).toBe("cctv");
  });

  it("keeps a value that repeats its own label word", () => {
    expect(parsed!.fields["Property"]).toBe("Commercial Property");
  });

  it("treats a slug timeline the same as words", () => {
    expect(parsed!.fields["Timeline"]).toBe("this-week");
    expect(parsed!.extraction.urgency).toBe("high");
  });
});

describe("the website's sending address", () => {
  it("is recognised even when LEAD_SENDER_ADDRESSES is not set", () => {
    const saved = process.env.LEAD_SENDER_ADDRESSES;
    delete process.env.LEAD_SENDER_ADDRESSES;
    try {
      expect(isWebsiteLeadSender("noreply@updates.getsecure.co.nz")).toBe(true);
      expect(isWebsiteLeadSender(" NoReply@Updates.GetSecure.co.nz ")).toBe(true);
      expect(isWebsiteLeadSender("chris@example.com")).toBe(false);
      expect(isWebsiteLeadSender(null)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LEAD_SENDER_ADDRESSES;
      else process.env.LEAD_SENDER_ADDRESSES = saved;
    }
  });

  it("is never kept as a person's email", () => {
    expect(personalEmail("noreply@updates.getsecure.co.nz")).toBeNull();
    expect(personalEmail("dave@example.com")).toBe("dave@example.com");
    expect(personalEmail("")).toBeNull();
  });
});
