import type { PlanWarmMileageResolution } from "@/lib/plan-warm-mileage";

export interface PlanWarmVehicle {
  vin: string;
  mileage: number | null;
}

export interface PlanWarmCandidate extends PlanWarmVehicle {
  mileage: number;
  mileageSource: PlanWarmMileageResolution["mileageSource"];
  mileageEstimateDetails: Record<string, unknown> | null;
}

export interface PlanWarmSelection {
  pending: PlanWarmCandidate[];
  alreadyCached: number;
  skippedNoMileage: number;
  mileageResolutionFailures: number;
  cacheLookupFailures: number;
  scanned: number;
}

interface SelectPlanWarmCandidatesOptions {
  vehicles: PlanWarmVehicle[];
  maxCandidates: number;
  concurrency: number;
  isCached: (vehicle: PlanWarmVehicle) => Promise<boolean>;
  resolveMileage?: (
    vehicle: PlanWarmVehicle,
  ) => Promise<PlanWarmMileageResolution | null>;
  pastDeadline?: () => boolean;
  onMileageResolutionError?: (vehicle: PlanWarmVehicle, error: unknown) => void;
  onCacheLookupError?: (vehicle: PlanWarmVehicle, error: unknown) => void;
}

type CandidateResult = {
  status:
    | "deadline"
    | "no_mileage"
    | "mileage_resolution_failed"
    | "cached"
    | "lookup_failed"
    | "pending";
  candidate?: PlanWarmCandidate;
};

/**
 * Selects uncached vehicles before applying the build budget.
 *
 * Cache checks run in small ordered batches so selection stays newest-first,
 * never exceeds the existing concurrency cap, and can stop at the route's
 * deadline. Cache validity uses the report's original mileage hint (including
 * null); only true cache misses invoke the caller-provided cache-only mileage
 * resolver. Valid cache entries and vehicles still lacking mileage do not
 * consume build slots, allowing later runs to advance through the report window.
 */
export async function selectPlanWarmCandidates({
  vehicles,
  maxCandidates,
  concurrency,
  isCached,
  resolveMileage,
  pastDeadline = () => false,
  onMileageResolutionError,
  onCacheLookupError,
}: SelectPlanWarmCandidatesOptions): Promise<PlanWarmSelection> {
  const pending: PlanWarmCandidate[] = [];
  const candidateCap = Number.isFinite(maxCandidates)
    ? Math.max(0, Math.floor(maxCandidates))
    : 0;
  const lookupConcurrency = Number.isFinite(concurrency)
    ? Math.max(1, Math.floor(concurrency))
    : 1;
  let alreadyCached = 0;
  let skippedNoMileage = 0;
  let mileageResolutionFailures = 0;
  let cacheLookupFailures = 0;
  let scanned = 0;
  let cursor = 0;

  while (cursor < vehicles.length && pending.length < candidateCap && !pastDeadline()) {
    const remainingSlots = candidateCap - pending.length;
    const batchSize = Math.min(lookupConcurrency, remainingSlots, vehicles.length - cursor);
    const batch = vehicles.slice(cursor, cursor + batchSize);
    cursor += batch.length;

    const results = await Promise.all(
      batch.map(async (vehicle): Promise<CandidateResult> => {
        if (pastDeadline()) return { status: "deadline" };

        try {
          if (await isCached(vehicle)) return { status: "cached" };
        } catch (error) {
          onCacheLookupError?.(vehicle, error);
          return { status: "lookup_failed" };
        }

        let resolvedMileage: PlanWarmMileageResolution | null =
          vehicle.mileage
            ? {
                mileage: vehicle.mileage,
                mileageSource: "actual",
                mileageEstimateDetails: null,
              }
            : null;
        if (!resolvedMileage && resolveMileage) {
          try {
            resolvedMileage = await resolveMileage(vehicle);
          } catch (error) {
            onMileageResolutionError?.(vehicle, error);
            return { status: "mileage_resolution_failed" };
          }
        }
        if (!resolvedMileage) return { status: "no_mileage" };

        return {
          status: "pending",
          candidate: { ...vehicle, ...resolvedMileage },
        };
      }),
    );

    for (const result of results) {
      if (result.status === "deadline") continue;
      scanned++;
      if (result.status === "cached") alreadyCached++;
      else if (result.status === "no_mileage") skippedNoMileage++;
      else if (result.status === "mileage_resolution_failed") mileageResolutionFailures++;
      else if (result.status === "lookup_failed") cacheLookupFailures++;
      else if (result.candidate) pending.push(result.candidate);
    }
  }

  return {
    pending,
    alreadyCached,
    skippedNoMileage,
    mileageResolutionFailures,
    cacheLookupFailures,
    scanned,
  };
}