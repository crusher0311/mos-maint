import { reconcileStaleActualWithEstimate } from "@/lib/plan-build/open-ro-mileage";

export const PUBLIC_REPORT_FRESH_MS = 24 * 60 * 60 * 1000;
export const PUBLIC_REPORT_REFRESH_MS = 15 * 60 * 1000;
export const validCustomerMileage = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 100 && value < 1_000_000;

export interface CustomerMileageAnchor {
  mileage: number;
  recordedAt: Date | string;
  source: "customer_entered";
  distanceUnit: "miles" | "kilometers";
}

/** Cached data only. Never mutate the shared plan while projecting a public view. */
export function projectPublicReport(
  plan: any,
  createdAt: Date | string,
  anchor: CustomerMileageAnchor | null,
  estimateMiles: number | null,
  now = new Date(),
) {
  const unit = plan.distanceUnit === "kilometers" ? "kilometers" : "miles";
  const factor = unit === "kilometers" ? 1.609344 : 1;
  const customerWins = anchor?.distanceUnit === unit && anchor.mileage >= (plan.currentMiles || 0);
  const base = customerWins ? anchor!.mileage : (plan.currentMiles || 0);
  const date = customerWins ? anchor!.recordedAt : createdAt;
  // Daily, not per-refresh growth. A reading supplied today is an actual reading.
  const day = new Date(now.toISOString().slice(0, 10));
  const parsedDate = new Date(date);
  const baseDay = Number.isFinite(parsedDate.getTime()) ? new Date(parsedDate.toISOString().slice(0, 10)) : day;
  const reconciled = reconcileStaleActualWithEstimate({
    actualMiles: base / factor,
    actualSource: "vehicles_collection",
    // CARFAX estimates are always miles, unlike the shop-unit actual reading.
    estimateMiles: day > baseDay && estimateMiles ? estimateMiles : null,
    staleReadingDate: baseDay,
    now: day,
  });
  const currentMiles = Math.max(base, Math.round((reconciled.miles || 0) * factor));
  const buckets: Record<string, any[]> = { overdue: [], dueSoon: [], upcoming: [] };
  const soonMiles = plan.soonMiles ?? 1000 * factor;
  const soonDays = plan.soonDays ?? 30;
  for (const oldBucket of ["overdue", "dueSoon", "upcoming"]) {
    for (const original of plan.buckets?.[oldBucket] || []) {
      const item = { ...original };
      if (item.dueAtMiles != null) item.milesToGo = item.dueAtMiles - currentMiles;
      if (item.dueAtDate) item.daysToGo = Math.ceil((new Date(item.dueAtDate).getTime() - day.getTime()) / 86400000);
      const over = (item.milesToGo != null && item.milesToGo <= 0) || (item.daysToGo != null && item.daysToGo <= 0);
      const soon = (item.milesToGo != null && item.milesToGo <= soonMiles) || (item.daysToGo != null && item.daysToGo <= soonDays);
      const forcedOverdue = item.bump === "red" || item.declinedOrigin === "tekmetric" || item.declined?.origin === "tekmetric";
      // Preserve non-scheduled findings and recommendations in their original bucket.
      const unscheduled = item.dueAtMiles == null && !item.dueAtDate;
      const bucket = forcedOverdue || over ? "overdue"
        : item.bump === "yellow" || soon ? "dueSoon"
        : unscheduled ? oldBucket : "upcoming";
      buckets[bucket].push(item);
    }
  }
  return {
    ...plan, currentMiles, buckets,
    mileageEstimated: currentMiles > base || (!customerWins && plan.mileageSource?.startsWith("estimated")),
    mileageInputSource: customerWins ? "customer_entered" : (reconciled.mileageInputSource ?? plan.mileageInputSource),
    mileageSource: currentMiles > base ? (reconciled.estimateWon ? "estimated_carfax" : "estimated_annual")
      : customerWins ? "actual" : (plan.mileageSource ?? "actual"),
  };
}
