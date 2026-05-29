// Pure staleness decision for the cron-health alerter
// (`app/api/cron/cron-health-alerter/route.ts`). Extracted so the
// threshold-override + timeout-heartbeat logic can be locked in by
// `tests/cron-health-alerter-staleness.smoke.ts` without standing up Mongo.
//
// A cron job is "stale" (page platform admins) when it hasn't recorded a
// successful run within its staleness threshold. Two per-job knobs declared
// in `lib/cron/jobs.cjs` tune this:
//   - `stalenessMs`: explicit threshold, overriding the default 2× the
//     schedule interval. Use for jobs whose real runtime exceeds 2× cadence.
//   - `tolerateTimeouts`: for self-throttling, long-running backfills that
//     legitimately time out every pass while draining a backlog (and so never
//     record a clean 200). A *recent timeout attempt* is treated as a liveness
//     heartbeat. A wedged scheduler (no recent attempt) or a real handler
//     error (a non-timeout failure) is NOT rescued and still pages.

import { estimateScheduleInterval } from "./schedule-interval";

export interface JobStalenessConfig {
  schedule: string;
  stalenessMs?: number;
  tolerateTimeouts?: boolean;
}

export interface JobAttempt {
  /** Epoch ms of the most recent attempt (regardless of outcome). */
  atMs: number;
  /** Did the attempt return a clean 2xx? */
  ok: boolean;
  /** Did the attempt abort on the scheduler timeout (vs. a real error)? */
  timedOut: boolean;
}

export interface StalenessDecision {
  /** False when the schedule is irregular or weekend-only — caller skips it. */
  evaluated: boolean;
  stale: boolean;
  intervalMs: number | null;
  thresholdMs: number | null;
  ageMs: number | null;
  /** True when a timeout-heartbeat saved an otherwise-stale job from paging. */
  rescued: boolean;
}

export function decideJobStale(opts: {
  job: JobStalenessConfig;
  lastSuccessAtMs: number | null;
  lastAttempt: JobAttempt | null;
  sinceBootMs: number | null;
  nowMs: number;
}): StalenessDecision {
  const { job, lastSuccessAtMs, lastAttempt, sinceBootMs, nowMs } = opts;
  const interval = estimateScheduleInterval(job.schedule);
  if (!interval.intervalMs || interval.weekendOnly) {
    return {
      evaluated: false,
      stale: false,
      intervalMs: interval.intervalMs,
      thresholdMs: null,
      ageMs: null,
      rescued: false,
    };
  }

  // Per-job override wins over the naive 2× schedule interval.
  const thresholdMs = job.stalenessMs ?? interval.intervalMs * 2;
  const ageMs = lastSuccessAtMs != null ? nowMs - lastSuccessAtMs : null;
  let stale =
    lastSuccessAtMs != null
      ? ageMs! > thresholdMs
      : sinceBootMs !== null && sinceBootMs > thresholdMs;

  // Heartbeat rescue for self-throttling long-running jobs.
  let rescued = false;
  if (stale && job.tolerateTimeouts && lastAttempt) {
    const attemptRecent = nowMs - lastAttempt.atMs <= thresholdMs;
    if (attemptRecent && (lastAttempt.ok || lastAttempt.timedOut)) {
      stale = false;
      rescued = true;
    }
  }

  return {
    evaluated: true,
    stale,
    intervalMs: interval.intervalMs,
    thresholdMs,
    ageMs,
    rescued,
  };
}
