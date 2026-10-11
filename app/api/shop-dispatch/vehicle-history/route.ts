import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { readDispatchBoard } from "@/lib/data/repositories/shop-dispatch";
import { findCachedWorkOrderByProviderIdentity } from "@/lib/data/repositories/protractor-work-orders";
import { readVehicleHistoryLocation } from "@/lib/data/repositories/vehicle-history";
import { readEnterpriseVehicleHistory } from "@/lib/vehicle-history/service";
import { dispatchSession,dispatchJson,dispatchFailure } from "@/lib/shop-dispatch/http";
import { requireThat,DispatchError } from "@/lib/shop-dispatch/model";
import { readWorkflowHistory } from "@/lib/shop-dispatch/vehicle-history";
export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function GET(req:Request){
  try{
    const result=await readWorkflowHistory(new URL(req.url).searchParams.get("visitId")??"",{
      authorize:async()=>{
        const session=await dispatchSession(await getSession());
        const entitlement=await getFeatureEntitlements(session.shopId,{throwIfMissing:true});
        requireThat(entitlement.effectiveFeatures.maintenance,"Vehicle history is not enabled for this location.",403);
        return {shopId:session.shopId,email:session.email};
      },
      board:readDispatchBoard,
      cachedOrder:(shopId,id)=>findCachedWorkOrderByProviderIdentity(shopId,id,true),
      local:readVehicleHistoryLocation,
      shared:(shopId,email,vin)=>readEnterpriseVehicleHistory({currentShopId:shopId,email,channel:"dashboard",verified:true},vin),
    });
    return dispatchJson(result);
  }catch(error){
    return error instanceof DispatchError?dispatchFailure(error):
      dispatchJson({error:"Vehicle history could not be loaded. Coverage is unknown; no workflow data was changed."},503);
  }
}
