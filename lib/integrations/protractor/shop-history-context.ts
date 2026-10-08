import {AsyncLocalStorage} from "node:async_hooks";
import {createHash} from "node:crypto";
import {validateHistoryGrant,historyEndpoint,matchesHistoryRequest,type ShopHistoryGrant,type ShopHistoryRequest} from "../../protractor-shop-history-policy";
interface Context {request:Readonly<ShopHistoryRequest>; bindingDigest:string; expiresAtMs:number; readonly active:boolean}
const storage=new AsyncLocalStorage<Context>();
export const getShopHistoryContext=()=>storage.getStore();
export const historyBindingDigest=(shopId:number,connectionId:string)=>createHash("sha256").update(`${shopId}|${connectionId.toLowerCase()}`).digest("hex");
export function historyContextError(shopId:number,connectionId?:string):string|null {
  const c=storage.getStore();if(!c)return null;
  if(!c.active || Date.now()>=c.expiresAtMs)return "Shop history context expired";
  if(c.request.shopId!==shopId)return "Shop history shop mismatch";
  if(connectionId!==undefined && historyBindingDigest(shopId,connectionId)!==c.bindingDigest)return "Shop history connection changed";
  return null;
}
export function historyDispatchError(endpoint:string,method:string,shopId:number,body?:unknown):string|null {
  const c=storage.getStore();if(!c)return null;
  return historyContextError(shopId) ?? (matchesHistoryRequest(c.request,endpoint,method,shopId,body)?null:"Shop history request outside approved scope");
}
export async function runWithShopHistory<T>(g:ShopHistoryGrant,r:ShopHistoryRequest,work:()=>Promise<T>):Promise<T> {
  validateHistoryGrant(g);historyEndpoint(r,0);const now=Date.now();
  if(g.stopped || r.runId!==g.runId || g.consumedRequests>=g.maxRequests ||
    now<g.notBefore.getTime() || now>=g.expiresAt.getTime())throw Error("Shop history permission unavailable");
  let active=true;
  const context=Object.freeze({request:Object.freeze({...r}),bindingDigest:g.bindingDigest,
    expiresAtMs:Math.min(g.expiresAt.getTime(),now+60000),get active(){return active;}});
  try{return await storage.run(context,work);}finally{active=false;}
}
