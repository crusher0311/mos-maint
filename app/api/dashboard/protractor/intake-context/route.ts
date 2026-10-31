import {ZodError} from "zod";
import {checkInAccess} from "@/lib/auto-dvi/staff/check-in-access";
import {createIntakeContextReader, intakeContextSchema} from "@/lib/auto-dvi/staff/intake-context";
import {getFeatureEntitlements} from "@/lib/featureResolver";
import {getDb} from "@/lib/data/db";
import {getCachedPlan} from "@/lib/plan-cache";
import {dispatchFailure, dispatchJson, requestBody} from "@/lib/shop-dispatch/http";
import {requireThat} from "@/lib/shop-dispatch/model";
import {IntakePreparation} from "@/lib/auto-dvi/staff/intake-preparation";
import {staffAccess} from "@/lib/auto-dvi/staff/access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const readContext = createIntakeContextReader();
export async function POST(req: Request) {
  try {
    const access = await checkInAccess();
    const entitlements = await getFeatureEntitlements(access.shopId);
    requireThat(entitlements.isFeatureEnabled("auto_dvi") && entitlements.isFeatureEnabled("maintenance"),
      "DVI maintenance context is not enabled", 403);
    const input = intakeContextSchema.parse(await requestBody(req, 1024));
    // Cache-first, with optional gated preparation; never paid CARFAX or an
    // inspection mutation. Ordinary non-DVI check-in does not enter this path.
    let result = await readContext(async () => getCachedPlan(await getDb(), input.vin, access.shopId, input.mileage,
      input.distanceUnit, {limit: 8, maxTimeMS: 2000}));
    if (result.status === "missing") {
      const staff = await staffAccess();
      if (staff.shopId === access.shopId && staff.actor === access.actor &&
        staff.config?.recording?.enabledShopIds.includes(staff.shopId)) {
        result = await new IntakePreparation().request(staff.shopId, staff.actor, staff.email, input);
      }
    }
    const latest = await checkInAccess();
    const fresh = await getFeatureEntitlements(access.shopId);
    requireThat(latest.shopId === access.shopId && latest.actor === access.actor &&
      fresh.isFeatureEnabled("auto_dvi") && fresh.isFeatureEnabled("maintenance"), "Context access changed", 403);
    return dispatchJson(result);
  } catch (error) {
    return error instanceof ZodError ? dispatchJson({error: "Confirmed VIN, mileage and units required"}, 400) : dispatchFailure(error);
  }
}
