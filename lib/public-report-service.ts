import { createHash } from "node:crypto";
import { readPublicMileageAnchor, findPublicReportShop, findPublicMileageState, claimPublicMileageRefresh, completePublicMileageRefresh, findPendingPublicMileageRefresh, deferPublicMileageRefresh, writePublicCustomerMileage } from "@/lib/data/repositories/public-report-state";
import { verifyShareToken } from "@/lib/report-share";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { rateLimit } from "@/lib/rate";
import { triggerPlanBuild } from "@/lib/vhi-rebuild";
import { estimateMileageFromCarfax } from "@/lib/integrations/carfax";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { PUBLIC_REPORT_FRESH_MS, PUBLIC_REPORT_REFRESH_MS, projectPublicReport, type CustomerMileageAnchor } from "./public-report-mileage";
import { publicVehicleKey } from "./customer-mileage-store";
import { findLatestCachedPlanDoc } from "@/lib/data/repositories/plan-cache-store";
import { resolveShopDistanceUnit } from "@/lib/shop-distance-unit";

export const publicReportDeps = { rateLimit, triggerPlanBuild, estimateMileageFromCarfax };

export async function authorizePublicReport(vin: string, token: string | null) {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) || !token || token.length > 2048) return null;
  const scope = verifyShareToken(token);
  if (!scope || scope.vin !== vin || !Number.isSafeInteger(Number(scope.shopId)) || Number(scope.shopId) <= 0) return null;
  const entitlements = await getFeatureEntitlements(Number(scope.shopId));
  return entitlements.canUseFeature("maintenance") ? { shopId: Number(scope.shopId), entitlements } : null;
}

export async function overlayPublicReport(db: any, shopId: number, vin: string, cached: any, unit: string) {
  const [anchor, estimate] = await Promise.all([
    readPublicMileageAnchor(shopId, vin, db),
    withUpstreamTimeout(publicReportDeps.estimateMileageFromCarfax(shopId, vin), 1500, "public report cached estimate", null),
  ]);
  return projectPublicReport(
    { ...cached.plan, currentMiles: cached.plan.currentMiles ?? cached.mileage, distanceUnit: unit },
    cached.createdAt || new Date(), anchor,
    estimate?.estimated ? estimate.mileage : null,
  );
}

/** Atomic per-vehicle cooldown also acts as a cross-instance build lease.
 * Never clear early: aborted HTTP requests may still be finishing on the server.
 */
export async function refreshPublicReport(db: any, shopId: number, vin: string, cached: any, projected: any, force = false) {
  const state = await findPublicMileageState(shopId, vin, db);
  const revision = state?.pendingMileageRevision;
  if (!force && !revision && cached?.createdAt && Date.now() - new Date(cached.createdAt).getTime() < PUBLIC_REPORT_FRESH_MS) return false;
  if (revision && state.customerMileage?.mileage > (projected.currentMiles || 0)) {
    projected = { currentMiles: state.customerMileage.mileage, mileageEstimated: false };
  }
  if (!(projected.currentMiles > 0)) return false;
  const now = new Date();
  try {
    const claim = await claimPublicMileageRefresh(shopId, vin, now, new Date(now.getTime() + PUBLIC_REPORT_REFRESH_MS), db);
    if (!claim.modifiedCount && !claim.upsertedCount) return false;
  } catch (err: any) {
    if (err?.code === 11000) return false;
    throw err;
  }
  const result = await publicReportDeps.triggerPlanBuild(shopId, vin, projected.currentMiles, false, true, {
    mileageSource: projected.mileageEstimated ? (projected.mileageSource === "estimated_carfax" ? "estimated_carfax" : "estimated_annual") : "actual",
    mileageEstimateDetails: projected.mileageEstimated ? { method: "public_report_daily_projection" } : null,
  }, true, 20_000, !!revision);
  if (!result.ok) console.warn("[Public report] Cache-only refresh failed", { shopId, status: result.status });
  if (result.ok && revision) {
    const builtPlan = (result.plan ?? (await findLatestCachedPlanDoc(shopId, vin, db))?.plan) as { currentMiles?: number } | undefined;
    if (builtPlan?.currentMiles != null && builtPlan.currentMiles >= state.customerMileage.mileage) {
      // A later submission must survive completion of this earlier build.
      await completePublicMileageRefresh(shopId, vin, revision, db);
    }
  }
  return result.ok;
}

/** Durable queue drain: one bounded build per tick, with the same fleet lease.
 * A process restart or a fresh cache from an older build cannot discard the request.
 */
export async function drainPublicMileageRefresh() {
  const state = await findPendingPublicMileageRefresh();
  if (!state?.customerMileage) return false;
  const entitlements = await getFeatureEntitlements(state.shopId);
  const shop = await findPublicReportShop(state.shopId);
  if (!entitlements.canUseFeature("maintenance") || !shop) {
    await deferPublicMileageRefresh(state, new Date(Date.now() + PUBLIC_REPORT_FRESH_MS));
    return false;
  }
  const cached = await findLatestCachedPlanDoc(state.shopId, state.vin);
  const projected = cached?.plan
    ? await overlayPublicReport(undefined, state.shopId, state.vin, cached, resolveShopDistanceUnit(shop as any))
    : { currentMiles: state.customerMileage.mileage, mileageEstimated: false };
  return refreshPublicReport(undefined, state.shopId, state.vin, cached, projected, true);
}

export async function allowPublicMileage(shopId: number, vin: string, ip: string) {
  const ipHash = createHash("sha256").update(ip).digest("hex");
  const results = await Promise.all([
    publicReportDeps.rateLimit({ id: `public-mileage:vehicle:${publicVehicleKey(shopId, vin)}`, limit: 5, windowSeconds: 3600 }),
    publicReportDeps.rateLimit({ id: `public-mileage:ip:${ipHash}`, limit: 20, windowSeconds: 3600 }),
  ]);
  return results.every(r => r.allowed);
}

/** Compare-and-set: concurrent public submissions can only move the anchor forward. */
export async function saveCustomerMileage(db: any, shopId: number, vin: string, anchor: CustomerMileageAnchor) {
  try {
    const result = await writePublicCustomerMileage(shopId, vin, anchor, db);
    return !!(result.matchedCount || result.upsertedCount);
  } catch (err: any) {
    if (err?.code === 11000) return false;
    throw err;
  }
}
