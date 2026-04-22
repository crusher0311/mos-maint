/**
 * Compute interval-progress data for a single VHI/maintenance item.
 *
 * This is the canonical source of truth for the math behind:
 *   - components/ui/IntervalProgressRow.tsx (advisor view)
 *   - the partner-facing /api/external/vehicles/[vin]/vhi response
 *   - any future surface that needs "X mi over / Y mos left" labels
 *
 * Keep this in lock-step with IntervalProgressRow.tsx. If you change one,
 * change the other (or refactor the UI to import from here).
 */

export type ProgressStatus = "overdue" | "soon" | "ok";

export interface IntervalProgressAxis {
  /** miles or months consumed since last service (clamped >= 0). null when unknown. */
  used: number | null;
  /** total interval length in the same unit as `used`. null when interval not provided. */
  interval: number | null;
  /** 0..100 percent of the interval consumed (clamped 0..100). null when uncomputable. */
  percent: number | null;
  /** interval - used. Negative = overdue. null when uncomputable. */
  remaining: number | null;
  /** axis-level severity (null when no data on this axis). */
  status: ProgressStatus | null;
  /** short right-aligned label, e.g. "1,247 mi over", "5 mos left". */
  headline: string | null;
}

export interface IntervalProgress {
  miles: IntervalProgressAxis;
  time: IntervalProgressAxis;
  /** worst severity across the two axes; closer-to-due wins on tie. */
  status: ProgressStatus | null;
  /** preferred headline + status for compact UIs (e.g. extension overlay). */
  headline: { text: string; status: ProgressStatus } | null;
}

interface ProgressInput {
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  last?: { miles?: number | null; date?: Date | string | null } | null;
  dueAtMiles?: number | null;
  dueAtDate?: Date | string | null;
  milesToGo?: number | null;
  daysToGo?: number | null;
}

const EMPTY_AXIS: IntervalProgressAxis = {
  used: null,
  interval: null,
  percent: null,
  remaining: null,
  status: null,
  headline: null,
};

function fmtMiles(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Mirrors fmtTime() in IntervalProgressRow.tsx — keep in sync. */
function fmtTime(months: number): string {
  const abs = Math.abs(months);
  if (abs < 1) {
    const days = Math.round(abs * 30.4375);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (abs < 12) {
    const m = Math.round(abs);
    return `${m} ${m === 1 ? "mo" : "mos"}`;
  }
  const years = abs / 12;
  if (years < 2) return `${years.toFixed(1)} yr`;
  return `${Math.round(years)} yrs`;
}

function monthsBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24 * 30.4375);
}

function toDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? null : dt;
}

export function computeIntervalProgress(
  item: ProgressInput,
  currentMiles: number | null,
  today: Date = new Date()
): IntervalProgress {
  let miles: IntervalProgressAxis = { ...EMPTY_AXIS };
  let time: IntervalProgressAxis = { ...EMPTY_AXIS };

  // ---- mileage axis ----
  if (item.intervalMiles && item.intervalMiles > 0 && currentMiles != null) {
    const interval = item.intervalMiles;
    let usedRaw: number | null = null;

    // Treat last.miles === 0 as "unknown" — a stored anchor of 0 almost always
    // means the historical RO had no odometer captured. Without this guard we
    // would subtract 0 from the current odometer and report the entire current
    // mileage as "miles over" (e.g. "171,061 mi over" on an oil change).
    if (item.last?.miles != null && item.last.miles > 0) {
      usedRaw = currentMiles - item.last.miles;
    } else if (item.dueAtMiles != null) {
      usedRaw = currentMiles - (item.dueAtMiles - interval);
    }

    if (usedRaw != null) {
      const used = Math.max(0, usedRaw);
      const percent = Math.max(0, Math.min(100, (used / interval) * 100));
      const remaining =
        item.milesToGo != null
          ? item.milesToGo
          : item.dueAtMiles != null
            ? item.dueAtMiles - currentMiles
            : interval - usedRaw;

      let status: ProgressStatus;
      let headline: string;
      if (remaining < 0) {
        status = "overdue";
        headline = `${fmtMiles(-remaining)} mi over`;
      } else if (remaining <= interval * 0.1 || remaining <= 1000) {
        status = "soon";
        headline = `${fmtMiles(remaining)} mi left`;
      } else {
        status = "ok";
        headline = `${fmtMiles(remaining)} mi left`;
      }

      miles = { used, interval, percent, remaining, status, headline };
    }
  } else if (item.dueAtMiles != null && currentMiles != null) {
    // No interval known; still emit a directional label (mirrors UI fallback).
    const remaining = item.dueAtMiles - currentMiles;
    let status: ProgressStatus;
    let headline: string;
    if (remaining < 0) {
      status = "overdue";
      headline = `${fmtMiles(-remaining)} mi over`;
    } else if (remaining <= 1000) {
      status = "soon";
      headline = `${fmtMiles(remaining)} mi left`;
    } else {
      status = "ok";
      headline = `${fmtMiles(remaining)} mi left`;
    }
    miles = {
      used: null,
      interval: null,
      percent: remaining < 0 ? 100 : null,
      remaining,
      status,
      headline,
    };
  }

  // ---- time axis ----
  if (item.intervalMonths && item.intervalMonths > 0) {
    const interval = item.intervalMonths;
    let usedRaw: number | null = null;
    const lastDate = toDate(item.last?.date ?? null);
    const dueDate = toDate(item.dueAtDate ?? null);

    if (lastDate) {
      usedRaw = monthsBetween(lastDate, today);
    } else if (dueDate) {
      const anchor = new Date(dueDate);
      anchor.setMonth(anchor.getMonth() - interval);
      usedRaw = monthsBetween(anchor, today);
    }

    if (usedRaw != null) {
      const used = Math.max(0, usedRaw);
      const percent = Math.max(0, Math.min(100, (used / interval) * 100));
      const remaining = interval - usedRaw;

      let status: ProgressStatus;
      let headline: string;
      if (remaining < 0) {
        status = "overdue";
        headline = `${fmtTime(remaining)} over`;
      } else if (remaining <= Math.max(1, interval * 0.1)) {
        status = "soon";
        headline = `${fmtTime(remaining)} left`;
      } else {
        status = "ok";
        headline = `${fmtTime(remaining)} left`;
      }

      time = { used, interval, percent, remaining, status, headline };
    }
  } else if (item.dueAtDate) {
    // No interval known; still emit a directional label (mirrors UI fallback).
    const dueDate = toDate(item.dueAtDate);
    if (dueDate) {
      const remaining = monthsBetween(today, dueDate);
      let status: ProgressStatus;
      let headline: string;
      if (remaining < 0) {
        status = "overdue";
        headline = `${fmtTime(remaining)} over`;
      } else if (remaining <= 1) {
        status = "soon";
        headline = `${fmtTime(remaining)} left`;
      } else {
        status = "ok";
        headline = `${fmtTime(remaining)} left`;
      }
      time = {
        used: null,
        interval: null,
        percent: remaining < 0 ? 100 : null,
        remaining,
        status,
        headline,
      };
    }
  }

  // ---- combined headline + overall status ----
  const order: Record<ProgressStatus, number> = { overdue: 0, soon: 1, ok: 2 };
  const candidates: Array<{ axis: IntervalProgressAxis }> = [];
  if (miles.status) candidates.push({ axis: miles });
  if (time.status) candidates.push({ axis: time });

  let status: ProgressStatus | null = null;
  let headline: { text: string; status: ProgressStatus } | null = null;

  if (candidates.length) {
    candidates.sort((a, b) => {
      const sa = order[a.axis.status as ProgressStatus];
      const sb = order[b.axis.status as ProgressStatus];
      if (sa !== sb) return sa - sb;
      return (b.axis.percent ?? 0) - (a.axis.percent ?? 0);
    });
    const winner = candidates[0].axis;
    status = winner.status;
    if (winner.headline && winner.status) {
      headline = { text: winner.headline, status: winner.status };
    }
  }

  return { miles, time, status, headline };
}
