import { z } from "zod";
import type { Job, Technician } from "./model";

const evidenceSchema = z.object({
  ro: z.string(), title: z.string(), completedAt: z.string().nullable(), shared: z.boolean(),
});
const skillSchema = z.object({
  key: z.string(), title: z.string(), count: z.number().int().nonnegative(),
  lastCompletedAt: z.string().nullable(), sharedJobCount: z.number().int().nonnegative(),
  evidence: z.array(evidenceSchema),
}).refine(skill => skill.sharedJobCount <= skill.count);
const historySchema = z.object({
  profiles: z.array(z.object({ technicianId: z.string(), skills: z.array(skillSchema) })),
  truncated: z.boolean(),
});
export type ExperienceHistory = z.infer<typeof historySchema> & { status: "loading" | "ready" | "error" };
export function parseExperienceHistory(value: unknown): ExperienceHistory {
  return { ...historySchema.parse(value), status: "ready" };
}
export interface ExperienceAssessment {
  level: "unknown" | "limited" | "established" | "not-qualified";
  title: string; message: string; count: number | null;
  evidence: z.infer<typeof evidenceSchema>[]; confirmed: boolean;
}
export const MIN_RECORDED_EXPERIENCE = 3;
const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** Advisory archived evidence, never a qualification or a scheduling permission.
 * Exact normalized package/required-skill keys only: substring matching would
 * misleadingly credit unrelated work (e.g. wheel alignment vs headlamp alignment).
 */
export function assessJobExperience(
  job: Job, technician: Technician, history: ExperienceHistory,
): ExperienceAssessment {
  const targets = [...new Set([key(job.title), ...(job.operations?.requiredSkills ?? []).map(key)])];
  const reviews = technician.skills?.filter(skill => targets.includes(key(skill.key))) ?? [];
  const confirmed = reviews.some(skill => skill.status === "confirmed");
  const base = { count: null, evidence: [], confirmed };
  if (reviews.some(skill => skill.status === "not-qualified")) return {
    ...base, level: "not-qualified", title: "Manager marked a relevant skill not qualified",
    message: "Review the technician’s skill assessment. This warning does not override qualification or scheduling restrictions.",
  };
  if (history.status !== "ready") return {
    ...base, level: "unknown", title: "Experience unknown",
    message: history.status === "loading" ? "Relevant history is still loading. Review this assignment before saving."
      : "History could not be loaded. Missing evidence does not mean the technician lacks experience.",
  };
  const skills = history.profiles.find(profile => profile.technicianId === technician.id)?.skills ?? [];
  const exact = skills.find(skill => key(skill.key) === key(job.title));
  const relevant = exact ? [exact] : targets.slice(1).map(target => skills.find(skill => key(skill.key) === target));
  const coverage = history.truncated ? " Available history is incomplete." : " Based only on imported history.";
  if (!relevant.length || relevant.some(skill => !skill) || relevant.every(skill => !skill?.count)) return {
    ...base, level: "unknown", title: "Experience unknown",
    message: "No sufficient exact-match history was found for this work. That is not proof of inexperience." + coverage,
  };
  // Never add unlike service counts together or treat shared jobs as independent.
  const lowest = relevant.filter((skill): skill is NonNullable<typeof skill> => !!skill)
    .sort((a, b) => (a.count - a.sharedJobCount) - (b.count - b.sharedJobCount))[0];
  const independent = lowest.count - lowest.sharedJobCount;
  const limited = independent < MIN_RECORDED_EXPERIENCE;
  return {
    level: limited ? "limited" : "established",
    title: limited ? "Limited recorded experience" : "Relevant completed work found",
    count: independent, evidence: lowest.evidence, confirmed,
    message: `${independent} recorded completion${independent === 1 ? "" : "s"} without shared attribution for “${lowest.title}”; ${lowest.sharedJobCount} shared. The warning threshold is fewer than ${MIN_RECORDED_EXPERIENCE}.` +
      coverage + " History does not certify independent capability." +
      (confirmed ? " A manager has separately confirmed a relevant skill." : ""),
  };
}
