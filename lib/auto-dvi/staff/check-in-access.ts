import { staffAccess } from "./access";
import { requireThat } from "@/lib/shop-dispatch/model";
export async function checkInAccess(){
  const a=await staffAccess();
  requireThat(a.canEdit,"DVI check-in is not enabled for this shop or user",403);
  return {shopId:a.shopId,actor:a.actor};
}
