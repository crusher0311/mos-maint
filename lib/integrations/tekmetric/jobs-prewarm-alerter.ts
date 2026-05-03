import {
  maybeAlertOnPrewarmAnomalies as maybeAlertGeneric,
  type MaybeAlertResult,
} from "@/lib/jobs-prewarm-alerter";

// Local copy of the prewarm result shape we care about. We deliberately
// don't `import type` from `lib/tekmetric-jobs-prewarm.ts` to avoid a
// cycle (prewarm imports this alerter at runtime). Only the fields below
// are read here.
interface PrewarmJobsCacheResult {
  errors: number;
  capped: boolean;
  lookbackDays: number;
  terminalRosFound: number;
  rosCached: number;
  jobsCached: number;
}

/**
 * Tekmetric pre-warm anomaly alerter — originally task #69, generalized
 * across providers in task #74. This module is now a thin Tekmetric-
 * specific wrapper around `lib/jobs-prewarm-alerter.ts` so the existing
 * import surface in `lib/tekmetric-jobs-prewarm.ts` (and its dedup
 * collection `tekmetric_jobs_cache_prewarm_alerts`) remains
 * unchanged.
 *
 * The auto-clear behaviour added on `main` between #69 and #74 (a clean
 * re-warm drops the dedup row so a future regression re-pages) lives in
 * the generic alerter, so all three providers benefit.
 *
 * See `lib/jobs-prewarm-alerter.ts` for the dedup strategy, paging
 * triggers, auto-clear semantics, and email format.
 */

export type { MaybeAlertResult };

export async function maybeAlertOnPrewarmAnomalies(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  result: PrewarmJobsCacheResult,
  // Pre-warm completion timestamp captured by the caller. Optional for
  // backwards compatibility, but the prewarm function itself always
  // passes it so the email body's "Pre-warm completed at" matches the
  // persisted shop record.
  completedAt?: Date
): Promise<MaybeAlertResult> {
  return maybeAlertGeneric({
    db,
    provider: "tekmetric",
    shopId,
    providerShopId: tekmetricShopId,
    providerShopIdLabel: "Tekmetric shop ID",
    result: {
      errors: result.errors,
      capped: result.capped,
      lookbackDays: result.lookbackDays,
    },
    metrics: [
      { label: "Terminal ROs found", value: result.terminalRosFound },
      { label: "ROs newly cached", value: result.rosCached },
      { label: "Jobs cached", value: result.jobsCached },
    ],
    snapshot: {
      errors: result.errors,
      capped: result.capped,
      rosCached: result.rosCached,
      terminalRosFound: result.terminalRosFound,
    },
    completedAt,
  });
}
