/**
 * The autonomy dial: how far Hermes may go on its own, by capability class, and how sure it has to
 * be. Chris sets it in Settings → Hermes; the validator applies it. This module is pure
 * (no database), so the settings form can use it too; autonomy.ts reads and saves the setting. The floor is fixed in code:
 * nothing customer-facing is ever sent, confirmed, priced, discounted or accepted by an agent
 * (src/lib/guard/actor.ts), whatever the dial says.
 *
 *   do          Hermes does it; it shows in the feed; Chris can undo it
 *   do_and_ask  Hermes does the work and the result waits for one click (a quote, a draft, a
 *               pencilled booking)
 *   ask_first   Hermes proposes; nothing happens until Chris says so
 *   never       refused for any agent
 */
import type { CapabilityClass } from "./authority";

export const AUTONOMY_LEVELS = ["do", "do_and_ask", "ask_first", "never"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** The classes Chris can set. "review" and "none" are not actions and have no dial. */
export const DIAL_CLASSES = ["internal_record", "internal_work", "operational_state", "record_data", "business_brain", "research", "prepare_customer_facing", "proposal"] as const satisfies readonly CapabilityClass[];
export type DialClass = (typeof DIAL_CLASSES)[number];

export type AutonomySettings = {
  levels: Record<DialClass, AutonomyLevel>;
  /** Hermes's confidence has to be at least this for the class to go ahead without Chris. */
  thresholds: Record<DialClass, number>;
};

export const DIAL_LABELS: Record<DialClass, { label: string; examples: string; floor: AutonomyLevel }> = {
  internal_record: { label: "Internal notes", examples: "a note of what Hermes understood", floor: "do" },
  internal_work: { label: "Internal work", examples: "tasks, follow-ups, call reminders, service cases", floor: "do" },
  operational_state: { label: "Operational state", examples: "lead or not a lead, a commitment kept, filing into existing work", floor: "do" },
  record_data: { label: "Record data", examples: "facts on a lead (a conflicting value is always flagged, never overwritten)", floor: "do" },
  business_brain: { label: "Business Brain", examples: "running the CCTV design and costing", floor: "do" },
  research: { label: "Research", examples: "asking the research profile a question", floor: "do" },
  prepare_customer_facing: { label: "Quotes and replies", examples: "prepared and waiting for your click; never sent by Hermes", floor: "do_and_ask" },
  proposal: { label: "Bookings and proposals", examples: "site visits, bookings, revised quotes, linking a sender", floor: "do_and_ask" },
};

/** Where the dial starts: internal work on its own, customer-facing output prepared for a click, bookings asked first. */
export const AUTONOMY_DEFAULTS: AutonomySettings = {
  levels: { internal_record: "do", internal_work: "do", operational_state: "do", record_data: "do", business_brain: "do", research: "do", prepare_customer_facing: "do_and_ask", proposal: "ask_first" },
  thresholds: { internal_record: 0.3, internal_work: 0.4, operational_state: 0.6, record_data: 0.7, business_brain: 0.6, research: 0.5, prepare_customer_facing: 0.6, proposal: 0.75 },
};

const rank = (l: AutonomyLevel) => AUTONOMY_LEVELS.indexOf(l);

/** A setting can only be as permissive as the class's floor; a threshold is a probability. */
export function normaliseAutonomy(raw: Partial<AutonomySettings> | null | undefined, fallbackThreshold?: number): AutonomySettings {
  const out: AutonomySettings = { levels: { ...AUTONOMY_DEFAULTS.levels }, thresholds: { ...AUTONOMY_DEFAULTS.thresholds } };
  if (fallbackThreshold && fallbackThreshold > 0 && fallbackThreshold <= 1) for (const c of DIAL_CLASSES) out.thresholds[c] = Math.max(out.thresholds[c], fallbackThreshold);
  for (const c of DIAL_CLASSES) {
    const l = raw?.levels?.[c];
    if (l && AUTONOMY_LEVELS.includes(l)) out.levels[c] = rank(l) < rank(DIAL_LABELS[c].floor) ? DIAL_LABELS[c].floor : l;
    const t = Number(raw?.thresholds?.[c]);
    if (t > 0 && t <= 1) out.thresholds[c] = Math.round(t * 100) / 100;
  }
  return out;
}

/** The dial for a class that has one; classes without a dial ("review", "none") always go ahead. */
export function dialFor(settings: AutonomySettings, cls: CapabilityClass): { level: AutonomyLevel; threshold: number } | null {
  return (DIAL_CLASSES as readonly string[]).includes(cls) ? { level: settings.levels[cls as DialClass], threshold: settings.thresholds[cls as DialClass] } : null;
}
