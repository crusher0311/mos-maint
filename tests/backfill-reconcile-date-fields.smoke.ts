/**
 * Smoke test for the backfill-reconcile date-semantics contract.
 *
 * Run: `npx tsx tests/backfill-reconcile-date-fields.smoke.ts`
 *
 * Covers the "reconcile reopens completed shops" failure mode:
 *
 *   1. Tekmetric upstream sample MUST filter by POSTED date (not updated
 *      date) so it matches the local `closedAt` semantics
 *      (`postedDate || completedDate || updatedDate`).
 *   2. The local count matches BOTH job_index row shapes (string `closedAt`
 *      from full-page backfill, Date `performedAt` from webhook/poll).
 *   3. The recently-updated-old-RO scenario produces NO false shortfall
 *      end-to-end (simulated), while a genuine shortfall still re-queues.
 *   4. Protractor day-bounds span the full inclusive UTC day window.
 *   5. Directional delta + tolerance + zero-count guard behavior.
 *
 * No DB or network — everything under test is pure and lives in
 * `app/api/cron/backfill-reconcile/lib.ts`.
 */

import {
  DELTA_TOLERANCE,
  buildTekmetricUpstreamParams,
  buildTekmetricLocalQuery,
  protractorDayBounds,
  computeShortfallDelta,
  sawAnyStoredData,
  decideRequeue,
} from "../app/api/cron/backfill-reconcile/lib";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
console.log("1. Tekmetric upstream sample uses posted-date filters");
{
  const p = buildTekmetricUpstreamParams(
    123,
    "2021-03-01T04:15:00.000Z",
    "2021-03-31T04:15:00.000Z"
  );
  check("postedDateStart set", p.get("postedDateStart") === "2021-03-01T04:15:00.000Z");
  check("postedDateEnd set", p.get("postedDateEnd") === "2021-03-31T04:15:00.000Z");
  check("updatedDateStart NOT used", p.get("updatedDateStart") === null);
  check("updatedDateEnd NOT used", p.get("updatedDateEnd") === null);
  check("shop id set", p.get("shop") === "123");
  check("size=1 sample", p.get("size") === "1");
}

// ---------------------------------------------------------------------------
console.log("2. Tekmetric local query matches both row shapes");
{
  const startIso = "2021-03-01T04:15:00.000Z";
  const endIso = "2021-03-31T04:15:00.000Z";
  const q = buildTekmetricLocalQuery(7, startIso, endIso);
  check("shopId scoped", q.shopId === 7);
  check("sourceSystem tekmetric", q.sourceSystem === "tekmetric");
  const or = q.$or as any[];
  check("$or has two branches", Array.isArray(or) && or.length === 2);
  const closedBranch = or.find((b) => b.closedAt);
  const performedBranch = or.find((b) => b.performedAt);
  check(
    "closedAt branch uses STRING bounds",
    typeof closedBranch?.closedAt?.$gte === "string" &&
      closedBranch.closedAt.$gte === startIso &&
      closedBranch.closedAt.$lte === endIso
  );
  check(
    "performedAt branch uses DATE bounds",
    performedBranch?.performedAt?.$gte instanceof Date &&
      performedBranch.performedAt.$gte.toISOString() === startIso &&
      performedBranch.performedAt.$lte instanceof Date &&
      performedBranch.performedAt.$lte.toISOString() === endIso
  );

  // Simulated matcher mirroring Mongo's typed comparison: a string range
  // never matches a Date value and vice versa.
  type Row = { closedAt?: string; performedAt?: Date };
  const matches = (row: Row): boolean =>
    (typeof row.closedAt === "string" &&
      row.closedAt >= closedBranch.closedAt.$gte &&
      row.closedAt <= closedBranch.closedAt.$lte) ||
    (row.performedAt instanceof Date &&
      row.performedAt >= performedBranch.performedAt.$gte &&
      row.performedAt <= performedBranch.performedAt.$lte);

  check("full-page row (string closedAt) counted", matches({ closedAt: "2021-03-15T10:00:00Z" }));
  check(
    "webhook/poll row (Date performedAt) counted",
    matches({ performedAt: new Date("2021-03-15T10:00:00Z") })
  );
  check("out-of-window row excluded", !matches({ closedAt: "2019-06-01T10:00:00Z" }));
}

// ---------------------------------------------------------------------------
console.log("3. Recently-updated old RO causes NO false reopen (simulated)");
{
  // Upstream shop history: 50 ROs posted in the sampled window, PLUS one RO
  // posted years earlier that was touched (updated) yesterday. Under the old
  // updatedDate sampling, that old RO landed in the recent window's upstream
  // count while our local row (keyed by its old close date) did not — a fake
  // shortfall. Under postedDate sampling, both sides see the same 50.
  const windowStart = "2021-03-01T00:00:00.000Z";
  const windowEnd = "2021-03-31T00:00:00.000Z";
  const upstreamRos = [
    ...Array.from({ length: 50 }, (_, i) => ({
      postedDate: `2021-03-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`,
      updatedDate: `2021-03-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`,
    })),
    // The troublemaker: closed 2018, updated yesterday.
    { postedDate: "2018-06-01T12:00:00Z", updatedDate: "2026-07-08T12:00:00Z" },
  ];
  const sampledByPostedDate = upstreamRos.filter(
    (ro) => ro.postedDate >= windowStart && ro.postedDate <= windowEnd
  ).length;
  // Local job_index: the 50 in-window ROs are stored with matching closedAt;
  // the old RO's row carries its 2018 close date (correctly out of window).
  const ourCount = 50;
  const delta = computeShortfallDelta(sampledByPostedDate, ourCount);
  check("upstream posted-date sample = 50 (old RO excluded)", sampledByPostedDate === 50);
  check("no shortfall (delta 0)", delta === 0);
  const { shouldRequeue } = decideRequeue([{ ours: ourCount, delta }]);
  check("shop NOT re-queued", !shouldRequeue);

  // Contrast: the OLD updatedDate sampling would have shown 50 upstream in
  // this window too — but sampling a RECENT window would count the old RO
  // upstream (updated yesterday) with no matching local closedAt row:
  const recentUpstream = upstreamRos.filter(
    (ro) => ro.updatedDate >= "2026-07-01T00:00:00Z"
  ).length;
  check("old sampling WOULD have seen a phantom RO in the recent window", recentUpstream === 1);
}

// ---------------------------------------------------------------------------
console.log("4. Genuine shortfalls still detected and re-queued");
{
  const delta = computeShortfallDelta(100, 60); // missing 40%
  check("40% shortfall exceeds tolerance", delta > DELTA_TOLERANCE);
  const { shouldRequeue, zeroCountGuardTripped } = decideRequeue([
    { ours: 60, delta },
    { ours: 80, delta: 0 },
  ]);
  check("re-queued", shouldRequeue);
  check("zero-count guard not tripped", !zeroCountGuardTripped);
}

// ---------------------------------------------------------------------------
console.log("5. Directional delta, tolerance, zero-count guard");
{
  check("overcount yields 0", computeShortfallDelta(50, 80) === 0);
  check("zero upstream yields 0", computeShortfallDelta(0, 0) === 0);
  check("small drift within tolerance", computeShortfallDelta(100, 95) <= DELTA_TOLERANCE);
  check("sawAnyStoredData false on all-zero", !sawAnyStoredData([{ ours: 0 }, { ours: 0 }]));
  check("sawAnyStoredData true with data", sawAnyStoredData([{ ours: 0 }, { ours: 3 }]));
  const guard = decideRequeue([{ ours: 0, delta: 1 }, { ours: 0, delta: 1 }]);
  check("all-zero windows: guard trips, no requeue", !guard.shouldRequeue && guard.zeroCountGuardTripped);
}

// ---------------------------------------------------------------------------
console.log("6. Protractor inclusive UTC day bounds");
{
  const { lowerBound, upperBound } = protractorDayBounds("2021-03-01", "2021-03-31");
  check("lower bound is 00:00:00.000Z", lowerBound.toISOString() === "2021-03-01T00:00:00.000Z");
  check("upper bound is 23:59:59.999Z", upperBound.toISOString() === "2021-03-31T23:59:59.999Z");
  // A same-day invoice at either edge of the window must be included.
  const earlyRow = new Date("2021-03-01T00:30:00Z");
  const lateRow = new Date("2021-03-31T23:30:00Z");
  check("early edge included", earlyRow >= lowerBound && earlyRow <= upperBound);
  check("late edge included", lateRow >= lowerBound && lateRow <= upperBound);
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll backfill-reconcile date-field checks passed.");
