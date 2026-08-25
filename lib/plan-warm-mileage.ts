export type PlanWarmMileageEstimator = (
  shopId: number,
  vin: string,
) => Promise<{
  estimated: boolean;
  mileage: number | null;
  reason?: string;
  [key: string]: unknown;
}>;

export type PlanWarmMileageResolution = {
  mileage: number;
  mileageSource: "actual" | "estimated_carfax";
  mileageEstimateDetails: Record<string, unknown> | null;
};

/**
 * Resolves the mileage hint for a plan pre-warm without initiating any
 * upstream lookup. The caller supplies the cache-only CARFAX estimator.
 */
export async function resolvePlanWarmMileage(
  shopId: number,
  vin: string,
  repairOrderMileage: number | null,
  estimateMileage: PlanWarmMileageEstimator,
): Promise<PlanWarmMileageResolution | null> {
  if (
    typeof repairOrderMileage === "number" &&
    Number.isFinite(repairOrderMileage) &&
    repairOrderMileage > 0
  ) {
    return {
      mileage: repairOrderMileage,
      mileageSource: "actual",
      mileageEstimateDetails: null,
    };
  }

  const estimate = await estimateMileage(shopId, vin);
  if (
    !estimate.estimated ||
    typeof estimate.mileage !== "number" ||
    !Number.isFinite(estimate.mileage) ||
    estimate.mileage <= 0
  ) {
    return null;
  }

  const {
    estimated: _estimated,
    mileage: _mileage,
    reason: _reason,
    ...estimateDetails
  } = estimate;
  return {
    mileage: estimate.mileage,
    mileageSource: "estimated_carfax",
    mileageEstimateDetails:
      Object.keys(estimateDetails).length > 0 ? estimateDetails : null,
  };
}