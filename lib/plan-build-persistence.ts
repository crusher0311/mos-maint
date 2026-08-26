import type { Db } from "mongodb";
import {
  setCachedPlan,
  type CachedPlanData,
} from "@/lib/plan-cache";

type PlanWriter = (
  db: Db,
  vin: string,
  shopId: number,
  mileage: number | null,
  plan: CachedPlanData,
) => Promise<void>;

/**
 * Single cache-write gate for plan-build results.
 *
 * Latency-first partner builds return their inline result but must not replace
 * the shared full-quality cache. Keeping this decision in one helper gives the
 * route a behavioral test seam without exporting non-handler values from a
 * Next route module.
 */
export async function persistPlanBuildResult(
  input: {
    db: Db;
    vin: string;
    shopId: number;
    mileage: number | null;
    plan: CachedPlanData;
    persist: boolean;
  },
  writePlan: PlanWriter = setCachedPlan,
): Promise<{ persisted: boolean; message: string }> {
  if (input.persist) {
    await writePlan(
      input.db,
      input.vin,
      input.shopId,
      input.mileage,
      input.plan,
    );
  }

  return {
    persisted: input.persist,
    message: input.persist
      ? "Plan built and cached"
      : "Plan built without caching",
  };
}