// Smoke test for the smart-backfill-timing pure logic (task #662).
// Standalone tsx + node:assert (matches the other tests/*.smoke.ts). NO DB.
import assert from "node:assert";
import {
  getSmartBackfillTimingMode,
  getQuietWindowMinConfidence,
  getMachineBurstThreshold,
  getEnforceShopAllowlist,
  emptyHistogram,
  localHourForTimezone,
  timezoneOffsetHours,
  shiftHistogramToLocal,
  filterMinuteBuckets,
  filterMachineBursts,
  buildUtcHourHistogram,
  countDistinctUtcDays,
  hourInWindow,
  deriveQuietWindows,
  computeConfidence,
  inferTimezoneFromUtcHistogram,
  decideQuietWindowGate,
  describeGateDecision,
  type ActivityProfile,
} from "../lib/integrations/activity-profile/profile";
import {
  inferTimezoneFromUsState,
  inferTimezoneFromUsZip,
  inferTimezoneFromAddress,
} from "../lib/integrations/activity-profile/timezone";
import {
  applyQuietWindowGate,
  type QuietWindowGateContext,
} from "../lib/data/repositories/activity-profiles";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

/* ------------------------------- flag reader ------------------------------ */

check("flag mode defaults to off and parses variants", () => {
  assert.equal(getSmartBackfillTimingMode({} as any), "off");
  assert.equal(getSmartBackfillTimingMode({ SMART_BACKFILL_TIMING: "" } as any), "off");
  assert.equal(
    getSmartBackfillTimingMode({ SMART_BACKFILL_TIMING: "observe" } as any),
    "observe",
  );
  assert.equal(
    getSmartBackfillTimingMode({ SMART_BACKFILL_TIMING: "dry-run" } as any),
    "observe",
  );
  assert.equal(
    getSmartBackfillTimingMode({ SMART_BACKFILL_TIMING: "enforce" } as any),
    "enforce",
  );
  assert.equal(
    getSmartBackfillTimingMode({ SMART_BACKFILL_TIMING: "ON" } as any),
    "enforce",
  );
  assert.equal(
    getSmartBackfillTimingMode({ SMART_BACKFILL_TIMING: "garbage" } as any),
    "off",
  );
});

check("min-confidence + burst threshold defaults and bounds", () => {
  assert.equal(getQuietWindowMinConfidence({} as any), 0.5);
  assert.equal(
    getQuietWindowMinConfidence({ SMART_BACKFILL_TIMING_MIN_CONFIDENCE: "0.8" } as any),
    0.8,
  );
  assert.equal(
    getQuietWindowMinConfidence({ SMART_BACKFILL_TIMING_MIN_CONFIDENCE: "5" } as any),
    0.5,
  );
  assert.equal(getMachineBurstThreshold({} as any), 20);
  assert.equal(
    getMachineBurstThreshold({ SMART_BACKFILL_TIMING_BURST_PER_MIN: "50" } as any),
    50,
  );
  assert.equal(
    getMachineBurstThreshold({ SMART_BACKFILL_TIMING_BURST_PER_MIN: "1" } as any),
    20,
  );
});

check("enforce shop allowlist parses list, null when unset", () => {
  assert.equal(getEnforceShopAllowlist({} as any), null);
  assert.equal(getEnforceShopAllowlist({ SMART_BACKFILL_TIMING_SHOP_IDS: "" } as any), null);
  assert.equal(
    getEnforceShopAllowlist({ SMART_BACKFILL_TIMING_SHOP_IDS: "  ,  " } as any),
    null,
  );
  const set = getEnforceShopAllowlist({
    SMART_BACKFILL_TIMING_SHOP_IDS: "151, 158  166,abc",
  } as any);
  assert.ok(set);
  assert.deepEqual([...set!].sort((a, b) => a - b), [151, 158, 166]);
});

/* ----------------------------- tz / histogram ----------------------------- */

check("emptyHistogram is 24 zeros", () => {
  const h = emptyHistogram();
  assert.equal(h.length, 24);
  assert.ok(h.every((v) => v === 0));
});

check("timezone offset + local hour are consistent", () => {
  // Pick a fixed instant: 2026-01-15T18:00:00Z (winter, no US DST).
  const at = new Date("2026-01-15T18:00:00Z");
  assert.equal(timezoneOffsetHours("America/Chicago", at), -6);
  assert.equal(timezoneOffsetHours("America/New_York", at), -5);
  assert.equal(localHourForTimezone("America/Chicago", at), 12); // 18 - 6
  assert.equal(localHourForTimezone("America/New_York", at), 13); // 18 - 5
});

check("shiftHistogramToLocal rotates by offset", () => {
  const utc = emptyHistogram();
  utc[18] = 10; // a spike at 18:00 UTC
  const local = shiftHistogramToLocal(utc, -6); // CST
  assert.equal(local[12], 10); // 18:00 UTC -> 12:00 local
  assert.equal(local.reduce((a, b) => a + b, 0), 10);
});

/* ------------------------------ burst filter ------------------------------ */

check("filterMinuteBuckets drops machine bursts, keeps organic", () => {
  const res = filterMinuteBuckets([3, 50, 1, 25], 20);
  assert.equal(res.organicCount, 4); // 3 + 1
  assert.equal(res.filteredCount, 75); // 50 + 25
});

check("filterMachineBursts collapses same-minute spikes from timestamps", () => {
  const base = Date.UTC(2026, 5, 1, 14, 0, 0);
  const ts: Date[] = [];
  // 30 events in the same minute = a machine burst.
  for (let i = 0; i < 30; i++) ts.push(new Date(base + i * 500));
  // 2 organic events in the next minute.
  ts.push(new Date(base + 61_000));
  ts.push(new Date(base + 62_000));
  const res = filterMachineBursts(ts, 20);
  assert.equal(res.organic.length, 2);
  assert.equal(res.filteredCount, 30);
});

check("buildUtcHourHistogram + countDistinctUtcDays", () => {
  const ts = [
    new Date("2026-06-01T14:30:00Z"),
    new Date("2026-06-01T14:45:00Z"),
    new Date("2026-06-02T09:00:00Z"),
  ];
  const hist = buildUtcHourHistogram(ts);
  assert.equal(hist[14], 2);
  assert.equal(hist[9], 1);
  assert.equal(countDistinctUtcDays(ts), 2);
});

/* --------------------------- quiet window derive -------------------------- */

check("deriveQuietWindows finds the overnight lull", () => {
  // Busy 8:00-18:00 local, quiet overnight.
  const hist = emptyHistogram();
  for (let h = 8; h <= 18; h++) hist[h] = 100;
  const { primary, windows } = deriveQuietWindows(hist);
  assert.ok(primary, "expected a primary window");
  assert.ok(windows.length >= 1);
  // The quiet window should contain a deep-night hour like 3am.
  assert.ok(hourInWindow(3, primary!));
  // ...and must NOT contain a busy midday hour.
  assert.ok(!hourInWindow(12, primary!));
});

check("deriveQuietWindows: no-data and uniform data yield no window", () => {
  // No events at all -> nothing to derive.
  assert.deepEqual(deriveQuietWindows(emptyHistogram()), {
    windows: [],
    primary: null,
  });
  // Perfectly uniform activity has no quiet contrast -> no window.
  const { primary } = deriveQuietWindows(new Array(24).fill(1));
  assert.equal(primary, null);
});

check("hourInWindow handles wrap-around windows", () => {
  const w = { startHour: 22, endHour: 6 }; // 10pm - 6am
  assert.ok(hourInWindow(23, w));
  assert.ok(hourInWindow(2, w));
  assert.ok(!hourInWindow(12, w));
});

/* ------------------------------- confidence ------------------------------- */

check("confidence high for clear day/night split, 0 for sparse", () => {
  const hist = emptyHistogram();
  for (let h = 8; h <= 18; h++) hist[h] = 30;
  const { primary } = deriveQuietWindows(hist);
  const conf = computeConfidence({
    totalOrganicEvents: 330,
    distinctActiveDays: 20,
    localHist: hist,
    primaryQuietWindow: primary,
  });
  assert.ok(conf > 0.7, `expected high confidence, got ${conf}`);

  const sparse = computeConfidence({
    totalOrganicEvents: 5,
    distinctActiveDays: 2,
    localHist: hist,
    primaryQuietWindow: primary,
  });
  assert.equal(sparse, 0);
});

check("confidence capped when too few active days", () => {
  const hist = emptyHistogram();
  for (let h = 8; h <= 18; h++) hist[h] = 30;
  const { primary } = deriveQuietWindows(hist);
  const conf = computeConfidence({
    totalOrganicEvents: 330,
    distinctActiveDays: 2, // < minActiveDays
    localHist: hist,
    primaryQuietWindow: primary,
  });
  assert.ok(conf <= 0.3, `expected capped confidence, got ${conf}`);
});

/* --------------------------- tz from activity ----------------------------- */

check("inferTimezoneFromUtcHistogram lands near the right zone", () => {
  // Eastern shop: busy 13:00-21:00 UTC (≈9am-5pm EDT).
  const hist = emptyHistogram();
  for (let h = 13; h <= 21; h++) hist[h] = 50;
  const est = inferTimezoneFromUtcHistogram(hist);
  assert.ok(est);
  assert.ok(
    ["America/New_York", "America/Chicago"].includes(est!.timezone),
    `got ${est!.timezone}`,
  );
  assert.equal(inferTimezoneFromUtcHistogram(emptyHistogram()), null);
});

/* ------------------------------ tz from address --------------------------- */

check("US state + zip -> IANA tz", () => {
  assert.equal(inferTimezoneFromUsState("CA"), "America/Los_Angeles");
  assert.equal(inferTimezoneFromUsState("ny"), "America/New_York");
  assert.equal(inferTimezoneFromUsState("TX"), "America/Chicago");
  assert.equal(inferTimezoneFromUsZip("90001"), "America/Los_Angeles");
  assert.equal(inferTimezoneFromUsState("ZZ"), null);
});

check("inferTimezoneFromAddress prefers explicit IANA tz", () => {
  assert.equal(
    inferTimezoneFromAddress({ timezone: "America/Denver", state: "CA" }),
    "America/Denver",
  );
  assert.equal(inferTimezoneFromAddress({ state: "FL" }), "America/New_York");
  assert.equal(inferTimezoneFromAddress({ zip: "98101" }), "America/Los_Angeles");
});

/* -------------------------------- the gate -------------------------------- */

function makeProfile(over: Partial<ActivityProfile>): ActivityProfile {
  return {
    shopId: 1,
    provider: "tekmetric",
    timezone: "America/Chicago",
    timezoneSource: "shop",
    hourHistogramUtc: emptyHistogram(),
    hourHistogramLocal: emptyHistogram(),
    totalOrganicEvents: 300,
    totalRawEvents: 400,
    machineEventsFiltered: 100,
    distinctActiveDays: 20,
    sampleWindowDays: 28,
    quietWindows: [{ startHour: 22, endHour: 6 }],
    primaryQuietWindow: { startHour: 22, endHour: 6 },
    confidence: 0.9,
    perProviderCounts: { tekmetric: 300 },
    computedAt: new Date().toISOString(),
    ...over,
  };
}

check("gate: no profile -> eligible fallback", () => {
  const d = decideQuietWindowGate({ profile: null, minConfidence: 0.5 });
  assert.equal(d.eligible, true);
  assert.equal(d.fallback, true);
  assert.equal(d.reason, "no_profile");
});

check("gate: low confidence -> eligible fallback", () => {
  const d = decideQuietWindowGate({
    profile: makeProfile({ confidence: 0.2 }),
    minConfidence: 0.5,
  });
  assert.equal(d.eligible, true);
  assert.equal(d.fallback, true);
  assert.equal(d.reason, "low_confidence");
});

check("gate: inside quiet window -> eligible, outside -> blocked", () => {
  const profile = makeProfile({}); // quiet 22:00-06:00 Central
  // 04:00 Central == 10:00 UTC (winter).
  const inWin = decideQuietWindowGate({
    profile,
    minConfidence: 0.5,
    now: new Date("2026-01-15T10:00:00Z"),
  });
  assert.equal(inWin.eligible, true);
  assert.equal(inWin.reason, "in_quiet_window");
  assert.equal(inWin.fallback, false);

  // 14:00 Central == 20:00 UTC (winter) -> busy, outside the window.
  const outWin = decideQuietWindowGate({
    profile,
    minConfidence: 0.5,
    now: new Date("2026-01-15T20:00:00Z"),
  });
  assert.equal(outWin.eligible, false);
  assert.equal(outWin.reason, "outside_quiet_window");
  assert.equal(outWin.fallback, false);
  assert.ok(describeGateDecision(profile.shopId, outWin).includes("eligible=false"));
});

/* ------------------------- gate wrapper (off/observe/enforce) ------------- */

function makeCtx(
  mode: QuietWindowGateContext["mode"],
  profiles: Array<[number, ActivityProfile]> = [],
  now = new Date("2026-01-15T20:00:00Z"), // 14:00 Central -> busy/outside window
  allowlist: Set<number> | null = null,
): QuietWindowGateContext {
  return {
    mode,
    minConfidence: 0.5,
    profiles: new Map(profiles),
    now,
    allowlist,
  };
}

check("gate wrapper: OFF never skips, no decision (provider-agnostic)", () => {
  const ctx = makeCtx("off", [[7, makeProfile({ shopId: 7 })]]);
  for (const provider of [
    "tekmetric",
    "shopware",
    "protractor",
    "shopmonkey",
    "autoflow",
  ]) {
    const r = applyQuietWindowGate(ctx, 7, provider);
    assert.equal(r.shouldSkip, false);
    assert.equal(r.decision, null);
  }
});

check("gate wrapper: OBSERVE never skips even when outside window (shopmonkey)", () => {
  const ctx = makeCtx("observe", [[42, makeProfile({ shopId: 42 })]]);
  const r = applyQuietWindowGate(ctx, 42, "shopmonkey");
  assert.equal(r.shouldSkip, false);
  assert.ok(r.decision);
  assert.equal(r.decision!.eligible, false);
  assert.equal(r.decision!.reason, "outside_quiet_window");
});

check("gate wrapper: ENFORCE skips out-of-window shop (shopmonkey)", () => {
  const ctx = makeCtx("enforce", [[42, makeProfile({ shopId: 42 })]]);
  const r = applyQuietWindowGate(ctx, 42, "shopmonkey");
  assert.equal(r.shouldSkip, true);
  assert.equal(r.decision!.eligible, false);
});

check("gate wrapper: ENFORCE allows in-window shop", () => {
  // 04:00 Central == 10:00 UTC (winter) -> inside 22:00-06:00 window.
  const ctx = makeCtx(
    "enforce",
    [[42, makeProfile({ shopId: 42 })]],
    new Date("2026-01-15T10:00:00Z"),
  );
  const r = applyQuietWindowGate(ctx, 42, "shopmonkey");
  assert.equal(r.shouldSkip, false);
  assert.equal(r.decision!.eligible, true);
  assert.equal(r.decision!.reason, "in_quiet_window");
});

check("gate wrapper: ENFORCE falls back (no skip) when no profile", () => {
  const ctx = makeCtx("enforce", []); // empty map -> no profile for shop
  const r = applyQuietWindowGate(ctx, 99, "shopmonkey");
  assert.equal(r.shouldSkip, false);
  assert.equal(r.decision!.fallback, true);
  assert.equal(r.decision!.reason, "no_profile");
});

check("gate wrapper: ENFORCE + canary allowlist only skips allowlisted shop", () => {
  // Shop 42 is out-of-window and WOULD be skipped, but the allowlist only
  // contains shop 7, so 42 runs as today (no skip) while still being decided.
  const ctx = makeCtx(
    "enforce",
    [[42, makeProfile({ shopId: 42 })]],
    new Date("2026-01-15T20:00:00Z"),
    new Set([7]),
  );
  const r = applyQuietWindowGate(ctx, 42, "tekmetric");
  assert.equal(r.shouldSkip, false); // not in canary -> not enforced
  assert.equal(r.decision!.eligible, false);
  assert.equal(r.decision!.reason, "outside_quiet_window");
});

check("gate wrapper: ENFORCE + canary allowlist skips an allowlisted out-of-window shop", () => {
  const ctx = makeCtx(
    "enforce",
    [[42, makeProfile({ shopId: 42 })]],
    new Date("2026-01-15T20:00:00Z"),
    new Set([42]),
  );
  const r = applyQuietWindowGate(ctx, 42, "tekmetric");
  assert.equal(r.shouldSkip, true); // in canary + out of window -> skipped
  assert.equal(r.decision!.eligible, false);
});

check("gate wrapper: OBSERVE ignores allowlist (never skips)", () => {
  const ctx = makeCtx(
    "observe",
    [[42, makeProfile({ shopId: 42 })]],
    new Date("2026-01-15T20:00:00Z"),
    new Set([42]),
  );
  const r = applyQuietWindowGate(ctx, 42, "tekmetric");
  assert.equal(r.shouldSkip, false);
  assert.equal(r.decision!.eligible, false);
});

console.log(`\nactivity-profile.smoke: ${passed} checks passed`);
