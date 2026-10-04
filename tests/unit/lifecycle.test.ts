/** Which commitments a later CRM event proves were kept: only the specific ones it clearly proves. */
import { describe, it, expect } from "vitest";
import { satisfiedBy, type LifecycleEvent } from "@/lib/inspector/lifecycle";

const said = "2026-08-01T00:00:00.000Z";
const after = "2026-08-10T00:00:00.000Z";
const before = "2026-07-01T00:00:00.000Z";
const e = (kind: LifecycleEvent["kind"], at = after): LifecycleEvent => ({ kind, at, label: `${kind} on ${at.slice(0, 10)}` });
const c = (owner: string, action: string, actionKey = "other") => ({ owner, action, actionKey, at: said });

describe("satisfiedBy", () => {
  it("booking the installation visit: kept once the installation took place after it was said", () => {
    expect(satisfiedBy(c("get_secure", "Book the installation visit", "visit"), [e("job_done")])?.kind).toBe("job_done");
    expect(satisfiedBy(c("get_secure", "Book the installation visit", "visit"), [e("job_invoiced")])?.kind).toBe("job_invoiced");
    // A site visit is not the installation; a job only scheduled has not happened; before it was said proves nothing.
    expect(satisfiedBy(c("get_secure", "Book the installation visit", "visit"), [e("visit_held"), e("job_scheduled"), e("job_done", before)])).toBeNull();
  });

  it("a site visit / coming out: kept once the visit or the job took place", () => {
    expect(satisfiedBy(c("get_secure", "Come out and look at the site", "visit"), [e("visit_held")])?.kind).toBe("visit_held");
    expect(satisfiedBy(c("get_secure", "Book a site visit", "visit"), [e("job_done")])?.kind).toBe("job_done");
  });

  it("the customer being available: kept once the visit or job took place", () => {
    expect(satisfiedBy(c("customer", "Be available tomorrow", "confirm"), [e("job_attended")])?.kind).toBe("job_attended");
    expect(satisfiedBy(c("customer", "Be home to let us in", "confirm"), [])).toBeNull();
  });

  it("going ahead: kept by an accepted quote or a job created; sending the quote by a quote sent", () => {
    expect(satisfiedBy(c("customer", "Go ahead with the quote", "confirm"), [e("quote_accepted")])?.kind).toBe("quote_accepted");
    expect(satisfiedBy(c("customer", "Confirm the booking", "confirm"), [e("job_created")])?.kind).toBe("job_created");
    expect(satisfiedBy(c("get_secure", "Send the quote tonight", "send_quote"), [e("quote_sent")])?.kind).toBe("quote_sent");
  });

  it("never inferred: camera plans, photos, payment, or an unknown time", () => {
    const all = (["job_done", "job_invoiced", "job_attended", "job_created", "visit_held", "quote_accepted", "quote_sent"] as const).map((k) => e(k));
    expect(satisfiedBy(c("get_secure", "Prepare and send the camera plan", "send_info"), all)).toBeNull();
    expect(satisfiedBy(c("customer", "Send photos of the eaves", "send_photos"), all)).toBeNull();
    expect(satisfiedBy(c("customer", "Pay the deposit", "pay"), all)).toBeNull();
    expect(satisfiedBy({ ...c("get_secure", "Book the installation visit", "visit"), at: null }, all)).toBeNull();
  });
});
