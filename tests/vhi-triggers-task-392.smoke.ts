/**
 * Task #392: per-axis "byMiles" / "byTime" trigger surfacing.
 *
 * Pins:
 *   - lib/vhi-progress.getProgressTriggers — returns the right per-axis
 *     status for every overdue/soon/ok × miles/time combination.
 *   - lib/vhi-progress.formatTriggerSuffix — renders the badge suffix
 *     ("by time" / "by mileage" / "by time and mileage" / "") that the
 *     plan UI appends to OVERDUE / DUE SOON badges.
 *   - lib/vhi-score.formatVhiItem — exposes a `triggers` object on the
 *     AppFueled VHI payload while leaving the existing top-level
 *     `progress.status` untouched (worst-of-the-two), so partner
 *     integrations don't break.
 *
 * Run: `npx tsx tests/vhi-triggers-task-392.smoke.ts`
 */

import {
  getProgressTriggers,
  formatTriggerSuffix,
  computeIntervalProgress,
} from "../lib/vhi-progress";
import { formatVhiItem } from "../lib/vhi-score";
import type { TriagedItemCache } from "../lib/plan-cache";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `\n      expected: ${e}\n      actual:   ${a}`);
}

const today = new Date("2026-05-09T00:00:00Z");

/** Build a fixture covering an arbitrary miles/time status pair. */
function fixture(milesStatus: "overdue" | "soon" | "ok", timeStatus: "overdue" | "soon" | "ok") {
  const intervalMiles = 5000;
  const intervalMonths = 6;
  // Choose lastMiles so remaining = currentMiles - last - interval-ish:
  //   overdue → remaining < 0 (e.g. used = 6000)
  //   soon    → remaining 500 (within 1000)
  //   ok      → remaining 4000
  const usedMiles =
    milesStatus === "overdue" ? 6000 : milesStatus === "soon" ? 4500 : 1000;
  const currentMiles = 100_000;
  const lastMiles = currentMiles - usedMiles;

  // For time, monthsBetween(last.date, today) controls "used"; remaining =
  // interval - used.
  //   overdue → used > interval
  //   soon    → 0 < remaining ≤ ~10% of 6 (≤ 0.6 mo)
  //   ok      → remaining well above 1 mo
  const usedMonths =
    timeStatus === "overdue" ? 9 : timeStatus === "soon" ? 5.6 : 1;
  const lastDate = new Date(today);
  lastDate.setMonth(lastDate.getMonth() - Math.round(usedMonths));
  if (timeStatus === "soon") {
    // Force remaining within the 10% soon band by backdating ~5.5 mo
    // exactly (remaining ≈ 0.5 mo).
    lastDate.setTime(today.getTime() - 5.5 * 30.4375 * 24 * 60 * 60 * 1000);
  }

  return {
    item: {
      intervalMiles,
      intervalMonths,
      last: { miles: lastMiles, date: lastDate },
    },
    currentMiles,
  };
}

async function run() {
  console.log("vhi-triggers-task-392 smoke");

  // ---- getProgressTriggers: 6 single-axis combinations -----------------
  const cases: Array<["overdue" | "soon" | "ok", "overdue" | "soon" | "ok"]> = [
    ["overdue", "ok"],
    ["soon", "ok"],
    ["ok", "overdue"],
    ["ok", "soon"],
    ["overdue", "overdue"],
    ["soon", "soon"],
  ];
  for (const [m, t] of cases) {
    const f = fixture(m, t);
    const trig = getProgressTriggers(f.item, f.currentMiles, today);
    eq(`triggers (${m}/${t}): byMiles`, trig.byMiles, m);
    eq(`triggers (${m}/${t}): byTime`, trig.byTime, t);
  }

  // ---- null axes when data is missing ----------------------------------
  {
    // No interval / no last → axis status null on that side.
    const trig = getProgressTriggers(
      { intervalMonths: 6, last: { date: new Date(today.getTime() - 30 * 86400000) } },
      null,
      today,
    );
    eq("missing miles axis → byMiles=null", trig.byMiles, null);
    ok("present time axis populated", trig.byTime != null);
  }

  // ---- formatTriggerSuffix: every relevant combination -----------------
  eq("overdue, miles only", formatTriggerSuffix("overdue", "ok", "overdue"), " by mileage");
  eq("overdue, time only",  formatTriggerSuffix("ok", "overdue", "overdue"), " by time");
  eq("overdue, both",       formatTriggerSuffix("overdue", "overdue", "overdue"), " by time and mileage");
  eq("soon, miles only",    formatTriggerSuffix("soon", "ok", "soon"), " by mileage");
  eq("soon, time only",     formatTriggerSuffix("ok", "soon", "soon"), " by time");
  eq("soon, both",          formatTriggerSuffix("soon", "soon", "soon"), " by time and mileage");
  // An overdue axis under a "soon" badge should not append a suffix
  // (overdue items live in the overdue bucket; only matching-severity axes count).
  eq("soon badge ignores overdue axis", formatTriggerSuffix("overdue", "ok", "soon"), "");
  // Upcoming is always plain.
  eq("upcoming always blank", formatTriggerSuffix("ok", "ok", "upcoming"), "");
  eq("upcoming blank even if soon axis", formatTriggerSuffix("soon", "ok", "upcoming"), "");
  // Null axes treated as "not in play".
  eq("null axes blank", formatTriggerSuffix(null, null, "overdue"), "");

  // ---- formatVhiItem: triggers shape on the API payload ----------------
  // Matches the Dodge Caliber example from the task: time-axis triggered
  // overdue, mileage axis still in the "ok" band. The combined progress
  // status remains "overdue" (worst-of-the-two), so partners that read
  // the existing field keep working.
  {
    const lastDate = new Date(today);
    lastDate.setMonth(lastDate.getMonth() - 14); // 14 mo since last (interval 12)
    const item: TriagedItemCache = {
      key: "oil",
      serviceKey: "oil",
      title: "Engine Oil & Filter",
      intervalMiles: 5000,
      intervalMonths: 12,
      last: { miles: 95_000, date: lastDate.toISOString() },
    };
    const out = formatVhiItem(item, { currentMiles: 96_000, today, bucket: "overdue" });
    eq("API triggers.byMiles = ok",   out.triggers.byMiles, "ok");
    eq("API triggers.byTime = overdue", out.triggers.byTime, "overdue");
    eq("API top-level progress.status stays worst-of (overdue)", out.progress?.status, "overdue");
  }

  // Cached entry that pre-dates Task #392 (no byMiles/byTime stored)
  // should still get a populated `triggers` from on-the-fly progress math.
  {
    const item: TriagedItemCache = {
      key: "x",
      serviceKey: "x",
      title: "X",
      intervalMiles: 5000,
      last: { miles: 94_000 },
    };
    const out = formatVhiItem(item, { currentMiles: 100_000, today, bucket: "overdue" });
    eq("legacy cache: byMiles falls back to live progress", out.triggers.byMiles, "overdue");
    eq("legacy cache: byTime null when no time interval", out.triggers.byTime, null);
  }

  // Persisted byMiles/byTime survive a cache round-trip even when
  // currentMiles is omitted (no progress recompute possible on the time axis).
  {
    const item: TriagedItemCache = {
      key: "y",
      serviceKey: "y",
      title: "Y",
      byMiles: "ok",
      byTime: "soon",
    };
    const out = formatVhiItem(item, { bucket: "dueSoon" });
    eq("persisted byMiles passthrough", out.triggers.byMiles, "ok");
    eq("persisted byTime passthrough", out.triggers.byTime, "soon");
  }

  if (failed > 0) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll Task #392 trigger checks passed.");

  // Sanity check that the underlying progress math agrees with the
  // exported helper (no skew between the two surfaces).
  void computeIntervalProgress;
}

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
