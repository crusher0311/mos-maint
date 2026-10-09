import { getSession } from "@/lib/auth";
import { readDispatchBoard } from "@/lib/data/repositories/shop-dispatch";
import { dispatchFailure,dispatchJson,dispatchSession } from "@/lib/shop-dispatch/http";
import { actorFor,requireThat } from "@/lib/shop-dispatch/model";
import { loadDispatchRoster } from "@/lib/shop-dispatch/roster";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET(){
  try{
    const session=await dispatchSession(await getSession());
    const board=await readDispatchBoard(session.shopId);
    requireThat(actorFor(board,session.email,session.role).manager,"Only managers may review provider staff",403);
    return dispatchJson(await loadDispatchRoster(session.shopId));
  }catch(error){return dispatchFailure(error);}
}
