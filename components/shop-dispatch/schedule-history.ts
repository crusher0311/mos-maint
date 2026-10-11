import type { assessJobExperience } from "@/lib/shop-dispatch/experience";

export type HistoryState = Parameters<typeof assessJobExperience>[2];
/** Treat malformed or unavailable history as unknown, never as qualification. */
export function validateScheduleHistory(value: unknown): HistoryState {
  const data = value as { profiles?: unknown; truncated?: unknown } | null;
  if (!data || !Array.isArray(data.profiles) || typeof data.truncated !== "boolean") throw new Error("Invalid skills history response");
  const timestamp = (v: unknown) => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
  const text = (v: unknown) => typeof v === "string" && v.length > 0;
  const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const ids = new Set<string>();
  for (const profile of data.profiles) {
    if (!profile || !text(profile.technicianId) || ids.has(profile.technicianId) || !Array.isArray(profile.skills)) throw new Error("Invalid skills profile");
    ids.add(profile.technicianId);
    for (const skill of profile.skills) {
      if (!skill || !text(skill.key) || !text(skill.title) || !count(skill.count) || !count(skill.sharedJobCount) || skill.sharedJobCount > skill.count || !timestamp(skill.lastCompletedAt) || !Array.isArray(skill.evidence)) throw new Error("Invalid skills evidence");
      for (const evidence of skill.evidence) {
        if (!evidence || !text(evidence.ro) || !text(evidence.title) || !timestamp(evidence.completedAt) || typeof evidence.shared !== "boolean") throw new Error("Invalid skills evidence");
      }
    }
  }
  return { status: "ready", profiles: data.profiles, truncated: data.truncated };
}
