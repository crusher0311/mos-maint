/**
 * Pure decision logic for the Estimate Assist job builder.
 *
 * Extracted from `app/api/estimate-assist/job-builder/route.ts` so the
 * knowledge-base resolution, VIN-aware attribute adjustments, and the
 * AI-fallback threshold are unit-testable without the route's auth / DB /
 * OpenAI dependencies (the route imports `lib/auth` which is `server-only`
 * and cannot load under tsx).
 *
 * No imports here may pull in `server-only` (directly or transitively).
 */
import {
  getJobById,
  searchJobs,
  JobKnowledgeEntry,
} from "@/lib/estimate-assist/job-knowledge-base";

export interface VehicleContext {
  year?: number;
  make?: string;
  model?: string;
  submodel?: string;
  drivetrain?: string;
  engineCylinders?: number;
  engineDescription?: string;
  fuelType?: string;
  transmission?: string;
}

export interface VinAdjustments {
  laborHoursAdjust: number;
  additionalParts: string[];
  additionalCompanions: string[];
}

/**
 * Threshold for the AI-description fallback: only call the AI when there is
 * no knowledge-base match at all, or the KB entry's technical description is
 * too thin to be useful on an estimate.
 */
export const AI_FALLBACK_MIN_DESCRIPTION_LENGTH = 50;

export function shouldUseAiFallback(job: JobKnowledgeEntry | null | undefined): boolean {
  return !job || job.technicalDescription.length < AI_FALLBACK_MIN_DESCRIPTION_LENGTH;
}

/**
 * Resolve a job request string to a knowledge-base entry: exact jobId match
 * first, then best fuzzy title/tag search hit. Returns null when nothing in
 * the KB scores at all (→ AI fallback territory).
 */
export function resolveKnowledgeBaseJob(jobNameOrId: string): JobKnowledgeEntry | null {
  const exact = getJobById(jobNameOrId);
  if (exact) return exact;
  const results = searchJobs(jobNameOrId, 1);
  return results[0] || null;
}

/**
 * Apply the KB entry's VIN-aware attributes against the resolved vehicle
 * context. Mirrors the route's original inline logic exactly:
 *  - awd            → drivetrain contains "awd"
 *  - 4wd            → drivetrain contains "4wd" or "4x4"
 *  - v6_engine      → engineCylinders === 6
 *  - v8_engine      → engineCylinders === 8
 *  - electronic_parking_brake → model year >= 2016
 *  - cvt_transmission → transmission contains "cvt" (parts only, no labor add)
 */
export function applyVinAttributeAdjustments(
  job: JobKnowledgeEntry | null | undefined,
  vehicleContext: VehicleContext,
): VinAdjustments {
  const result: VinAdjustments = {
    laborHoursAdjust: 0,
    additionalParts: [],
    additionalCompanions: [],
  };

  if (!job?.vinAttributes) return result;

  for (const attr of job.vinAttributes) {
    const condLower = attr.condition.toLowerCase();
    const drivetrainLower = (vehicleContext.drivetrain || "").toLowerCase();
    const cylinders = vehicleContext.engineCylinders;

    if (condLower === "awd" && drivetrainLower.includes("awd")) {
      result.laborHoursAdjust += attr.laborHoursAdjust || 0;
      result.additionalParts.push(...(attr.additionalParts || []));
      result.additionalCompanions.push(...(attr.additionalCompanions || []));
    }
    if (condLower === "4wd" && (drivetrainLower.includes("4wd") || drivetrainLower.includes("4x4"))) {
      result.laborHoursAdjust += attr.laborHoursAdjust || 0;
      result.additionalParts.push(...(attr.additionalParts || []));
      result.additionalCompanions.push(...(attr.additionalCompanions || []));
    }
    if (condLower === "v6_engine" && cylinders === 6) {
      result.laborHoursAdjust += attr.laborHoursAdjust || 0;
      result.additionalParts.push(...(attr.additionalParts || []));
    }
    if (condLower === "v8_engine" && cylinders === 8) {
      result.laborHoursAdjust += attr.laborHoursAdjust || 0;
      result.additionalParts.push(...(attr.additionalParts || []));
    }
    if (condLower === "electronic_parking_brake" && (vehicleContext.year || 0) >= 2016) {
      result.laborHoursAdjust += attr.laborHoursAdjust || 0;
    }
    if (condLower === "cvt_transmission" && (vehicleContext.transmission || "").toLowerCase().includes("cvt")) {
      result.additionalParts.push(...(attr.additionalParts || []));
    }
  }

  return result;
}
