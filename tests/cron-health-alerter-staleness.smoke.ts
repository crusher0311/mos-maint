/**
 * Smoke test for the cron-health alerter staleness decision
 * (`lib/cron/staleness.ts`, consumed by
 * `app/api/cron/cron-health-alerter/route.ts`).
 *
 * Regression target: the `fullpage-backfill-tekmetric` job is a
 * self-throttling backfill. While a backlog of fullPageMode shops exists,
 * every 2-min pass runs to its 5-min timeout WITHOUT returning a clean 200,
 * so `lastSuccessByJob` never advances. The naive "stale after 2× the 2-min
 * schedule" rule then false-pages platform admins ("Cron jobs stuck") every
 * 30 min even though the job is healthy and actively draining.
 *
 * This locks in:
 *   1. `stalenessMs` overrides the default 2× schedule interval.
 *   2. `tolerateTimeouts` rescues a job whose most-recent ATTEMPT is a recent
 *      timeout (liveness heartbeat) — so a self-throttling backfill is not
 *      paged for never landing a 200.
 *   3. A wedged scheduler (no recent attempt) STILL pages.
 *   4. A real handler error (recent NON-timeout failure) STILL pages.
 *   5. tolerateTimeouts does NOT mask staleness for ordinary jobs (only kicks
 *      in once already past threshold, and only for timeout/ok attempts).
 */

import assert from "node:assert";
import { decideJobStale } from "../lib/cron/staleness";

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 4, 29, 17, 2, 0);

// The real fullpage job config from lib/cron/jobs.cjs.
const fullpage = {
  schedule: "*/2 * * * *",
  stalenessMs: 15 * MIN,
  tolerateTimeouts: true,
};

function main() {
  // 1. stalenessMs override is applied (15 min, not 2× 2min = 4 min).
  {
    const d = decideJobStale({
      job: fullpage,
      lastSuccessAtMs: NOW - 10 * MIN, // older than 4 min, younger than 15 min
      lastAttempt: { atMs: NOW - 1 * MIN, ok: true, timedOut: false },
      sinceBootMs: 60 * MIN,
      nowMs: NOW,
    });
    assert.strictEqual(d.thresholdMs, 15 * MIN, "override threshold applied");
    assert.strictEqual(d.stale, false, "within override threshold → not stale");
  }

  // 2. Backlog reality: no success for ~56 min, but a recent TIMEOUT attempt
  //    → rescued, no page. (This is the exact prod state that paged Brandon.)
  {
    const d = decideJobStale({
      job: fullpage,
      lastSuccessAtMs: NOW - 56 * MIN,
      lastAttempt: { atMs: NOW - 3 * MIN, ok: false, timedOut: true },
      sinceBootMs: 90 * MIN,
      nowMs: NOW,
    });
    assert.strictEqual(d.stale, false, "recent timeout heartbeat → suppressed");
    assert.strictEqual(d.rescued, true, "marked rescued");
  }

  // 3. Wedged scheduler — stale success AND no recent attempt → still pages.
  {
    const d = decideJobStale({
      job: fullpage,
      lastSuccessAtMs: NOW - 56 * MIN,
      lastAttempt: { atMs: NOW - 40 * MIN, ok: false, timedOut: true },
      sinceBootMs: 90 * MIN,
      nowMs: NOW,
    });
    assert.strictEqual(d.stale, true, "no recent attempt → still stale");
    assert.strictEqual(d.rescued, false);
  }
  {
    const d = decideJobStale({
      job: fullpage,
      lastSuccessAtMs: NOW - 56 * MIN,
      lastAttempt: null, // never even recorded an attempt
      sinceBootMs: 90 * MIN,
      nowMs: NOW,
    });
    assert.strictEqual(d.stale, true, "no attempt at all → still stale");
  }

  // 4. Real handler error — recent attempt but NOT a timeout → still pages.
  {
    const d = decideJobStale({
      job: fullpage,
      lastSuccessAtMs: NOW - 56 * MIN,
      lastAttempt: { atMs: NOW - 1 * MIN, ok: false, timedOut: false },
      sinceBootMs: 90 * MIN,
      nowMs: NOW,
    });
    assert.strictEqual(d.stale, true, "recent hard error → still stale/pages");
    assert.strictEqual(d.rescued, false);
  }

  // 5. Ordinary job (no overrides): default 2× interval, no timeout rescue.
  {
    const ordinary = { schedule: "*/2 * * * *" };
    const fresh = decideJobStale({
      job: ordinary,
      lastSuccessAtMs: NOW - 3 * MIN, // < 4 min
      lastAttempt: { atMs: NOW - 1 * MIN, ok: true, timedOut: false },
      sinceBootMs: 60 * MIN,
      nowMs: NOW,
    });
    assert.strictEqual(fresh.thresholdMs, 4 * MIN, "default 2× interval");
    assert.strictEqual(fresh.stale, false, "fresh success → not stale");

    const stuck = decideJobStale({
      job: ordinary,
      lastSuccessAtMs: NOW - 10 * MIN, // > 4 min
      lastAttempt: { atMs: NOW - 1 * MIN, ok: false, timedOut: true },
      sinceBootMs: 60 * MIN,
      nowMs: NOW,
    });
    assert.strictEqual(
      stuck.stale,
      true,
      "ordinary job is NOT rescued by a timeout (no tolerateTimeouts)",
    );
  }

  // 6. Weekend-only / irregular schedules are skipped (evaluated=false).
  {
    const weekend = decideJobStale({
      job: { schedule: "0,15,30,45 * * * 6,0" },
      lastSuccessAtMs: NOW - 5000 * MIN,
      lastAttempt: null,
      sinceBootMs: 90 * MIN,
      nowMs: NOW,
    });
    assert.strictEqual(weekend.evaluated, false, "weekend-only → skipped");
    assert.strictEqual(weekend.stale, false);
  }

  console.log("✓ cron-health-alerter staleness smoke passed (7 cases)");
}

main();
