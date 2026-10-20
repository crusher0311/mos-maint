import { checkInAccess } from "./check-in-access";
import { CheckInDrafts,draftFenceSchema,nativeDraftBody } from "@/lib/data/repositories/check-in-drafts";
import { requireThat } from "@/lib/shop-dispatch/model";
import { createHash } from "node:crypto";
import { z } from "zod";
import { findShopByShopId,type ShopDoc } from "@/lib/data/repositories/shops";
const drafts=new CheckInDrafts();
/** Legacy requests cannot race an active shared draft from another device. */
export async function prepareCheckInNative(body:any,shopId:number,email:string,kind:"contact"|"vehicle"|"ro"){
  const scope={shopId,actor:createHash("sha256").update(`staff|${shopId}|${email.toLowerCase()}`).digest("hex")};
  if(!body._guidedDraft){
    if(kind==="ro"&&body.recoveryOnly===true)return null;
    // Exact key only; never query providers or widen the legacy request's scope.
    requireThat(!await drafts.read(scope),"Resume the shared check-in before creating records",409);
    return null;
  }
  const authorized=await checkInAccess();
  requireThat(authorized.shopId===scope.shopId&&authorized.actor===scope.actor,"Check-in account changed",403);
  z.string().uuid().parse(body.clientRequestId);
  const fence=draftFenceSchema.parse(body._guidedDraft),payload=nativeDraftBody(body);
  const row=await drafts.fence(scope,fence);
  const capture=JSON.parse(row.session.draft?.fields??"{}").odometerCapture;
  if(kind!=="contact"&&capture?.confirmed){
    const shop=await findShopByShopId<ShopDoc & {preferences?:{distanceUnit?:string}}>(shopId,{"preferences.distanceUnit":1});
    const unit=shop?.preferences?.distanceUnit==="kilometers"?"kilometers":"miles";
    requireThat(capture.confirmed.unit===unit,"Shop distance units changed. Reconfirm the odometer before creating a record.",409);
  }
  const admission=await drafts.reserve(scope,fence,kind,payload);
  return {...admission,confirm:(result:any)=>drafts.confirm(scope,fence.id,kind,payload,result)};
}
