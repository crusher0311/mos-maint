/** One-store, operator-approved import. Never interactive or JWT authority. */
export const HISTORY_SHOP = 538;
export const HISTORY_FROM = "2025-08-08";
export const HISTORY_UNTIL = "2026-10-09"; // exclusive; includes October 8
export const HISTORY_START = "2026-10-08T23:00:00.000Z"; // explicit closed-shop approval
export const HISTORY_END = "2026-10-09T10:00:00.000Z";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export interface ShopHistoryRequest { runId:string; shopId:number; day:string }
export interface ShopHistoryGrant {
  version:1; runId:string; shopId:number; from:string; until:string;
  canaryGeneration:string; bindingDigest:string;
  notBefore:Date; expiresAt:Date; maxRequests:number; consumedRequests:number;
  stopped:boolean;
}
function validDay(day:string):boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day>=HISTORY_FROM && day<HISTORY_UNTIL &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)===day;
}
export function validateHistoryGrant(g:ShopHistoryGrant):void {
  if(!g || g.version!==1 || g.shopId!==HISTORY_SHOP || !uuid.test(g.runId) ||
    !uuid.test(g.canaryGeneration) || !/^[a-f0-9]{64}$/.test(g.bindingDigest) ||
    g.from!==HISTORY_FROM || g.until!==HISTORY_UNTIL ||
    !(g.notBefore instanceof Date) || g.notBefore.toISOString()!==HISTORY_START ||
    !(g.expiresAt instanceof Date) || g.expiresAt.toISOString()!==HISTORY_END ||
    !Number.isSafeInteger(g.maxRequests) || g.maxRequests<1 || g.maxRequests>1000 ||
    !Number.isSafeInteger(g.consumedRequests) || g.consumedRequests<0 ||
    g.consumedRequests>g.maxRequests || typeof g.stopped!=="boolean")
    throw Error("Invalid shop history permission");
}
export function historyEndpoint(r:ShopHistoryRequest,page:number):string {
  if(r.shopId!==HISTORY_SHOP || !uuid.test(r.runId) || !validDay(r.day) ||
    !Number.isSafeInteger(page) || page<0 || page>=50)throw Error("Invalid history request");
  const end=new Date(Date.parse(`${r.day}T00:00:00Z`)+86400000).toISOString().slice(0,10);
  return `/Invoice/?startDate=${r.day}&endDate=${end}&take=100&skip=${page*100}`;
}
export function matchesHistoryRequest(r:ShopHistoryRequest,endpoint:string,method:string,shopId:number,body?:unknown):boolean {
  if(shopId!==r.shopId || method!=="GET" || body!==undefined)return false;
  try { for(let page=0;page<50;page++)if(endpoint===historyEndpoint(r,page))return true; }
  catch { return false; } return false;
}
/** Used ONLY inside the existing atomic fleet-confirmation update. */
export function historyAdmissionExpression(r:ShopHistoryRequest,bindingDigest?:string):object {
  try {historyEndpoint(r,0);}catch{return {$literal:false};}
  if(!bindingDigest || !/^[a-f0-9]{64}$/.test(bindingDigest))return {$literal:false};
  return {$cond:[{$and:[
    {$eq:["$shopHistory.version",1]},{$eq:["$shopHistory.shopId",HISTORY_SHOP]},
    {$eq:["$shopHistory.runId",{$literal:r.runId}]},
    {$eq:["$shopHistory.bindingDigest",{$literal:bindingDigest}]},
    {$eq:["$shopHistory.canaryGeneration","$canary.generation"]},
    {$eq:["$shopHistory.from",HISTORY_FROM]},{$eq:["$shopHistory.until",HISTORY_UNTIL]},
    {$eq:["$shopHistory.notBefore",{$literal:new Date(HISTORY_START)}]},
    {$eq:["$shopHistory.expiresAt",{$literal:new Date(HISTORY_END)}]},
    {$eq:["$shopHistory.stopped",false]},
    {$eq:["$canary.workersSuspendedConfirmed",true]},
    {$isNumber:"$shopHistory.maxRequests"},{$isNumber:"$shopHistory.consumedRequests"},
  ]},{$and:[
    {$lte:["$shopHistory.notBefore","$$NOW"]},{$gt:["$shopHistory.expiresAt","$$NOW"]},
    {$gte:["$shopHistory.maxRequests",1]},{$lte:["$shopHistory.maxRequests",1000]},
    {$eq:[{$trunc:"$shopHistory.maxRequests"},"$shopHistory.maxRequests"]},
    {$gte:["$shopHistory.consumedRequests",0]},
    {$eq:[{$trunc:"$shopHistory.consumedRequests"},"$shopHistory.consumedRequests"]},
    {$lt:["$shopHistory.consumedRequests","$shopHistory.maxRequests"]},
  ]},false]};
}
