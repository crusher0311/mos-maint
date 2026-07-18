// lib/job-search-specs.ts
//
// Task #880 — Shared vehicle-spec resolution for the two job-search routes
// (`app/api/jobs/search` and `app/api/extension/jobs/search`), which
// previously duplicated the DataOne squish-decode block verbatim.
//
// Key behavior change vs. the old inline blocks: donor ACES IDs come from
// the STORED job record (`job.vehicle.acesVehicleId` / `acesEngineId` /
// `submodelKey`, written at index time by lib/job-index-aces.ts) whenever
// they're present. Only the target vehicle and donors missing stored IDs
// are decoded live — so a slow or failed live DataOne decode no longer
// silently wipes out ACES scoring for donors that already carry their IDs.
//
// The decode/squish functions are injected so the resolution logic stays
// pure and unit-testable under tsx (lib/integrations/dataone-local.ts pulls
// in the postgres client). Routes pass `toSquishPublic` and
// `batchDecodeSquishes`.

import { extractVehicleSpecs, type VehicleSpecs } from "@/lib/job-scoring";
import { coerceAcesId } from "@/lib/aces-fields";

export type SquishFn = (vin: string) => string;
export type BatchDecodeFn = (squishes: string[]) => Promise<Map<string, any>>;

/**
 * Build a VehicleSpecs from the ACES fields stored on a job record's
 * vehicle sub-doc at index time. Returns null when the record carries no
 * stored ACES identity at all (pre-backfill rows, providers without
 * enrichment) so the caller falls back to a live decode. The non-ACES spec
 * fields (gvwr/body/fuel/...) are null — the heuristic scorer falls back
 * to model-based inference and free-text engine parsing for those, exactly
 * as it does for any donor without a decode.
 */
// Stored records (Mongo job_index / PG normalized rows serialized through
// JSON) can carry ACES ids as numeric strings; normalize before the strict
// numeric coercion.
function coerceStoredAcesId(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? coerceAcesId(n) : null;
  }
  return coerceAcesId(value);
}

export function specsFromStoredAces(vehicle: any): VehicleSpecs | null {
  if (!vehicle || typeof vehicle !== "object") return null;
  const acesVehicleId = coerceStoredAcesId(vehicle.acesVehicleId);
  const acesEngineId = coerceStoredAcesId(vehicle.acesEngineId);
  const submodelKey =
    typeof vehicle.submodelKey === "string" && vehicle.submodelKey.length > 0
      ? vehicle.submodelKey
      : null;
  if (acesVehicleId === null && acesEngineId === null && submodelKey === null) {
    return null;
  }
  return {
    gvwrBand: null,
    bodyType: null,
    driveType: null,
    displacement: null,
    fuelType: null,
    acesVehicleId,
    acesEngineId,
    submodelKey,
    candidateVehicleIds: null,
  };
}

export interface ResolveJobSearchSpecsResult {
  targetSpecs: VehicleSpecs | null;
  jobSpecsMap: Map<string, VehicleSpecs>;
  /** Donors served from stored ACES IDs (no live decode needed). */
  storedCount: number;
  /** Donors resolved via the live DataOne decode. */
  liveCount: number;
}

/**
 * Resolve target + donor VehicleSpecs for a job-search scoring pass.
 * Never throws — a decode failure logs and degrades to stored-ID/heuristic
 * scoring only.
 */
export async function resolveJobSearchSpecs(opts: {
  targetVin: string | null | undefined;
  jobs: any[];
  idFor: (job: any) => string;
  toSquish: SquishFn;
  batchDecode: BatchDecodeFn;
  logPrefix?: string;
}): Promise<ResolveJobSearchSpecsResult> {
  const { targetVin, jobs, idFor, toSquish, batchDecode } = opts;
  const logPrefix = opts.logPrefix ?? "[Jobs Search]";
  const jobSpecsMap = new Map<string, VehicleSpecs>();
  let targetSpecs: VehicleSpecs | null = null;
  let storedCount = 0;
  let liveCount = 0;

  // 1) Stored ACES IDs first — these donors need no live decode.
  const uncovered: any[] = [];
  for (const job of jobs) {
    const stored = specsFromStoredAces(job.vehicle);
    if (stored) {
      jobSpecsMap.set(idFor(job), stored);
      storedCount++;
    } else {
      uncovered.push(job);
    }
  }

  // 2) Live decode: target VIN + uncovered donors only.
  const squishToDecode = new Set<string>();
  let targetSquish: string | null = null;
  if (targetVin && typeof targetVin === "string" && targetVin.length >= 11) {
    try {
      targetSquish = toSquish(targetVin);
      squishToDecode.add(targetSquish);
    } catch {}
  }
  const donorSquishFor = (job: any): string | null => {
    const jVin = job.vehicle?.vin || job.vin;
    if (!jVin || typeof jVin !== "string" || jVin.length < 11) return null;
    try {
      return toSquish(jVin);
    } catch {
      return null;
    }
  };
  for (const job of uncovered) {
    const sq = donorSquishFor(job);
    if (sq) squishToDecode.add(sq);
  }

  if (squishToDecode.size > 0) {
    try {
      const decoded = await batchDecode([...squishToDecode]);
      // batchDecodeSquishes soft-fails to an empty map; make an outage
      // visible instead of silently scoring everything heuristically.
      if (decoded.size === 0) {
        console.warn(
          `${logPrefix} Live DataOne decode returned 0 rows for ${squishToDecode.size} squish(es) — possible DataOne outage; ${storedCount} donor(s) still scored via stored ACES IDs`,
        );
      }
      if (targetSquish) {
        const tRow = decoded.get(targetSquish);
        if (tRow) targetSpecs = extractVehicleSpecs(tRow);
      }
      for (const job of uncovered) {
        const sq = donorSquishFor(job);
        if (!sq) continue;
        const row = decoded.get(sq);
        if (row) {
          jobSpecsMap.set(idFor(job), extractVehicleSpecs(row));
          liveCount++;
        }
      }
    } catch (err) {
      console.error(
        `${logPrefix} DataOne specs resolution failed (non-blocking; ${storedCount} donor(s) still scored via stored ACES IDs):`,
        err,
      );
    }
  }

  console.log(
    `${logPrefix} ACES specs: target=${targetSpecs ? "decoded" : "none"}, stored=${storedCount}, live=${liveCount}, donors=${jobs.length}`,
  );
  return { targetSpecs, jobSpecsMap, storedCount, liveCount };
}
