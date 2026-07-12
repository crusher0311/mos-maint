import React from "react";
import { computeIntervalProgress, getDominantAxis } from "@/lib/vhi-progress";

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

// Task #865: single dominant-axis gradient bar (calm AppFueled/public-VHR
// style). The math lives in lib/vhi-progress.ts — this component only picks
// the winning axis via getDominantAxis() and renders one green→amber→red
// gradient track with a small axis indicator and a right-aligned headline.
export function IntervalProgressRow({
  task,
  currentMiles,
  today = new Date(),
  distanceUnit = "miles",
  status,
}: Props) {
  const unitForLib = isMetric(distanceUnit) ? "kilometers" : "miles";
  const progress = computeIntervalProgress(
    {
      intervalMiles: task.intervalMiles,
      intervalMonths: task.intervalMonths,
      last: task.last,
      dueAtMiles: task.dueAtMiles,
      dueAtDate: task.dueAtDate,
      milesToGo: task.milesToGo,
    },
    currentMiles,
    today,
    unitForLib
  );
  const dominant = getDominantAxis(progress);
  if (!dominant) return null;

  const { axis, data } = dominant;
  const pct =
    data.percent != null
      ? Math.round(data.percent)
      : data.status === "overdue"
        ? 100
        : null;
  if (pct == null && !data.headline) return null;

  const axisLabel = axis === "miles" ? (isMetric(distanceUnit) ? "KM" : "MILES") : "TIME";

  const headlineClass =
    data.status === "overdue"
      ? "text-red-600 font-semibold"
      : data.status === "soon"
        ? "text-amber-600 font-semibold"
        : "text-neutral-500";

  return (
    <div className="mt-2.5 flex items-center gap-2 text-[11px]">
      <span className="shrink-0 w-11 text-[10px] font-semibold tracking-wide text-neutral-400">
        {axisLabel}
      </span>
      <div
        className="relative h-2 flex-1 rounded-full overflow-hidden bg-neutral-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? 0}
        aria-label={`${axis === "miles" ? "Mileage" : "Time"} interval used${data.headline ? `, ${data.headline}` : ""}`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${pct ?? 0}%`,
            background:
              "linear-gradient(90deg, #34d399 0%, #fbbf24 55%, #f87171 100%)",
            // Anchor the gradient to the full track width so a half-full bar
            // shows green→amber, not the whole green→red ramp squeezed in.
            backgroundSize: `${pct && pct > 0 ? Math.round(10000 / pct) : 100}% 100%`,
          }}
        />
      </div>
      {data.headline && (
        <span className={`shrink-0 tabular-nums ${headlineClass}`}>{data.headline}</span>
      )}
    </div>
  );
}
