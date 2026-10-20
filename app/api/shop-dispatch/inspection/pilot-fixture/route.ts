import { staffAccess } from "@/lib/auto-dvi/staff/access";
import { getSession } from "@/lib/auth";
import { dispatchJson, dispatchFailure } from "@/lib/shop-dispatch/http";
import { PILOT_SHOP, SYNTHETIC_CONTACT, SYNTHETIC_VEHICLE } from "@/lib/auto-dvi/pilot/model";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  if (!await getSession()) return dispatchJson({error: "Sign in to use shop workflow"}, 401);
  try {
    const access = await staffAccess();
    if (access.shopId !== PILOT_SHOP || !access.canEdit || !access.canReview || !access.config?.pilot?.admissions)
      return dispatchJson({enabled: false});
    return dispatchJson({enabled: true, details: {
      customer: "MOS SYNTHETIC DVI SAFETY TEST", vehicle: "Synthetic pilot vehicle",
      contactId: SYNTHETIC_CONTACT, vehicleId: SYNTHETIC_VEHICLE,
      newCustomer: null, newVehicle: null, identityConfirmed: false,
      concerns: ["Synthetic manual inspection"], mileage: null, customerPlan: "unknown",
      neededBy: null, promiseAt: null, nextUpdateAt: null, commitmentsConfirmed: false,
    }});
  } catch (error) { return dispatchFailure(error); }
}
