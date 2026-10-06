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

// ---------------- the three positions ----------------

/** The dial as Chris reasons about it: three positions with a preset for every class. */
export const DIAL_POSITIONS = ["careful", "normal", "autonomous"] as const;
export type DialPosition = (typeof DIAL_POSITIONS)[number];

export const POSITION_LABELS: Record<DialPosition, { label: string; summary: string; detail: string }> = {
  careful: {
    label: "Careful",
    summary: "Hermes does the internal work only when it is sure; everything else waits for you.",
    detail: "Tasks and notes still happen, but leads, facts, quotes and bookings all need a higher confidence or your click. Most readings will wait for you.",
  },
  normal: {
    label: "Normal",
    summary: "Internal work goes ahead; quotes and replies wait for a click; bookings ask first.",
    detail: "What the CRM assumes. Hermes files, makes tasks and runs the Brain on its own, prepares quotes and replies for your click, and proposes visits and bookings for you to pencil in.",
  },
  autonomous: {
    label: "Autonomous",
    summary: "Hermes does everything it may, with less certainty, and shows you the result.",
    detail: "Lower confidence bars across the board. Quotes, replies and bookings are still never sent or confirmed by Hermes: those stay your click, whatever the position.",
  },
};

export const PRESETS: Record<DialPosition, AutonomySettings> = {
  careful: {
    levels: { internal_record: "do", internal_work: "do", operational_state: "do", record_data: "do", business_brain: "do", research: "do", prepare_customer_facing: "do_and_ask", proposal: "ask_first" },
    thresholds: { internal_record: 0.3, internal_work: 0.6, operational_state: 0.8, record_data: 0.85, business_brain: 0.7, research: 0.7, prepare_customer_facing: 0.8, proposal: 0.85 },
  },
  normal: AUTONOMY_DEFAULTS,
  autonomous: {
    levels: { internal_record: "do", internal_work: "do", operational_state: "do", record_data: "do", business_brain: "do", research: "do", prepare_customer_facing: "do_and_ask", proposal: "do_and_ask" },
    thresholds: { internal_record: 0.3, internal_work: 0.3, operational_state: 0.5, record_data: 0.6, business_brain: 0.5, research: 0.4, prepare_customer_facing: 0.5, proposal: 0.6 },
  },
};

/** Which position the saved dial is on, or "custom" when the per-class table was changed by hand. */
export function positionOf(settings: AutonomySettings): DialPosition | "custom" {
  for (const p of DIAL_POSITIONS) {
    const preset = PRESETS[p];
    if (DIAL_CLASSES.every((c) => settings.levels[c] === preset.levels[c] && Math.abs(settings.thresholds[c] - preset.thresholds[c]) < 0.005)) return p;
  }
  return "custom";
}

/** Hermes's confidence as a plain word for a card. */
export function confidenceWord(c: number | string | null | undefined): "sure" | "fairly sure" | "guessing" | null {
  const n = Number(c);
  if (!(n > 0)) return null;
  return n >= 0.85 ? "sure" : n >= 0.6 ? "fairly sure" : "guessing";
}
