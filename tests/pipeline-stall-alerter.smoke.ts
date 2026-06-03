/**
 * Smoke test for the whole-pipeline stall alerter pure logic (task #568).
 *
 * Run: `npx tsx tests/pipeline-stall-alerter.smoke.ts`
 *
 * Covers the fleet-progress signature, the stall decision (incl. the liveness
 * gate that hands plain loop-death to cron-health), the drain-lease wedge
 * detector, the queue roll-up, and the dedup-key builder. The route handler
 * only orchestrates DB I/O + delivery on top of these.
 */

import {
  computeProgressSignature,
  decidePipelineStall,
  decideDrainWedge,
  summarizeQueue,
  buildAlertKey,
  DEFAULT_STALL_WINDOW_MS,
} from "../app/api/cron/pipeline-stall-alerter/lib";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.UTC(2026, 5, 3, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// --- (1) Progress signature -------------------------------------------
{
  console.log("computeProgressSignature");
  const base = [
    { completed: true },
    { completed: false, currentChunkEnd: new Date(NOW - 5 * HOUR), totalRosProcessed: 100 },
    { complete: false, currentChunkEnd: new Date(NOW - 6 * HOUR), totalJobsIndexed: 50 },
  ];
  const a = computeProgressSignature(base);
  ok("counts completed vs incomplete", a.completedShops === 1 && a.incompleteShops === 2);

  // Same rows → identical signature (idempotent / no false progress).
  const a2 = computeProgressSignature(base);
  ok("identical rows yield identical signature", a.signature === a2.signature);

  // lastRunAt bumping must NOT change the signature (cron bumps it on no-ops).
  const bumped = base.map((r) => ({ ...r, lastRunAt: new Date(NOW) }));
  const b = computeProgressSignature(bumped);
  ok("lastRunAt change does NOT move signature", a.signature === b.signature);

  // A real counter advance MUST change the signature.
  const advanced = base.map((r, i) =>
    i === 1 ? { ...r, totalRosProcessed: 200 } : r,
  );
  const c = computeProgressSignature(advanced);
  ok("counter advance moves signature", a.signature !== c.signature);

  // A cursor move MUST change the signature.
  const moved = base.map((r, i) =>
    i === 1 ? { ...r, lastCursorMoveAt: new Date(NOW) } : r,
  );
  ok("cursor move moves signature", computeProgressSignature(moved).signature !== a.signature);
}

// --- (2) Stall decision + liveness gate -------------------------------
{
  console.log("decidePipelineStall");
  const W = DEFAULT_STALL_WINDOW_MS;

  ok(
    "no incomplete shops → never stalled",
    decidePipelineStall({
      incompleteShops: 0,
      stalledMs: 10 * HOUR,
      windowMs: W,
      lastBackfillSuccessMs: NOW - MIN,
      nowMs: NOW,
      livenessWindowMs: W,
    }).stalled === false,
  );

  ok(
    "frozen < window → not stalled",
    decidePipelineStall({
      incompleteShops: 5,
      stalledMs: W - MIN,
      windowMs: W,
      lastBackfillSuccessMs: NOW - MIN,
      nowMs: NOW,
      livenessWindowMs: W,
    }).stalled === false,
  );

  const live = decidePipelineStall({
    incompleteShops: 5,
    stalledMs: W + MIN,
    windowMs: W,
    lastBackfillSuccessMs: NOW - MIN, // cron succeeded recently → alive
    nowMs: NOW,
    livenessWindowMs: W,
  });
  ok("frozen past window + live loop → STALLED", live.stalled === true);

  const dead = decidePipelineStall({
    incompleteShops: 5,
    stalledMs: W + MIN,
    windowMs: W,
    lastBackfillSuccessMs: NOW - 10 * HOUR, // loop not running
    nowMs: NOW,
    livenessWindowMs: W,
  });
  ok("frozen but loop dead → deferred to cron-health (not stalled here)",
    dead.stalled === false && dead.deferredToCronHealth === true);

  ok(
    "never-run loop → deferred, not stalled",
    (() => {
      const d = decidePipelineStall({
        incompleteShops: 5,
        stalledMs: W + MIN,
        windowMs: W,
        lastBackfillSuccessMs: null,
        nowMs: NOW,
        livenessWindowMs: W,
      });
      return d.stalled === false && d.deferredToCronHealth === true;
    })(),
  );
}

// --- (3) Drain-lease wedge --------------------------------------------
{
  console.log("decideDrainWedge");
  const MAX = 30 * MIN;
  ok("no lock → null", decideDrainWedge(null, NOW, MAX) === null);

  ok(
    "young live lease → null",
    decideDrainWedge(
      { owner: "drain-1", acquiredAt: new Date(NOW - 5 * MIN), expiresAt: new Date(NOW + MIN) },
      NOW,
      MAX,
    ) === null,
  );

  const wedged = decideDrainWedge(
    {
      owner: "drain-42",
      acquiredAt: new Date(NOW - 2 * HOUR),
      expiresAt: new Date(NOW + 2 * MIN),
      lastRefreshAt: new Date(NOW - MIN),
    },
    NOW,
    MAX,
  );
  ok("old + still-live lease → wedge", wedged != null && wedged.live === true);
  ok("wedge reports owner + held duration", wedged?.owner === "drain-42" && wedged!.heldMs >= 2 * HOUR);

  ok(
    "old + long-expired lease → null (abandoned, handled elsewhere)",
    decideDrainWedge(
      { owner: "drain-9", acquiredAt: new Date(NOW - 5 * HOUR), expiresAt: new Date(NOW - 2 * HOUR) },
      NOW,
      MAX,
    ) === null,
  );

  const justExpired = decideDrainWedge(
    { owner: "drain-7", acquiredAt: new Date(NOW - 2 * HOUR), expiresAt: new Date(NOW - 2 * MIN) },
    NOW,
    MAX,
  );
  ok("old + just-expired lease → wedge (cron still blocked)", justExpired != null && justExpired.live === false);
}

// --- (4) Queue roll-up -------------------------------------------------
{
  console.log("summarizeQueue");
  const disabled = summarizeQueue(null, 50, false);
  ok("disabled queue → no breaches", disabled.enabled === false && disabled.breaches.length === 0);

  const snaps = [
    { name: "backfill", counts: { waiting: 3, active: 1, failed: 60, paused: 0 } },
    { name: "webhooks", counts: { waiting: 0, active: 2, failed: 5, paused: 1 } },
  ];
  const r = summarizeQueue(snaps, 50, true);
  ok("sums failed across queues", r.totalFailed === 65);
  ok("breaches only queues over threshold", r.breaches.length === 1 && r.breaches[0] === "queue:backfill");
  ok("approximates stalled as active-in-paused", r.totalStalled === 2);

  const nullCounts = summarizeQueue([{ name: "x", counts: null }], 50, true);
  ok("null counts handled", nullCounts.totalFailed === 0 && nullCounts.breaches.length === 0);
}

// --- (5) Dedup key -----------------------------------------------------
{
  console.log("buildAlertKey");
  const k1 = buildAlertKey([
    { reason: "no_progress", provider: "protractor", providerLabel: "Protractor", stalledMs: HOUR, incompleteShops: 3, lastBackfillSuccessMs: NOW },
    { reason: "drain_wedge", provider: "tekmetric", providerLabel: "Tekmetric", wedge: { owner: "x", heldMs: HOUR, acquiredAt: null, expiresAt: null, lastRefreshAt: null, live: true } },
  ]);
  ok("key is sorted + stable", k1 === "progress:protractor,wedge:tekmetric");

  // Order of hits must not change the key.
  const k2 = buildAlertKey([
    { reason: "drain_wedge", provider: "tekmetric", providerLabel: "Tekmetric", wedge: { owner: "x", heldMs: HOUR, acquiredAt: null, expiresAt: null, lastRefreshAt: null, live: true } },
    { reason: "no_progress", provider: "protractor", providerLabel: "Protractor", stalledMs: HOUR, incompleteShops: 3, lastBackfillSuccessMs: NOW },
  ]);
  ok("key is order-independent", k1 === k2);

  ok("empty hits → empty key", buildAlertKey([]) === "");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll pipeline-stall-alerter assertions passed");
