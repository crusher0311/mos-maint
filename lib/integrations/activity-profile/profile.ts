// Smart per-shop backfill timing — pure logic (task #662).
//
// NO database access, NO side effects: everything here is deterministic so it
// can be unit-tested in isolation (see tests/activity-profile.smoke.ts). The
// DB I/O (reading provider event collections, writing profiles) lives in the
// repository layer `lib/data/repositories/activity-profiles.ts`.
//
// The feature gates each shop's *historical* backfill to that shop's own quiet
// window (in local time), inferred from its organic webhook/callback activity.
// It sits ON TOP of the existing global concurrency cap + worker power schedule
// and is fully off by default.

export type SmartTimingMode = "off" | "observe" | "enforce";

export interface QuietWindow {
  // Local-time hours. A window is [startHour, endHour). When endHour <= startHour
  // the window wraps past midnight (e.g. {start:22,end:6} = 10pm–6am).
  startHour: number;
  endHour: number;
}

export interface ActivityProfile {
  shopId: number;
  // The shop's historical-backfill provider this profile gates.
  provider: string;
  timezone: string;
  timezoneSource: "shop" | "address" | "activity" | "default";
  // Organic event counts bucketed by hour (0-23), in UTC and in local time.
  hourHistogramUtc: number[]; // length 24
  hourHistogramLocal: number[]; // length 24
  // Organic counts by [dayOfWeek 0=Sun..6=Sat][hour 0-23], UTC.
  dayHourHistogramUtc?: number[][];
  totalOrganicEvents: number;
  totalRawEvents: number;
  machineEventsFiltered: number;
  distinctActiveDays: number;
  sampleWindowDays: number;
  quietWindows: QuietWindow[];
  primaryQuietWindow: QuietWindow | null;
  confidence: number; // 0..1
  perProviderCounts: Record<string, number>;
  computedAt: string; // ISO
}

export interface GateDecision {
  eligible: boolean;
  // True when we fell back to the generic schedule (no/low-confidence profile),
  // i.e. the smart gate did NOT make the call.
  fallback: boolean;
  reason:
    | "disabled"
    | "no_profile"
    | "low_confidence"
    | "no_quiet_window"
    | "in_quiet_window"
    | "outside_quiet_window";
  confidence: number;
  localHour: number | null;
  timezone: string | null;
  window: QuietWindow | null;
}

/* ------------------------------- flag reader ------------------------------ */

export function getSmartBackfillTimingMode(
  env: NodeJS.ProcessEnv = process.env,
): SmartTimingMode {
  const raw = String(env.SMART_BACKFILL_TIMING ?? "").trim().toLowerCase();
  if (raw === "enforce" || raw === "on" || raw === "true") return "enforce";
  if (
    raw === "observe" ||
    raw === "observe-only" ||
    raw === "observe_only" ||
    raw === "log" ||
    raw === "dry-run" ||
    raw === "dryrun"
  ) {
    return "observe";
  }
  return "off";
}

export function getQuietWindowMinConfidence(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.SMART_BACKFILL_TIMING_MIN_CONFIDENCE);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return 0.5;
}

export function getMachineBurstThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.SMART_BACKFILL_TIMING_BURST_PER_MIN);
  if (Number.isFinite(raw) && raw >= 2) return Math.floor(raw);
  // A single shop emitting >= 20 webhook events in one wall-clock minute is our
  // own batch/sync replay, not human activity.
  return 20;
}

// Optional canary allowlist for ENFORCE mode. When SMART_BACKFILL_TIMING_SHOP_IDS
// is set to a comma/space-separated list of MOS shop ids, enforcement (the only
// mode that actually skips) is limited to *those* shops — every other shop runs
// on the generic schedule exactly as it does today. Returns null when unset/empty
// (= no allowlist = enforce applies fleet-wide). Has NO effect in off/observe.
export function getEnforceShopAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): Set<number> | null {
  const raw = String(env.SMART_BACKFILL_TIMING_SHOP_IDS ?? "").trim();
  if (!raw) return null;
  const ids = raw
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? new Set(ids) : null;
}

/* --------------------------- small math helpers --------------------------- */

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function sum(arr: number[]): number {
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function emptyHistogram(): number[] {
  return new Array(24).fill(0);
}

/* ------------------------------ tz utilities ------------------------------ */

// Local hour (0-23) for an instant in a given IANA timezone. Pure (Intl only).
export function localHourForTimezone(timezone: string, at: Date = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const part = fmt.formatToParts(at).find((p) => p.type === "hour");
    const h = parseInt(part?.value || "12", 10);
    return Number.isFinite(h) ? ((h % 24) + 24) % 24 : 12;
  } catch {
    return 12;
  }
}

// Whole-hour offset (local - UTC) for a timezone at a given instant. Negative
// for the Americas. Used to shift a UTC histogram into local time.
export function timezoneOffsetHours(timezone: string, at: Date = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const m: Record<string, string> = {};
    for (const p of fmt.formatToParts(at)) m[p.type] = p.value;
    let hour = parseInt(m.hour, 10);
    if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight
    const asUtc = Date.UTC(
      parseInt(m.year, 10),
      parseInt(m.month, 10) - 1,
      parseInt(m.day, 10),
      hour,
      parseInt(m.minute, 10),
      parseInt(m.second, 10),
    );
    return Math.round((asUtc - at.getTime()) / 3_600_000);
  } catch {
    return 0;
  }
}

// Shift a 24-slot UTC hour histogram into local time by a whole-hour offset.
export function shiftHistogramToLocal(
  utcHist: number[],
  offsetHours: number,
): number[] {
  const out = emptyHistogram();
  const off = ((Math.round(offsetHours) % 24) + 24) % 24;
  for (let h = 0; h < 24; h++) {
    out[(h + off) % 24] += utcHist[h] || 0;
  }
  return out;
}

/* --------------------------- machine-burst filter ------------------------- */

export interface BurstFilterResult {
  /** Organic per-minute-bucket counts that survived the filter, keyed nowhere —
   * caller already grouped; this returns kept vs dropped totals. */
  organicCount: number;
  filteredCount: number;
}

// Given per-minute-bucket counts for ONE shop, drop buckets whose count meets
// or exceeds the burst threshold (our own cron/sync replays cluster many
// near-identical events into a single minute). Returns kept/dropped totals.
export function filterMinuteBuckets(
  minuteCounts: number[],
  threshold: number,
): BurstFilterResult {
  let organic = 0;
  let filtered = 0;
  for (const c of minuteCounts) {
    if (c >= threshold) filtered += c;
    else organic += c;
  }
  return { organicCount: organic, filteredCount: filtered };
}

// Convenience for the test path / any caller holding raw timestamps: bucket by
// UTC minute, then apply the burst filter and return surviving timestamps.
export function filterMachineBursts(
  timestamps: Date[],
  threshold: number,
): { organic: Date[]; filteredCount: number } {
  const byMinute = new Map<number, Date[]>();
  for (const ts of timestamps) {
    const key = Math.floor(ts.getTime() / 60_000);
    const arr = byMinute.get(key);
    if (arr) arr.push(ts);
    else byMinute.set(key, [ts]);
  }
  const organic: Date[] = [];
  let filteredCount = 0;
  for (const arr of byMinute.values()) {
    if (arr.length >= threshold) filteredCount += arr.length;
    else organic.push(...arr);
  }
  return { organic, filteredCount };
}

/* ------------------------------ histograms -------------------------------- */

export function buildUtcHourHistogram(timestamps: Date[]): number[] {
  const hist = emptyHistogram();
  for (const ts of timestamps) hist[ts.getUTCHours()]++;
  return hist;
}

export function countDistinctUtcDays(timestamps: Date[]): number {
  const days = new Set<string>();
  for (const ts of timestamps) {
    days.add(
      `${ts.getUTCFullYear()}-${ts.getUTCMonth()}-${ts.getUTCDate()}`,
    );
  }
  return days.size;
}

/* --------------------------- quiet-window derivation ---------------------- */

function hoursInWindow(w: QuietWindow): number[] {
  const hours: number[] = [];
  if (w.startHour === 0 && w.endHour === 24) {
    for (let h = 0; h < 24; h++) hours.push(h);
    return hours;
  }
  let h = w.startHour % 24;
  // walk forward until we reach endHour (handles wrap)
  for (let guard = 0; guard < 24; guard++) {
    if (h === (w.endHour % 24)) break;
    hours.push(h);
    h = (h + 1) % 24;
  }
  return hours;
}

export function hourInWindow(hour: number, w: QuietWindow): boolean {
  const h = ((hour % 24) + 24) % 24;
  if (w.startHour === 0 && w.endHour === 24) return true;
  if (w.startHour < w.endHour) return h >= w.startHour && h < w.endHour;
  // wraps midnight
  return h >= w.startHour || h < w.endHour;
}

export interface DeriveOptions {
  quietFraction?: number; // a quiet hour has <= peak*quietFraction events
  minLength?: number; // minimum contiguous quiet hours to count as a window
}

// Derive quiet window(s) from a 24-slot LOCAL hour histogram.
export function deriveQuietWindows(
  localHist: number[],
  opts: DeriveOptions = {},
): { windows: QuietWindow[]; primary: QuietWindow | null } {
  const quietFraction = opts.quietFraction ?? 0.15;
  const minLength = opts.minLength ?? 3;
  const total = sum(localHist);
  if (total <= 0) return { windows: [], primary: null };

  const peak = Math.max(...localHist);
  const quietLevel = peak * quietFraction;
  const isQuiet = localHist.map((c) => c <= quietLevel);

  if (isQuiet.every(Boolean)) {
    const all: QuietWindow = { startHour: 0, endHour: 24 };
    return { windows: [all], primary: all };
  }

  // Anchor at a busy hour so contiguous quiet runs are linear (no wrap math
  // inside the loop).
  let anchor = 0;
  while (isQuiet[anchor]) anchor++;

  const seq: { idx: number; quiet: boolean }[] = [];
  for (let k = 0; k < 24; k++) {
    const idx = (anchor + k) % 24;
    seq.push({ idx, quiet: isQuiet[idx] });
  }

  const windows: { w: QuietWindow; length: number }[] = [];
  let runStart: number | null = null;
  const pushRun = (a: number, b: number) => {
    const length = b - a + 1;
    if (length < minLength) return;
    const startHour = seq[a].idx;
    const endHour = (seq[b].idx + 1) % 24;
    windows.push({ w: { startHour, endHour }, length });
  };
  for (let k = 0; k < seq.length; k++) {
    if (seq[k].quiet) {
      if (runStart === null) runStart = k;
    } else if (runStart !== null) {
      pushRun(runStart, k - 1);
      runStart = null;
    }
  }
  if (runStart !== null) pushRun(runStart, seq.length - 1);

  windows.sort((a, b) => b.length - a.length);
  return {
    windows: windows.map((x) => x.w),
    primary: windows.length ? windows[0].w : null,
  };
}

/* ------------------------------- confidence ------------------------------- */

export interface ConfidenceOptions {
  minEvents?: number; // below this → confidence 0 (too little data)
  fullEvents?: number; // events for full volume credit
  minActiveDays?: number; // below this → confidence capped
}

export function computeConfidence(input: {
  totalOrganicEvents: number;
  distinctActiveDays: number;
  localHist: number[];
  primaryQuietWindow: QuietWindow | null;
  options?: ConfidenceOptions;
}): number {
  const { totalOrganicEvents, distinctActiveDays, localHist, primaryQuietWindow } =
    input;
  const minEvents = input.options?.minEvents ?? 30;
  const fullEvents = input.options?.fullEvents ?? 150;
  const minActiveDays = input.options?.minActiveDays ?? 5;

  if (totalOrganicEvents < minEvents) return 0;
  if (!primaryQuietWindow) return 0;

  const volume = clamp01(totalOrganicEvents / fullEvents);

  const quietHours = new Set(hoursInWindow(primaryQuietWindow));
  let quietSum = 0;
  let quietN = 0;
  let busySum = 0;
  let busyN = 0;
  for (let h = 0; h < 24; h++) {
    if (quietHours.has(h)) {
      quietSum += localHist[h];
      quietN++;
    } else {
      busySum += localHist[h];
      busyN++;
    }
  }
  const quietMean = quietN ? quietSum / quietN : 0;
  const busyMean = busyN ? busySum / busyN : 0;
  const contrast = busyMean > 0 ? clamp01((busyMean - quietMean) / busyMean) : 0;

  let conf = volume * contrast;
  if (distinctActiveDays < minActiveDays) conf = Math.min(conf, 0.3);
  return round2(clamp01(conf));
}

/* --------------------------- activity-based tz ---------------------------- */

const US_ZONE_BY_STD_OFFSET: { tz: string; offset: number }[] = [
  { tz: "America/New_York", offset: -5 },
  { tz: "America/Chicago", offset: -6 },
  { tz: "America/Denver", offset: -7 },
  { tz: "America/Los_Angeles", offset: -8 },
];

// Estimate a US timezone purely from a UTC hour histogram: find the busiest
// contiguous 8-hour block (the working day), assume its center sits around
// 13:00 local, derive the UTC offset, and snap to the nearest US zone.
export function inferTimezoneFromUtcHistogram(
  utcHist: number[],
): { timezone: string; offset: number } | null {
  const total = sum(utcHist);
  if (total <= 0) return null;

  const windowLen = 8;
  let bestStart = 0;
  let bestSum = -1;
  for (let start = 0; start < 24; start++) {
    let s = 0;
    for (let k = 0; k < windowLen; k++) s += utcHist[(start + k) % 24];
    if (s > bestSum) {
      bestSum = s;
      bestStart = start;
    }
  }
  const centerUtc = (bestStart + Math.floor(windowLen / 2)) % 24;
  // assume business center ~13:00 local
  let offset = 13 - centerUtc;
  if (offset > 0) offset -= 24; // US offsets are negative
  if (offset < -12) offset += 24;

  let best = US_ZONE_BY_STD_OFFSET[0];
  let bestDiff = Infinity;
  for (const z of US_ZONE_BY_STD_OFFSET) {
    // account for possible DST (+1) in the observed offset
    const diff = Math.min(Math.abs(offset - z.offset), Math.abs(offset - (z.offset + 1)));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = z;
    }
  }
  return { timezone: best.tz, offset };
}

/* -------------------------------- the gate -------------------------------- */

export function decideQuietWindowGate(input: {
  profile: ActivityProfile | null | undefined;
  now?: Date;
  minConfidence: number;
}): GateDecision {
  const now = input.now ?? new Date();
  const { profile, minConfidence } = input;

  if (!profile) {
    return {
      eligible: true,
      fallback: true,
      reason: "no_profile",
      confidence: 0,
      localHour: null,
      timezone: null,
      window: null,
    };
  }

  const confidence = Number(profile.confidence) || 0;
  if (confidence < minConfidence) {
    return {
      eligible: true,
      fallback: true,
      reason: "low_confidence",
      confidence,
      localHour: null,
      timezone: profile.timezone,
      window: null,
    };
  }

  const window = profile.primaryQuietWindow;
  if (!window) {
    return {
      eligible: true,
      fallback: true,
      reason: "no_quiet_window",
      confidence,
      localHour: null,
      timezone: profile.timezone,
      window: null,
    };
  }

  const localHour = localHourForTimezone(profile.timezone, now);
  const inWindow = hourInWindow(localHour, window);
  return {
    eligible: inWindow,
    fallback: false,
    reason: inWindow ? "in_quiet_window" : "outside_quiet_window",
    confidence,
    localHour,
    timezone: profile.timezone,
    window,
  };
}

export function describeGateDecision(shopId: number, d: GateDecision): string {
  const w = d.window ? `${d.window.startHour}:00-${d.window.endHour}:00` : "n/a";
  return (
    `shop=${shopId} eligible=${d.eligible} reason=${d.reason} ` +
    `conf=${d.confidence} tz=${d.timezone ?? "?"} ` +
    `localHour=${d.localHour ?? "?"} quietWindow=${w} fallback=${d.fallback}`
  );
}
