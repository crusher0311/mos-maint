/**
 * Snapshot-style smoke test for the pure VHI score helpers in
 * `lib/vhi-score.ts`. The full `rebuildVhi` pipeline depends on Mongo and a
 * remote plan-build service, but the *scoring* layer is pure: given the same
 * triaged buckets, the same score / tier / formatted item shape must come
 * out. These fixtures pin that contract so refactors during the DB cutover
 * can't silently shift bucket assignments or score tiers.
 *
 * Run: `npx tsx tests/vhi-score-snapshot.smoke.ts`
 */

import {
  separateComplimentary,
  computeScore,
  getScoreTier,
  formatVhiItem,
  categoryMultiplier,
} from "../lib/vhi-score";
import { getServiceIconSet } from "../lib/vhi-icons";
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
function eq(name: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `\n      expected: ${e}\n      actual:   ${a}`);
}

function item(overrides: Partial<TriagedItemCache>): TriagedItemCache {
  return {
    key: "k",
    serviceKey: "k",
    title: "t",
    ...overrides,
  };
}

async function run() {
  console.log("vhi-score-snapshot smoke");

  // ---- categoryMultiplier ------------------------------------------------
  eq("brakes → 1.5×", categoryMultiplier("Brakes"), 1.5);
  eq("engine → 1.3×", categoryMultiplier("engine oil"), 1.3);
  eq("wipers → 0.7×", categoryMultiplier("wiper blades"), 0.7);
  eq("misc → 1.0×", categoryMultiplier("misc"), 1.0);

  // ---- separateComplimentary --------------------------------------------
  // Complimentary items (e.g. tire_pressure_check, multi_point_inspection)
  // are pulled out of the priced buckets and into their own list. The
  // remaining buckets must NOT contain any complimentary item.
  {
    const buckets = {
      overdue: [
        item({ key: "brake_pads", serviceKey: "brake_pads", title: "Brake Pads", category: "brakes" }),
        item({ key: "tire_pressure_check", serviceKey: "tire_pressure_check", title: "Tire Pressure Check" }),
      ],
      dueSoon: [
        item({ key: "oil_change", serviceKey: "oil_change", title: "Engine Oil Change", category: "engine" }),
        item({ key: "multi_point_inspection", serviceKey: "multi_point_inspection", title: "Multi-Point Inspection" }),
      ],
      upcoming: [
        item({ key: "cabin_filter", serviceKey: "cabin_filter", title: "Cabin Air Filter", category: "cabin" }),
      ],
    };
    const out = separateComplimentary(buckets);
    eq("overdue retains only paid items", out.overdue.map((i) => i.key), ["brake_pads"]);
    eq("dueSoon retains only paid items", out.dueSoon.map((i) => i.key), ["oil_change"]);
    eq("upcoming retains items as-is", out.upcoming.map((i) => i.key), ["cabin_filter"]);
    eq("complimentary collected from all buckets", out.complimentary.map((i) => i.key).sort(),
      ["multi_point_inspection", "tire_pressure_check"]);
  }

  // ---- computeScore + getScoreTier — pinned fixtures --------------------
  // FIXTURE A — pristine vehicle: nothing overdue or due soon → 100, Excellent.
  {
    const score = computeScore({ overdue: [], dueSoon: [] });
    eq("FIXTURE A: pristine score", score, 100);
    eq("FIXTURE A: pristine tier", getScoreTier(score), { label: "Excellent", color: "green" });
  }

  // FIXTURE B — one overdue brake job (red bump) + one due-soon oil change.
  // Pinned values so a refactor of the deduction weights is a loud test
  // failure, not a silent shift in customer-facing scores.
  //   overdue brakes red:   7 * 1.5 = 10.5
  //   dueSoon engine oil:   2 * 1.3 = 2.6
  //   100 - 10.5 - 2.6 = 86.9 → round → 87 → "Good" (lime)
  {
    const buckets = {
      overdue: [item({ key: "brake_pads", title: "Brake Pads", category: "brakes", bump: "red" as const })],
      dueSoon: [item({ key: "oil_change", title: "Engine Oil", category: "engine" })],
    };
    const score = computeScore(buckets);
    eq("FIXTURE B: score", score, 87);
    eq("FIXTURE B: tier", getScoreTier(score), { label: "Good", color: "lime" });
  }

  // FIXTURE C — heavily neglected vehicle: multiple overdue critical items.
  //   overdue brakes red:        7 * 1.5 = 10.5
  //   overdue tires (default):   5 * 1.5 = 7.5
  //   overdue engine red+decl:  (7 * 1.3) + 1 = 10.1
  //   overdue suspension:        5 * 1.5 = 7.5
  //   100 - 10.5 - 7.5 - 10.1 - 7.5 = 64.4 → round → 64 → "Poor" (orange)
  {
    const buckets = {
      overdue: [
        item({ key: "brake_pads", title: "Brake Pads", category: "brakes", bump: "red" as const }),
        item({ key: "tires", title: "Tires", category: "tires" }),
        item({ key: "engine_oil", title: "Engine Oil", category: "engine", bump: "red" as const, declined: { serviceKey: "engine_oil", serviceName: "Engine Oil", declinedAt: "2026-01-01" } as any }),
        item({ key: "shocks", title: "Shocks", category: "suspension" }),
      ],
      dueSoon: [],
    };
    const score = computeScore(buckets);
    eq("FIXTURE C: score", score, 64);
    eq("FIXTURE C: tier", getScoreTier(score), { label: "Poor", color: "orange" });
  }

  // FIXTURE D — complimentary items must NOT count toward the score even
  // if they leak into the priced buckets (computeScore filters them out).
  {
    const buckets = {
      overdue: [
        item({ key: "tire_pressure_check", title: "Tire Pressure Check" }),
      ],
      dueSoon: [
        item({ key: "multi_point_inspection", title: "Multi-Point Inspection" }),
      ],
    };
    eq("FIXTURE D: complimentary items don't deduct", computeScore(buckets), 100);
  }

  // ---- getScoreTier boundaries ------------------------------------------
  eq("tier boundary: 90 = Excellent", getScoreTier(90).label, "Excellent");
  eq("tier boundary: 89 = Good",      getScoreTier(89).label, "Good");
  eq("tier boundary: 80 = Good",      getScoreTier(80).label, "Good");
  eq("tier boundary: 79 = Needs Attention", getScoreTier(79).label, "Needs Attention");
  eq("tier boundary: 70 = Needs Attention", getScoreTier(70).label, "Needs Attention");
  eq("tier boundary: 69 = Poor",      getScoreTier(69).label, "Poor");
  eq("tier boundary: 60 = Poor",      getScoreTier(60).label, "Poor");
  eq("tier boundary: 59 = Critical",  getScoreTier(59).label, "Critical");
  eq("tier boundary: 0 = Critical",   getScoreTier(0).label, "Critical");

  // ---- formatVhiItem snapshot -------------------------------------------
  // Pin the public shape returned to API consumers. iconStatus must follow
  // the bucket the triage system placed the item in (this is what makes a
  // deferred item still render the deferred icon even when interval math
  // says "ok").
  {
    const it = item({
      key: "engine_oil",
      serviceKey: "engine_oil",
      title: "Engine Oil & Filter",
      category: "engine",
      intervalMiles: 7500,
      intervalMonths: 12,
      last: { miles: 80000, date: "2025-05-01", source: "tekmetric" },
      dueAtMiles: 87500,
      milesToGo: -500,
      bump: "red" as const,
      source: "oem" as const,
      action: "replace",
      notes: "Use 0W-20 synthetic",
      recommendedDefault: false,
      declined: null,
    });
    const out = formatVhiItem(it, { currentMiles: 88000, today: new Date("2026-05-01T00:00:00Z"), bucket: "overdue" });
    eq("formatVhiItem: key passthrough", out.key, "engine_oil");
    eq("formatVhiItem: title passthrough", out.title, "Engine Oil & Filter");
    eq("formatVhiItem: intervalMiles passthrough", out.intervalMiles, 7500);
    eq("formatVhiItem: declined coerced to bool", out.declined, false);
    eq("formatVhiItem: iconStatus follows bucket", out.iconStatus, "overdue");
    eq("formatVhiItem: iconSvg null by default", out.iconSvg, null);
    ok("formatVhiItem: progress is computed", out.progress != null);
  }

  // Deferred bucket → deferred iconStatus, even with no progress info.
  {
    const it = item({ key: "x", serviceKey: "x", title: "Deferred Job" });
    const out = formatVhiItem(it, { bucket: "deferred" });
    eq("deferred bucket → deferred iconStatus", out.iconStatus, "deferred");
  }

  // ---- service-icon contract (Task #675) --------------------------------
  // Partners render the per-service pictogram by resolving an item's
  // serviceIconKey against the top-level serviceIcons map. Pin that
  // (a) a known oil item resolves to the oil icon, (b) the set has markup
  // for that key + the default fallback, and (c) unmatched items fall back
  // to the general icon — so serviceKey/title changes can't silently break
  // partner icons.
  {
    const oil = formatVhiItem(
      item({ key: "oil", serviceKey: null, title: "Oil Change" }),
      { bucket: "overdue" },
    );
    eq("formatVhiItem: oil item → oil_change service icon key", oil.serviceIconKey, "oil_change");

    const diff = formatVhiItem(
      item({ key: "d", serviceKey: "differential_rear", title: "Rear Differential Service" }),
      { bucket: "dueSoon" },
    );
    eq("formatVhiItem: differential item → differential service icon key", diff.serviceIconKey, "differential_rear");

    const unmatched = formatVhiItem(
      item({ key: "z", serviceKey: "zzz_unknown_widget", title: "Zorptastic Whatsit" }),
      { bucket: "upcoming" },
    );
    eq("formatVhiItem: unmatched item → general_service fallback key", unmatched.serviceIconKey, "general_service");

    const set = getServiceIconSet();
    ok(
      "getServiceIconSet: has markup for oil_change",
      typeof set.oil_change === "string" && set.oil_change.includes("<svg"),
    );
    ok(
      "getServiceIconSet: has markup for general_service fallback",
      typeof set.general_service === "string" && set.general_service.includes("<svg"),
    );
    ok(
      "getServiceIconSet: has markup for differential_rear",
      typeof set.differential_rear === "string" && set.differential_rear.includes("<svg"),
    );
    ok(
      "getServiceIconSet: has markup for dvi_finding",
      typeof set.dvi_finding === "string" && set.dvi_finding.includes("<svg"),
    );
  }

  if (failed > 0) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll snapshot checks passed.");
}

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
