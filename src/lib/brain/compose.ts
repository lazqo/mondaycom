/**
 * Customer-facing drafts built from a decision packet: the first-response email and the quote.
 *
 * Plain templates following Get Secure's response structure: answer the question, show we
 * understood, recommend one direction, ask only what changes the price, state assumptions, give
 * one next step. Hermes can improve the wording later; the facts come from the packet.
 *
 * These are drafts. Nothing here sends anything, and supplier cost and margin never appear.
 */
import type { DecisionPacket } from "./types";

const money = (n: number) => `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export type EmailDraft = { subject: string; body: string };
export type QuoteDraftLine = { description: string; quantity: number; unitPrice: number };
export type QuoteDraft = { title: string; lineItems: QuoteDraftLine[]; taxRatePct: number; notes: string; complete: boolean };

export function composeEmail(packet: DecisionPacket, ctx: { firstName: string | null; subject: string | null; address: string | null; areas: string[] }): EmailDraft {
  const name = ctx.firstName ? ctx.firstName.split(/\s+/)[0] : null;
  const lines: string[] = [`Hi${name ? ` ${name}` : ""},`, ""];
  const n = packet.cameras.length;
  const s = packet.sales;
  const c = packet.costing;
  const st = packet.recording.storage;
  const indicative = c.complete && !packet.siteVisit.required && packet.confidence.overall !== "low";

  // 1. Answer the actual question.
  if (s.recommendedAction === "explain_value_difference") {
    lines.push("Thanks for letting me know about the other quote. Before comparing on price, it's worth checking both cover the same things, because that's usually where the difference is:");
    for (const row of (s.objectionChecklist ?? []).slice(0, 5)) lines.push(`- ${row.item}: ours is ${row.ours.charAt(0).toLowerCase()}${row.ours.slice(1)}`);
    lines.push("");
  } else if (packet.siteVisit.required) {
    lines.push(`Thanks for getting in touch. ${packet.siteVisit.reasons[0]} The best next step is a quick site visit, so the price is right first time.`, "");
  } else if (indicative) {
    lines.push(`Thanks for getting in touch. For ${n} camera${n === 1 ? "" : "s"}, fully installed, you'd be looking at ${packet.confidence.overall === "high" ? "" : "about "}${money(c.totalIncGst)} including GST.`, "");
  } else {
    lines.push("Thanks for getting in touch.", "");
  }

  // 2. Show we understood.
  const where = ctx.address ? ` at ${ctx.address}` : "";
  const areas = ctx.areas.length ? ` covering ${ctx.areas.join(", ")}` : "";
  const remote = packet.network.remoteViewingRequired ? ", with viewing on your phone" : "";
  if (n) lines.push(`You're after ${n} camera${n === 1 ? "" : "s"}${areas}${where}${remote}.`);

  // 3. Recommend one direction, with the reason.
  const cams = packet.cameras.filter((x) => x.product);
  if (cams.length && packet.nvr.selected) {
    const first = cams[0].product!;
    // No number of days is promised: it depends on how the cameras are set up and what they see.
    const drive = st.installedTb ? ` and a ${st.installedTb} TB drive` : "";
    lines.push(`I'd suggest ${first.resolutionMp} MP ${first.manufacturer} cameras with a ${packet.nvr.selected.channels}-channel recorder${drive}.`);
    if (st.installedTb) lines.push("Recording duration depends on camera settings, recording configuration and scene activity.");
    const why = packet.cameras.find((x) => x.requirement.purpose === "entrance_identification")
      ? "At the front door I've allowed for a camera close enough to see faces clearly, not just movement."
      : null;
    if (why) lines.push(why);
  }
  lines.push("");

  // 4. Only the questions that change the recommendation or price.
  const questions = packet.missing.filter((m) => m.importance !== "nice_to_have").slice(0, 2);
  if (questions.length) {
    lines.push(questions.length === 1 ? "One thing that would help:" : "Two things that would help:");
    for (const q of questions) lines.push(`- ${q.question}`);
    lines.push("");
  }

  // 5. Assumptions, briefly.
  if (indicative && packet.assumptions.length) {
    lines.push(`That price assumes ${packet.assumptions.slice(0, 2).map((a) => a.charAt(0).toLowerCase() + a.slice(1).replace(/\.$/, "")).join(", and ")}. We'd confirm on the day.`, "");
  }
  if (packet.network.customerDecisions.length) {
    lines.push("There's no internet at the property at the moment, so the cameras would record locally. If you'd like to view them on your phone, we can add a 4G router as an option; that has an ongoing data cost, which I can price separately.", "");
  }

  // 6. One low-friction next step.
  const next =
    s.recommendedAction === "arrange_site_visit"
      ? "If you let me know a couple of days and times that suit, I'll check them against our calendar."
      : s.recommendedAction === "explain_value_difference"
        ? "If you can share what the other quote includes, I'm happy to go through it line by line."
        : indicative
          ? "If that sounds right, reply and I'll send through the formal quote."
          : "Once I have that, I'll send through a price.";
  lines.push(next, "", "Thanks,", "Chris", "Get Secure");

  const subject = ctx.subject ? (ctx.subject.toLowerCase().startsWith("re:") ? ctx.subject : `Re: ${ctx.subject}`) : "Your CCTV enquiry";
  return { subject, body: lines.join("\n") };
}

export function composeQuote(packet: DecisionPacket, ctx: { customerName: string | null; gstPct: number }): QuoteDraft {
  const lineItems = packet.costing.lines
    // Internal-only cost lines (materials, conduit, complexity inside the installation) never appear.
    .filter((l) => l.priced && l.unitSellExGst != null && !l.internalOnly)
    .map((l) => ({ description: l.customerDescription, quantity: l.quantity, unitPrice: l.unitSellExGst! }));
  const notes = [
    packet.assumptions.length ? `Assumptions:\n${packet.assumptions.map((a) => `- ${a}`).join("\n")}` : null,
    packet.exclusions.length ? `Exclusions:\n${packet.exclusions.map((a) => `- ${a}`).join("\n")}` : null,
    packet.siteVisit.required ? "Indicative only: subject to a site visit." : "Subject to confirmation of site conditions on the day.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const n = packet.cameras.length;
  return {
    title: `${n}-camera CCTV system${ctx.customerName ? ` for ${ctx.customerName}` : ""}`,
    lineItems,
    taxRatePct: ctx.gstPct,
    notes,
    complete: packet.costing.complete,
  };
}
