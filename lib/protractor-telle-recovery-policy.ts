import {createHash} from "node:crypto";
import type {ShopHistoryGrant,ShopHistoryRequest} from "./protractor-shop-history-policy";
export const TELLE_RECOVERY_ROOT="452a0cfd28443a9cc31aabf04d446de61af3d751e63d193812f073fd68f6dc76";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function recoveryProofs(endpoints:string[]){
  const leaves=[...new Set(endpoints)].sort();
  const levels=[leaves.map(e=>hash("leaf:"+e))];
  while(levels.at(-1)!.length>1){
    const a=levels.at(-1)!,b:string[]=[];
    for(let i=0;i<a.length;i+=2)b.push(hash("node:"+[a[i],a[i+1]??a[i]].sort().join("")));
    levels.push(b);
  }
  return {root:levels.at(-1)?.[0],proofs:Object.fromEntries(leaves.map((e,i)=>{
    const proof:string[]=[];for(const a of levels.slice(0,-1)){proof.push(a[i^1]??a[i]);i=Math.floor(i/2);}
    return [e,proof];
  }))};
}
export function telleRecoveryEndpoint(r:ShopHistoryRequest,page:number){
  if(process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED!=="true"||page!==0||r.pilot!=="telleRecovery"||
    r.shopId!==282||!uuid.test(r.runId)||typeof r.endpoint!=="string"||
    !Array.isArray(r.proof)||r.proof.length>10)throw Error("Recovery disabled or outside scope");
  let root=hash("leaf:"+r.endpoint);
  for(const sibling of r.proof){
    if(!/^[a-f0-9]{64}$/.test(sibling))throw Error("Invalid scope proof");
    root=hash("node:"+[root,sibling].sort().join(""));
  }
  if(root!==TELLE_RECOVERY_ROOT)throw Error("Unapproved invoice reference");
  return r.endpoint;
}
export function validateTelleRecoveryGrant(g:ShopHistoryGrant){
  if(process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED!=="true"||g.version!==6||g.shopId!==282||
    g.from!=="2026-01-01"||g.until!=="2026-11-09"||g.manifestRoot!==TELLE_RECOVERY_ROOT||
    !uuid.test(g.runId)||!uuid.test(g.canaryGeneration)||!/^[a-f0-9]{64}$/.test(g.bindingDigest)||
    !(g.notBefore instanceof Date)||!(g.expiresAt instanceof Date)||
    !Number.isFinite(+g.notBefore)||!Number.isFinite(+g.expiresAt)||
    +g.expiresAt<=+g.notBefore||+g.expiresAt-+g.notBefore>1800000||
    !Number.isInteger(g.maxRequests)||g.maxRequests<1||g.maxRequests>500||
    !Number.isInteger(g.consumedRequests)||g.consumedRequests<0||g.consumedRequests>g.maxRequests||
    typeof g.stopped!=="boolean")throw Error("Invalid Telle recovery grant");
}
export function telleRecoveryAdmission(r:ShopHistoryRequest,binding?:string):object{
  try{telleRecoveryEndpoint(r,0);}catch{return {$literal:false};}
  if(!binding||!/^[a-f0-9]{64}$/.test(binding))return {$literal:false};
  const p="$telleRecovery";
  return {$cond:[{$and:[
    {$eq:[`${p}.version`,6]},{$eq:[`${p}.shopId`,282]},
    {$eq:[`${p}.runId`,{$literal:r.runId}]},{$eq:[`${p}.bindingDigest`,{$literal:binding}]},
    {$eq:[`${p}.manifestRoot`,TELLE_RECOVERY_ROOT]},
    {$eq:[`${p}.from`,"2026-01-01"]},{$eq:[`${p}.until`,"2026-11-09"]},
    {$eq:[`${p}.canaryGeneration`,"$canary.generation"]},{$eq:[`${p}.stopped`,false]},
    {$eq:[{$type:`${p}.notBefore`},"date"]},{$eq:[{$type:`${p}.expiresAt`},"date"]},
    {$isNumber:`${p}.maxRequests`},{$isNumber:`${p}.consumedRequests`},
  ]},{$and:[
    {$lte:[`${p}.notBefore`,"$$NOW"]},{$gt:[`${p}.expiresAt`,"$$NOW"]},
    {$lte:[{$subtract:[`${p}.expiresAt`,`${p}.notBefore`]},1800000]},
    {$gte:[`${p}.maxRequests`,1]},{$lte:[`${p}.maxRequests`,500]},
    {$eq:[{$trunc:`${p}.maxRequests`},`${p}.maxRequests`]},
    {$gte:[`${p}.consumedRequests`,0]},
    {$eq:[{$trunc:`${p}.consumedRequests`},`${p}.consumedRequests`]},
    {$lt:[`${p}.consumedRequests`,`${p}.maxRequests`]},
  ]},false]};
}
