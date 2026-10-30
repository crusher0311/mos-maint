import { tireSaleCandidate } from "@/lib/tire-dot-report";

/** Independent from reporting requests. Only the existing background poller
 * may hydrate a known tire RO; activation is a separate per-shop operator gate.
 * Injection keeps tests offline and ensures validation precedes provider I/O.
 */
export async function captureMissingTireDots(
  raw:any, scope:{mosShopId:number;providerShopId:number}, deps:{
    enabled:boolean;
    currentShop:()=>Promise<any>;
    takeBudget:()=>boolean;
    detail:(id:number)=>Promise<any>;
  },
) {
  if(!deps.enabled||!Number.isSafeInteger(raw?.id)||Number(raw.shopId)!==scope.providerShopId)return raw;
  const needs=Array.isArray(raw.jobs)&&raw.jobs.some((j:any)=>Array.isArray(j.parts)&&j.parts.some((p:any)=>p&&tireSaleCandidate(p)&&!Object.hasOwn(p,"dotNumbers")));
  if(!needs)return raw;
  const shop=await deps.currentShop();
  const validShop=(s:any)=>Number(s?.shopId)===scope.mosShopId&&Number(s?.tekmetric?.shopId??s?.tekmetricShopId)===scope.providerShopId&&
    (!(s?.integrationProvider||s?.smsProvider||s?.smsType)||(s.integrationProvider||s.smsProvider||s.smsType)==="tekmetric");
  if(!validShop(shop))throw new Error("Tire DOT capture shop identity changed");
  if(!deps.takeBudget())return raw;
  const detail=await deps.detail(raw.id);
  if(!validShop(await deps.currentShop()))throw new Error("Tire DOT capture shop identity changed");
  if(detail?.id!==raw.id||detail?.shopId!==raw.shopId||detail?.repairOrderNumber!==raw.repairOrderNumber||
    detail?.vehicleId!==raw.vehicleId||detail?.customerId!==raw.customerId||
    !Array.isArray(detail.jobs))throw new Error("Tire DOT detail identity mismatch");
  // The complete, current detail response is authoritative, not a fabricated
  // blend of old financial lines and newly observed part identifiers.
  return detail;
}
