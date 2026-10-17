import type {ShopHistoryGrant,ShopHistoryRequest} from "./protractor-shop-history-policy";
export const INVOICE_RECOVERY = Object.freeze({
  start:"2026-10-17T00:00:00.000Z",end:"2026-10-19T10:00:00.000Z",
  from:"2024-10-17",until:"2026-10-18",maxRequests:1000,
});
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest=/^[a-f0-9]{64}$/;
const validDay=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&day>=INVOICE_RECOVERY.from&&
  day<INVOICE_RECOVERY.until&&new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)===day;
const nextDay=(day:string)=>new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10);
export function invoiceRecoveryEndpoint(r:ShopHistoryRequest,page:number){
  if(r.pilot!=="invoiceRecovery"||!Number.isInteger(r.shopId)||r.shopId<227||r.shopId>236||
    !uuid.test(r.runId)||!uuid.test(r.recoveryOwner??"")||!validDay(r.day)||
    !Number.isInteger(page)||page<0||page>=100)throw Error("Outside invoice recovery scope");
  return `/Invoice/?startDate=${r.day}&endDate=${nextDay(r.day)}&take=100&skip=${page*100}`;
}
export function validateInvoiceRecoveryGrant(g:ShopHistoryGrant){
  const extra=g as ShopHistoryGrant&{owner:string;runnerLeaseUntil:Date;activityCheckedAt:Date};
  if(g.version!==5||!Number.isInteger(g.shopId)||g.shopId<227||g.shopId>236||
    !uuid.test(g.runId)||!uuid.test(g.canaryGeneration)||!digest.test(g.bindingDigest)||
    !uuid.test(extra.owner)||!validDay(g.from)||g.until!==nextDay(g.from)||
    !(g.notBefore instanceof Date)||g.notBefore.toISOString()!==INVOICE_RECOVERY.start||
    !(g.expiresAt instanceof Date)||g.expiresAt.toISOString()!==INVOICE_RECOVERY.end||
    g.maxRequests!==1000||!Number.isInteger(g.consumedRequests)||g.consumedRequests<0||
    g.consumedRequests>1000||typeof g.stopped!=="boolean"||
    !(extra.runnerLeaseUntil instanceof Date)||!(extra.activityCheckedAt instanceof Date))
    throw Error("Invalid invoice recovery permission");
}
/** Independent budget, but the SAME fleet physical dispatch and callback protections. */
export function invoiceRecoveryAdmissionExpression(r:ShopHistoryRequest,binding?:string):object{
  try{invoiceRecoveryEndpoint(r,0)}catch{return {$literal:false}}
  if(!binding||!digest.test(binding))return {$literal:false};
  const p="$invoiceRecovery";
  return {$cond:[{$and:[
    {$eq:[`${p}.version`,5]},{$eq:[`${p}.shopId`,r.shopId]},
    {$eq:[`${p}.runId`,{$literal:r.runId}]},{$eq:[`${p}.owner`,{$literal:r.recoveryOwner}]},
    {$eq:[`${p}.bindingDigest`,{$literal:binding}]},
    {$eq:[`${p}.canaryGeneration`,"$canary.generation"]},
    {$eq:[`${p}.from`,r.day]},{$eq:[`${p}.until`,nextDay(r.day)]},
    {$eq:[`${p}.notBefore`,{$literal:new Date(INVOICE_RECOVERY.start)}]},
    {$eq:[`${p}.expiresAt`,{$literal:new Date(INVOICE_RECOVERY.end)}]},
    {$eq:[`${p}.stopped`,false]},{$eq:["$canary.workersSuspendedConfirmed",true]},
    {$eq:[`${p}.maxRequests`,1000]},{$isNumber:`${p}.consumedRequests`},
    {$eq:[{$type:`${p}.runnerLeaseUntil`},"date"]},
    {$eq:[{$type:`${p}.activityCheckedAt`},"date"]},
  ]},{$and:[
    {$gte:["$$NOW",`${p}.notBefore`]},{$lt:["$$NOW",`${p}.expiresAt`]},
    {$gt:[`${p}.runnerLeaseUntil`,"$$NOW"]},
    {$lte:[`${p}.activityCheckedAt`,"$$NOW"]},
    {$gte:[`${p}.activityCheckedAt`,{$subtract:["$$NOW",10000]}]},
    {$gte:[`${p}.consumedRequests`,0]},{$lt:[`${p}.consumedRequests`,1000]},
    {$eq:[{$trunc:`${p}.consumedRequests`},`${p}.consumedRequests`]},
  ]},false]};
}
