// Task #888 — shared labor-rate resolution for both add-to-RO routes
// (dashboard `/api/jobs/add-to-ro` and extension `/api/extension/jobs/add-to-ro`).
//
// Canned jobs carry a labor rate the shop deliberately saved on the template,
// so that rate must win. Historical/plan/lookup jobs keep the legacy priority
// (RO rate → cached shop rate → job's own rate) because their historical
// rates are often stale.
//
// Pure module (no "server-only", no DB) so it stays unit-testable under tsx.

export type LaborRateSource = "template" | "ro" | "cached" | "fallback" | "none";

export type LaborRateInputs = {
  /** The `source` field from the add-to-RO request body (e.g. "canned"). */
  source?: string | null;
  /** Rate from the pushed job's own labor line(s), 0 when absent. */
  jobLaborRate: number;
  /** Rate found on an existing labor line already on the work order. */
  roLaborRate: number;
  /** Shop's auto-learned cachedLaborRate from the shops document. */
  cachedLaborRate: number;
};

export type ResolvedLaborRate = {
  rate: number;
  rateSource: LaborRateSource;
};

const pos = (n: unknown): number => {
  const v = typeof n === "number" ? n : parseFloat(String(n ?? ""));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * Extract the pushed job's own labor rate: the first labor line with a
 * positive unit price.
 */
export function getJobLaborRate(
  lines: Array<{ lineType: string; unitPrice?: number }> | undefined | null
): number {
  if (!Array.isArray(lines)) return 0;
  for (const line of lines) {
    if (line.lineType === "labor" && pos(line.unitPrice) > 0) {
      return pos(line.unitPrice);
    }
  }
  return 0;
}

/**
 * Resolve which labor rate an add-to-RO push should write.
 *
 * - source === "canned": template rate first (when positive), then the legacy
 *   chain (RO → cached → template-as-fallback).
 * - any other source: legacy chain — RO rate → cached rate → job rate.
 */
export function resolveAddToRoLaborRate(inputs: LaborRateInputs): ResolvedLaborRate {
  const jobRate = pos(inputs.jobLaborRate);
  const roRate = pos(inputs.roLaborRate);
  const cachedRate = pos(inputs.cachedLaborRate);
  const isCanned = inputs.source === "canned";

  if (isCanned && jobRate > 0) {
    return { rate: jobRate, rateSource: "template" };
  }
  if (roRate > 0) return { rate: roRate, rateSource: "ro" };
  if (cachedRate > 0) return { rate: cachedRate, rateSource: "cached" };
  if (jobRate > 0) return { rate: jobRate, rateSource: "fallback" };
  return { rate: 0, rateSource: "none" };
}

/**
 * True when the resolver would not need the cached shop rate — lets routes
 * skip the Mongo lookup when the template (canned) or the RO already decides.
 */
export function needsCachedLaborRate(inputs: Omit<LaborRateInputs, "cachedLaborRate">): boolean {
  if (inputs.source === "canned" && pos(inputs.jobLaborRate) > 0) return false;
  return pos(inputs.roLaborRate) === 0;
}
