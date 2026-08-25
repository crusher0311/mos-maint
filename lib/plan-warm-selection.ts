export interface PlanWarmVehicle {
  vin: string;
  mileage: number | null;
}

export interface PlanWarmCandidate extends PlanWarmVehicle {
  mileage: number;
}

export interface PlanWarmSelection {
  pending: PlanWarmCandidate[];
  alreadyCached: number;
  skippedNoMileage: number;
  cacheLookupFailures: number;
  scanned: number;
}

interface SelectPlanWarmCandidatesOptions {
  vehicles: PlanWarmVehicle[];
  maxCandidates: number;
  concurrency: number;
  isCached: (vehicle: PlanWarmVehicle) => Promise<boolean>;
  pastDeadline?: () => boolean;
  onCacheLookupError?: (vehicle: PlanWarmVehicle, error: unknown) => void;
}

/**
 * Selects uncached vehicles before applying the build budget.
 *
 * Cache checks run in small ordered batches so selection stays newest-first,
 * never exceeds the existing concurrency cap, and can stop at the route's
 * deadline. Valid cache entries and vehicles without mileage do not consume
 * build slots, allowing later runs to advance through the report window.
 */
export async function selectPlanWarmCandidates({
  vehicles,
  maxCandidates,
  concurrency,
  isCached,
  pastDeadline = () => false,
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
  let cacheLookupFailures = 0;
  let scanned = 0;
  let cursor = 0;

  while (cursor < vehicles.length && pending.length < candidateCap && !pastDeadline()) {
    const remainingSlots = candidateCap - pending.length;
    const batchSize = Math.min(lookupConcurrency, remainingSlots, vehicles.length - cursor);
    const batch = vehicles.slice(cursor, cursor + batchSize);
    cursor += batch.length;

    const results = await Promise.all(
      batch.map(async (vehicle) => {
        if (pastDeadline()) return "deadline" as const;
        if (!vehicle.mileage) return "no_mileage" as const;
        try {
          return (await isCached(vehicle)) ? ("cached" as const) : ("pending" as const);
        } catch (error) {
          onCacheLookupError?.(vehicle, error);
          return "lookup_failed" as const;
        }
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result === "deadline") continue;
      scanned++;
      if (result === "cached") alreadyCached++;
      else if (result === "no_mileage") skippedNoMileage++;
      else if (result === "lookup_failed") cacheLookupFailures++;
      else pending.push({ ...batch[i], mileage: batch[i].mileage! });
    }
  }

  return {
    pending,
    alreadyCached,
    skippedNoMileage,
    cacheLookupFailures,
    scanned,
  };
}