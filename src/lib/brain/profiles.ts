/**
 * Recording profiles: how Get Secure configures cameras to record, and so the design bitrate used
 * for recorder bandwidth, storage and retention.
 *
 * A profile's rules resolve most specific first: a rule for the exact product, then one for the
 * manufacturer/family (optionally within a resolution band), then a generic resolution band.
 * The manufacturer's published maximum bitrate is never a design value: it is only used to warn
 * what could happen if a camera were later configured above the approved profile.
 */
import type { CameraDesign, CameraProduct, EnquiryInput, Policies, RecordingProfile, RecordingRule } from "./types";
import { TRUSTED_STATUSES } from "./types";
import { familyOf } from "./pricing";

const inBand = (r: RecordingRule, mp: number) => (r.minMp == null || mp >= r.minMp - 1e-6) && (r.maxMp == null || mp <= r.maxMp + 1e-6);

/** The profile for this job: the one asked for, else the default for the property type. */
export function profileFor(input: Pick<EnquiryInput, "propertyType" | "recordingProfileId">, profiles: RecordingProfile[]): RecordingProfile | null {
  const live = profiles.filter((p) => p.status !== "deprecated");
  if (input.recordingProfileId) {
    const chosen = live.find((p) => p.id === input.recordingProfileId || p.key === input.recordingProfileId);
    if (chosen) return chosen;
  }
  const type = input.propertyType ?? "residential";
  return live.find((p) => p.isDefault && p.propertyType === type) ?? live.find((p) => p.isDefault && p.propertyType === "any") ?? null;
}

/** Which rule of the profile applies to this camera, if any. */
export function ruleFor(profile: RecordingProfile | null, camera: CameraProduct): { rule: RecordingRule; level: "product" | "family" | "resolution" } | null {
  if (!profile) return null;
  const rules = profile.rules.filter((r) => r.designBitrateMbps != null && r.designBitrateMbps > 0);
  const product = rules.find((r) => r.scope === "product" && r.productId === camera.id);
  if (product) return { rule: product, level: "product" };
  const fam = familyOf(camera).toLowerCase();
  const family = rules
    .filter((r) => r.scope === "family" && r.family && (r.family.toLowerCase() === fam || r.family.toLowerCase() === camera.manufacturer.toLowerCase()) && inBand(r, camera.resolutionMp))
    // A family rule limited to a resolution band is more specific than one for every resolution.
    .sort((a, b) => Number(b.minMp != null || b.maxMp != null) - Number(a.minMp != null || a.maxMp != null))[0];
  if (family) return { rule: family, level: "family" };
  const band = rules
    .filter((r) => r.scope === "resolution" && inBand(r, camera.resolutionMp))
    .sort((a, b) => (a.maxMp ?? 999) - (a.minMp ?? 0) - ((b.maxMp ?? 999) - (b.minMp ?? 0)))[0];
  if (band) return { rule: band, level: "resolution" };
  return null;
}

export function cameraDesign(camera: CameraProduct, profile: RecordingProfile | null): CameraDesign {
  const hit = ruleFor(profile, camera);
  const approved = !!hit && !!profile && TRUSTED_STATUSES.includes(profile.status);
  return {
    productId: camera.id,
    model: `${camera.manufacturer} ${camera.model}`,
    resolutionMp: camera.resolutionMp,
    codec: hit?.rule.codec ?? profile?.codec ?? null,
    frameRate: hit?.rule.frameRate ?? profile?.frameRate ?? null,
    designBitrateMbps: hit?.rule.designBitrateMbps ?? null,
    bitrateSource: hit && profile ? `${profile.name}: ${hit.level === "product" ? "product override" : hit.level === "family" ? `${hit.rule.family} rule` : `${hit.rule.minMp ?? 0}-${hit.rule.maxMp ?? "any"} MP rule`}` : null,
    bitrateApproved: approved,
    publishedMaxBitrateMbps: camera.maxBitrateMbps ?? null,
  };
}

/** Recording mode and retention for the job: the customer's request, then the profile, then policy. */
export function recordingFor(input: EnquiryInput, profile: RecordingProfile | null, policies: Policies) {
  const mode = input.recordingMode ?? profile?.recordingMode ?? policies.residentialDefaultRecording.value;
  const target = input.retentionDays ?? profile?.retentionTargetDays ?? policies.retentionTargetDays.value;
  const minimum = profile?.retentionMinimumDays ?? policies.retentionMinimumDays.value;
  return { mode, target, minimum, source: input.retentionDays ? ("customer" as const) : profile?.retentionTargetDays ? ("profile" as const) : ("policy" as const) };
}
