// Best-effort interpreter of the small subset of cron expressions used by
// `lib/cron/jobs.cjs`. Returns the *expected wall-clock interval between
// firings* (in ms) so the observability page can compute a staleness
// threshold (default = 2× interval) and decide whether to flag a job red.
//
// We intentionally avoid pulling in `cron-parser` for two reasons:
//   1. The job catalogue uses a handful of well-understood patterns
//      (`*/N * * * *`, `M * * * *`, `0 H * * *`, `5,20,35,50 * * * 6,0`),
//      not the full crontab grammar.
//   2. Day-of-week-restricted jobs ("weekend boost") are *expected* to be
//      silent during the week, so we surface that as a separate flag and
//      skip staleness instead of computing a misleading interval.

export interface ScheduleInfo {
  intervalMs: number | null;
  weekendOnly: boolean;
  description: string;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function parseListField(field: string): number[] | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    if (!Number.isFinite(step) || step <= 0) return null;
    return [step];
  }
  const parts = field.split(",").map((p) => Number(p.trim()));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts;
}

function gapsForList(values: number[], wrapAt: number): number[] {
  if (values.length <= 1) return [wrapAt];
  const sorted = [...values].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i] - sorted[i - 1]);
  }
  // wrap-around gap from last value back to first in next cycle
  gaps.push(wrapAt - sorted[sorted.length - 1] + sorted[0]);
  return gaps;
}

/**
 * Estimate the *worst-case* gap between firings for a node-cron expression.
 * We use the worst-case (max) gap so a job that fires at :05 then :50 is
 * treated as having a 55-minute interval, not 22.5 — that way the 2× stale
 * threshold doesn't false-page during the long arm of an irregular schedule.
 */
export function estimateScheduleInterval(schedule: string): ScheduleInfo {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { intervalMs: null, weekendOnly: false, description: schedule };
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  const weekendOnly =
    dayOfWeek !== "*" &&
    dayOfWeek
      .split(",")
      .every((d) => d.trim() === "0" || d.trim() === "6" || d.trim() === "7");

  // Day-of-month / month restrictions are rare in our catalogue and would
  // need real cron parsing to evaluate correctly. Bail out so the UI shows
  // "irregular" rather than a wrong number.
  if (dayOfMonth !== "*" || month !== "*") {
    return { intervalMs: null, weekendOnly, description: schedule };
  }

  const minuteParsed = parseListField(minute);
  const hourParsed = parseListField(hour);

  // Hourly cadence with `*/N` minute step: gap = N minutes (assuming hour=*)
  if (hour === "*" && minute.startsWith("*/")) {
    const step = Number(minute.slice(2));
    if (Number.isFinite(step) && step > 0) {
      return {
        intervalMs: step * MIN,
        weekendOnly,
        description: `every ${step} min`,
      };
    }
  }

  // Hourly cadence with explicit minute list (e.g. `0,15,30,45 * * * *`)
  if (hour === "*" && Array.isArray(minuteParsed)) {
    const gaps = gapsForList(minuteParsed, 60);
    const worst = Math.max(...gaps);
    return {
      intervalMs: worst * MIN,
      weekendOnly,
      description: `worst-case ${worst} min between firings`,
    };
  }

  // Daily cadence: minute fixed, hour fixed (or list of hours)
  if (Array.isArray(hourParsed) && Array.isArray(minuteParsed)) {
    if (hourParsed.length === 1 && minuteParsed.length === 1) {
      return {
        intervalMs: DAY,
        weekendOnly,
        description: "daily",
      };
    }
    const hourGaps = gapsForList(hourParsed, 24);
    const worstHourGap = Math.max(...hourGaps);
    return {
      intervalMs: worstHourGap * HOUR,
      weekendOnly,
      description: `worst-case ${worstHourGap}h between firings`,
    };
  }

  // Hour `*/N` step
  if (hour.startsWith("*/")) {
    const step = Number(hour.slice(2));
    if (Number.isFinite(step) && step > 0) {
      return {
        intervalMs: step * HOUR,
        weekendOnly,
        description: `every ${step}h`,
      };
    }
  }

  return { intervalMs: null, weekendOnly, description: schedule };
}
