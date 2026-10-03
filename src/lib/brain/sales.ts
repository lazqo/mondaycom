/**
 * Sales read: intent, main concern, stage and the recommended next move.
 *
 * Deterministic keyword rules for now (provisional); a trained decision model can replace this
 * later behind the same shape. The read only ever recommends; it never contacts anyone.
 */
import type { Confidence, DecisionPacket, EnquiryInput, SalesRead } from "./types";

const has = (text: string, ...words: (string | RegExp)[]) => words.some((w) => (typeof w === "string" ? text.includes(w) : w.test(text)));

export function salesRead(input: {
  enquiry: EnquiryInput;
  siteVisitRequired: boolean;
  confidence: Confidence;
  blockingMissing: number;
  priceComplete: boolean;
  packet: Pick<DecisionPacket, "cameras" | "nvr" | "recording" | "costing" | "labour">;
}): SalesRead {
  const e = input.enquiry;
  const t = (e.message ?? "").toLowerCase();
  const notes: string[] = [];

  const competitor = !!e.competitorQuote || has(t, "cheaper", "competitor", "another quote", "other quote", "quoted me", "better price", /someone else.*(quote|price)/);
  const urgent = e.urgency === "urgent" || has(t, "break-in", "broken into", "burglar", "stolen", "theft", "asap", "urgent", "today", "emergency");
  const priceAsk = has(t, "price", "cost", "how much", "quote", "budget", "$");
  const compare = has(t, "compare", "options", "difference between", "vs", "versus");
  const browsing = has(t, "just looking", "just after info", "information", "thinking about", "some idea", "ballpark");

  let intent: SalesRead["intent"] = "active_buyer";
  if (e.existingCustomer) intent = "existing_customer";
  else if (urgent) intent = "urgent_problem";
  else if (competitor || compare) intent = "comparing_options";
  else if (priceAsk && !e.siteVisitRequested) intent = "price_enquiry";
  else if (browsing) intent = "information_gathering";

  let primaryConcern: SalesRead["primaryConcern"] = "unknown";
  if (has(t, "break-in", "broken into", "burglar", "stolen", "theft", "safe", "security")) primaryConcern = "security_risk";
  else if (competitor || has(t, "cheap", "budget", "afford", "expensive", "price")) primaryConcern = "price";
  else if (has(t, "phone", "app", "remote", "watch from", "view from")) primaryConcern = "remote_access";
  else if (has(t, "clear", "quality", "number plate", "face", "night")) primaryConcern = "image_quality";
  else if (has(t, "false alarm", "notifications", "alerts")) primaryConcern = "false_alarms";
  else if (has(t, "reliable", "keeps dropping", "stopped working", "offline")) primaryConcern = "reliability";
  else if (has(t, "when", "how soon", "timeline", "before christmas", "this week")) primaryConcern = "timing";

  const status = e.leadStatus ?? "new";
  let stage: SalesRead["stage"] =
    status === "won" || status === "lost" ? "won_lost" : status === "quote_sent" ? "quote_sent" : status === "new" ? "discovery" : "qualification";
  if (competitor && (status === "quote_sent" || !!e.competitorQuote)) stage = "objection";
  else if (stage !== "won_lost" && stage !== "quote_sent" && input.blockingMissing === 0 && input.priceComplete) stage = "quote_ready";

  let recommendedAction: SalesRead["recommendedAction"];
  let responseStyle: SalesRead["responseStyle"];
  if (competitor) {
    recommendedAction = "explain_value_difference";
    responseStyle = "formal_quote";
    notes.push("Do not discount automatically. Compare like for like first; any discount needs Chris.");
  } else if (input.siteVisitRequired) {
    recommendedAction = "arrange_site_visit";
    responseStyle = "site_visit";
  } else if (input.blockingMissing > 0) {
    recommendedAction = "ask_one_question";
    responseStyle = "site_visit";
  } else if (input.priceComplete && input.confidence.overall !== "low") {
    recommendedAction = intent === "price_enquiry" || intent === "information_gathering" ? "provide_indicative_price" : "recommend_one_system";
    responseStyle = intent === "comparing_options" ? "good_better_best" : intent === "price_enquiry" ? "indicative_price" : "formal_quote";
  } else {
    recommendedAction = "ask_one_question";
    responseStyle = "indicative_price";
    notes.push("Pricing is incomplete in the catalogue; finish pricing before sending a figure.");
  }
  if (stage === "won_lost") {
    recommendedAction = "do_nothing_yet";
  }

  const p = input.packet;
  const objectionChecklist = competitor
    ? [
        { item: "Camera specification", ours: p.cameras.filter((c) => c.product).map((c) => `${c.product!.resolutionMp} MP ${c.product!.manufacturer}`).join(", ") || "to be confirmed" },
        { item: "Recorder", ours: p.nvr.selected ? `${p.nvr.selected.channels}-channel ${p.nvr.selected.manufacturer}` : "to be confirmed" },
        {
          item: "Storage / retention",
          ours: p.recording.storage.installedTb
            ? p.recording.storage.advisory
              ? `${p.recording.storage.installedTb} TB (recording duration varies with camera settings, activity and recording configuration)`
              : `${p.recording.storage.installedTb} TB, about ${p.recording.storage.expectedRetentionDays} days 24/7`
            : "to be confirmed",
        },
        { item: "Installation", ours: p.labour.package ? "Included (installation allowance)" : "to be confirmed" },
        { item: "Cabling", ours: "Included in the standard materials allowance" },
        { item: "Accessories (junction boxes, conduit)", ours: "Listed in the quote where needed" },
        { item: "Commissioning", ours: "Included" },
        { item: "Warranty", ours: "Per product; to state in the quote" },
        { item: "App setup", ours: "Included where remote viewing is wanted" },
        { item: "Support", ours: "To state" },
        { item: "GST", ours: "Quote shows GST separately; check whether the other price includes it" },
      ]
    : null;

  return { intent, primaryConcern, stage, recommendedAction, responseStyle, notes, objectionChecklist };
}
