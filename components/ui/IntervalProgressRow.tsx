import React from "react";

type DistanceUnit = "miles" | "kilometers" | "km";

type Status = "overdue" | "soon" | "upcoming" | "deferred";

interface TaskShape {
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  last?: { miles?: number | null; date?: Date | null } | null;
  dueAtMiles?: number | null;
  dueAtDate?: Date | null;
  milesToGo?: number | null;
}

interface Props {
  task: TaskShape;
  currentMiles: number | null;
  today?: Date;
  distanceUnit?: DistanceUnit;
  status: Status;
}

function isMetric(unit: DistanceUnit): boolean {
  return unit === "kilometers" || unit === "km";
}

function fmtDist(m: number | null | undefined, unit: DistanceUnit): string {
  if (m == null || !isFinite(m)) return "—";
  const v = isMetric(unit) ? m * 1.60934 : m;
  return Math.round(v).toLocaleString();
}

function distLabel(unit: DistanceUnit): string {
  return isMetric(unit) ? "km" : "mi";
}

function monthsBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return ms / (1000 * 60 * 60 * 24 * 30.4375);
}

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

function colorClasses(status: Status, axis: "mileage" | "time") {
  // axis-specific: a single overdue axis still goes red even on a "soon" overall row
  if (axis === "mileage" || axis === "time") {
    if (status === "overdue") return "bg-red-500";
    if (status === "soon") return "bg-amber-500";
    if (status === "deferred") return "bg-blue-500";
    return "bg-emerald-500";
  }
  return "bg-neutral-300";
}

function trackClass(): string {
  return "bg-neutral-200";
}

export function IntervalProgressRow({
  task,
  currentMiles,
  today = new Date(),
  distanceUnit = "miles",
  status,
}: Props) {
  const unit = distanceUnit;
  const lbl = distLabel(unit);

  // ---- Mileage axis ----
  let milesPct: number | null = null;
  let milesHeadline: { text: string; tone: "overdue" | "soon" | "ok" } | null = null;

  if (task.intervalMiles && task.intervalMiles > 0 && currentMiles != null) {
    let usedMiles: number | null = null;
    // Treat last.miles<=0 as unknown (matches lib/vhi-progress.ts). A stored
    // anchor of 0 almost always means the historical RO had no odometer.
    if (task.last?.miles != null && task.last.miles > 0) {
      usedMiles = currentMiles - task.last.miles;
    } else if (task.dueAtMiles != null) {
      // Reconstruct anchor from dueAt - interval
      usedMiles = currentMiles - (task.dueAtMiles - task.intervalMiles);
    }
    if (usedMiles != null) {
      const safeUsed = Math.max(0, usedMiles);
      milesPct = Math.max(0, Math.min(1, safeUsed / task.intervalMiles));
      const remaining =
        task.milesToGo != null
          ? task.milesToGo
          : task.dueAtMiles != null
          ? task.dueAtMiles - currentMiles
          : task.intervalMiles - usedMiles;

      if (remaining < 0) {
        milesHeadline = { text: `${fmtDist(Math.abs(remaining), unit)} ${lbl} over`, tone: "overdue" };
      } else if (remaining <= task.intervalMiles * 0.1 || remaining <= 1000) {
        milesHeadline = { text: `${fmtDist(remaining, unit)} ${lbl} left`, tone: "soon" };
      } else {
        milesHeadline = { text: `${fmtDist(remaining, unit)} ${lbl} left`, tone: "ok" };
      }
    }
  } else if (task.dueAtMiles != null && currentMiles != null) {
    // No interval known; still show a directional label
    const remaining = task.dueAtMiles - currentMiles;
    milesHeadline =
      remaining < 0
        ? { text: `${fmtDist(Math.abs(remaining), unit)} ${lbl} over`, tone: "overdue" }
        : { text: `${fmtDist(remaining, unit)} ${lbl} left`, tone: remaining <= 1000 ? "soon" : "ok" };
    milesPct = remaining < 0 ? 1 : null;
  }

  // ---- Time axis ----
  let timePct: number | null = null;
  let timeHeadline: { text: string; tone: "overdue" | "soon" | "ok" } | null = null;

  if (task.intervalMonths && task.intervalMonths > 0) {
    let usedMonths: number | null = null;
    if (task.last?.date) {
      usedMonths = monthsBetween(task.last.date, today);
    } else if (task.dueAtDate) {
      // anchor = dueAt - interval
      const anchor = new Date(task.dueAtDate);
      anchor.setMonth(anchor.getMonth() - task.intervalMonths);
      usedMonths = monthsBetween(anchor, today);
    }
    if (usedMonths != null) {
      const safeUsed = Math.max(0, usedMonths);
      timePct = Math.max(0, Math.min(1, safeUsed / task.intervalMonths));
      const remaining = task.intervalMonths - usedMonths;
      if (remaining < 0) {
        timeHeadline = { text: `${fmtTime(remaining)} over`, tone: "overdue" };
      } else if (remaining <= Math.max(1, task.intervalMonths * 0.1)) {
        timeHeadline = { text: `${fmtTime(remaining)} left`, tone: "soon" };
      } else {
        timeHeadline = { text: `${fmtTime(remaining)} left`, tone: "ok" };
      }
    }
  } else if (task.dueAtDate) {
    const remaining = monthsBetween(today, task.dueAtDate);
    timeHeadline =
      remaining < 0
        ? { text: `${fmtTime(remaining)} over`, tone: "overdue" }
        : { text: `${fmtTime(remaining)} left`, tone: remaining <= 1 ? "soon" : "ok" };
    timePct = remaining < 0 ? 1 : null;
  }

  // Nothing to show? bail quietly.
  if (milesPct == null && timePct == null && !milesHeadline && !timeHeadline) return null;

  // Pick the headline (whichever axis is closer to / past due wins)
  const headline = pickHeadline(milesHeadline, timeHeadline);

  // Per-axis bar color: an overdue axis is always red even if overall status is "soon"
  const milesBarColor =
    milesHeadline?.tone === "overdue"
      ? "bg-red-500"
      : milesHeadline?.tone === "soon"
      ? "bg-amber-500"
      : colorClasses(status, "mileage");

  const timeBarColor =
    timeHeadline?.tone === "overdue"
      ? "bg-red-500"
      : timeHeadline?.tone === "soon"
      ? "bg-amber-500"
      : colorClasses(status, "time");

  const headlineClass =
    headline.tone === "overdue"
      ? "text-red-700 font-semibold"
      : headline.tone === "soon"
      ? "text-amber-700 font-semibold"
      : "text-emerald-700 font-medium";

  return (
    <div className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 items-center text-[12px]">
      {milesPct != null || milesHeadline ? (
        <>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-neutral-500">Miles</span>
            <div
              className={`relative h-2 flex-1 rounded-full overflow-hidden ${trackClass()}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((milesPct ?? 0) * 100)}
              aria-label={`Mileage interval used${milesHeadline ? `, ${milesHeadline.text}` : ""}`}
            >
              <div
                className={`absolute inset-y-0 left-0 ${milesBarColor}`}
                style={{ width: `${Math.round((milesPct ?? 0) * 100)}%` }}
              />
            </div>
          </div>
          <div className={`text-right tabular-nums ${milesHeadline?.tone === "overdue" ? "text-red-700 font-semibold" : milesHeadline?.tone === "soon" ? "text-amber-700 font-semibold" : "text-neutral-600"}`}>
            {milesHeadline?.text ?? ""}
          </div>
        </>
      ) : null}

      {timePct != null || timeHeadline ? (
        <>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-neutral-500">Time</span>
            <div
              className={`relative h-2 flex-1 rounded-full overflow-hidden ${trackClass()}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((timePct ?? 0) * 100)}
              aria-label={`Time interval used${timeHeadline ? `, ${timeHeadline.text}` : ""}`}
            >
              <div
                className={`absolute inset-y-0 left-0 ${timeBarColor}`}
                style={{ width: `${Math.round((timePct ?? 0) * 100)}%` }}
              />
            </div>
          </div>
          <div className={`text-right tabular-nums ${timeHeadline?.tone === "overdue" ? "text-red-700 font-semibold" : timeHeadline?.tone === "soon" ? "text-amber-700 font-semibold" : "text-neutral-600"}`}>
            {timeHeadline?.text ?? ""}
          </div>
        </>
      ) : null}

      {/* Anchor line: when last service was, in tiny grey */}
      {(task.last?.miles != null || task.last?.date) && (
        <div className="col-span-2 text-[11px] text-neutral-500">
          Since last service
          {task.last?.miles != null ? `: ${fmtDist(task.last.miles, unit)} ${lbl}` : ""}
          {task.last?.date ? ` on ${task.last.date.toLocaleDateString()}` : ""}
        </div>
      )}
    </div>
  );

  function pickHeadline(
    a: typeof milesHeadline,
    b: typeof timeHeadline
  ): { text: string; tone: "overdue" | "soon" | "ok" } {
    const order = { overdue: 0, soon: 1, ok: 2 } as const;
    if (!a) return b!;
    if (!b) return a;
    if (order[a.tone] !== order[b.tone]) return order[a.tone] < order[b.tone] ? a : b;
    // Same tone — prefer whichever axis is closer to (or further past) due,
    // i.e. higher percent-used on its bar.
    const aPct = milesPct ?? 0;
    const bPct = timePct ?? 0;
    return aPct >= bPct ? a : b;
  }
}
