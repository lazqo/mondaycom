/**
 * Network decision tree.
 *
 * No remote viewing: no internet needed; local recording stands on its own.
 * Remote viewing with internet: get the recorder onto the LAN, wired first, then an approved
 * extension, then a bridge. A router in another room is not a reason for 4G.
 * Remote viewing without usable internet: 4G/5G is a separate customer decision with its own
 * hardware and an ongoing data cost.
 */
import type { EnquiryInput, NetworkResult } from "./types";

export function networkPlan(input: EnquiryInput): NetworkResult {
  const base = { remoteViewingRequired: input.remoteViewing, internetStatus: input.internet };
  if (input.remoteViewing === false) {
    return { ...base, method: "none_required", description: "No remote viewing: the recorder works locally without internet.", unresolved: [], customerDecisions: [] };
  }
  if (input.remoteViewing == null) {
    return { ...base, method: "unresolved", description: "Remote viewing not yet confirmed.", unresolved: ["Does the customer want phone/app viewing?"], customerDecisions: [] };
  }
  if (input.internet === "no") {
    return {
      ...base,
      method: "cellular_option",
      description: "No internet at the property. Local recording still works; phone viewing would need a 4G/5G router as a separate option.",
      unresolved: ["Mobile signal strength at the recorder location", "Expected monthly data use"],
      customerDecisions: ["Whether to add 4G/5G for remote viewing, accepting an ongoing SIM/data cost"],
    };
  }
  if (input.internet === "unknown") {
    return { ...base, method: "unresolved", description: "Remote viewing wanted; internet at the property not confirmed.", unresolved: ["Is there internet at the property?"], customerDecisions: [] };
  }
  // Internet exists.
  if (input.recorderNearRouter === "yes") {
    return { ...base, method: "direct_lan", description: "Recorder plugs into the router with a patch lead.", unresolved: [], customerDecisions: [] };
  }
  if (input.recorderNearRouter === "unknown") {
    return {
      ...base,
      method: "wired_extension",
      description: "Assumed: a Cat6 run from the recorder to the router. Confirm where the router is.",
      unresolved: ["Router location relative to the recorder"],
      customerDecisions: [],
    };
  }
  if (input.wiredRoutePossible !== "no") {
    return {
      ...base,
      method: "wired_extension",
      description: "Router is elsewhere: run Cat6 from the recorder to the router (or a network point). No 4G needed.",
      unresolved: input.wiredRoutePossible === "unknown" ? ["Whether a cable route to the router exists"] : [],
      customerDecisions: [],
    };
  }
  return {
    ...base,
    method: "approved_bridge",
    description: "A wired run to the router is impractical: use an approved wireless bridge or network extension.",
    unresolved: ["Bridge line of sight / signal between the two points"],
    customerDecisions: [],
  };
}
