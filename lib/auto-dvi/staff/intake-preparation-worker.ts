import {IntakePreparation} from "./intake-preparation";
import {staffMemberAccess} from "./access";
import {getFeatureEntitlements} from "../../featureResolver";
import {findShopByShopId, type ShopDoc} from "../../data/repositories/shops";
import {resolveShopDistanceUnit, type ShopDistanceDoc} from "../../shop-distance-unit";
import {triggerPlanBuild} from "../../vhi-rebuild";
import {requireThat} from "../../shop-dispatch/model";
import type {CachedPlan} from "../../plan-cache";

export async function prepareOneIntakeContext(shopId: number) {
  const entitlements = await getFeatureEntitlements(shopId);
  if (!entitlements.isFeatureEnabled("auto_dvi") || !entitlements.isFeatureEnabled("shop_workflow") ||
    !entitlements.isFeatureEnabled("maintenance")) return false;
  return new IntakePreparation().processOne(shopId, async (input, actor, email) => {
    const authorize = async () => {
      const access = await staffMemberAccess(shopId, email);
      requireThat(access.actor === actor && access.canEdit && access.config?.recording?.enabledShopIds.includes(shopId) &&
        (await getFeatureEntitlements(shopId)).isFeatureEnabled("maintenance"), "Preparation is unavailable", 403);
      requireThat(resolveShopDistanceUnit(await findShopByShopId<ShopDoc & ShopDistanceDoc>(shopId)) === input.distanceUnit, "Distance units changed", 409);
    };
    await authorize();
    // Existing internal plan path: no paid CARFAX and no shared-cache overwrite.
    // A strict request deadline bounds the worker wait; upstream cancellation
    // remains a rollout-verification item, not an assumption.
    const result = await triggerPlanBuild(shopId, input.vin, input.mileage, true, true, undefined, false, 20_000);
    await authorize();
    if (!result.ok || !result.plan) return null;
    return {plan: result.plan} as CachedPlan;
  });
}
