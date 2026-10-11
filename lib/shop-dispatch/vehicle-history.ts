import { requireThat, type Board } from "./model";
import { historyBudget } from "@/lib/vehicle-history/budget";
import { normalizeHistoryVin, deduplicateHistory, type VehicleHistoryView, type HistoryCoverage, type HistoryEvent } from "@/lib/vehicle-history/model";

export interface WorkflowHistory {
  visitId:string; vin:string|null; currentShopId:number; checkedAt:string;
  events:HistoryEvent[]; locations:HistoryCoverage[];
  sharing:{enabled:boolean;reason?:string}; reason?:string;
}
export interface WorkflowHistoryDependencies {
  authorize:()=>Promise<{shopId:number;email:string}>;
  board:(shopId:number)=>Promise<Board>;
  cachedOrder:(shopId:number,id:string)=>Promise<unknown>;
  local:(shopId:number,vin:string,name:string)=>Promise<{events:HistoryEvent[];coverage:HistoryCoverage}>;
  shared:(shopId:number,email:string,vin:string)=>Promise<VehicleHistoryView>;
}

/** Fail closed on conflicting canonical/cache VINs. Lookup IDs and plates never link history. */
export function workflowHistoryVin(value:unknown):string|null {
  if(!value||typeof value!=="object")return null;
  const row=value as Record<string,any>;
  const candidates=[row,row.__pgTerminalMatch,row.__mongoTerminalMatch].filter(Boolean)
    .flatMap(r=>[r.vin,r.cachedVin,r.data?.ServiceItem?.VIN]).map(normalizeHistoryVin).filter((v):v is string=>!!v);
  const unique=new Set(candidates);
  return unique.size===1?[...unique][0]:null;
}

/** Read-only, current-shop visit identity. Never accepts a client-supplied VIN or shop scope. */
export async function readWorkflowHistory(visitId:string,deps:WorkflowHistoryDependencies):Promise<WorkflowHistory>{
  requireThat(visitId.length>0&&visitId.length<=180,"A workflow visit is required",400);
  const budget=historyBudget(12000);
  const principal=await budget(deps.authorize);
  const board=await budget(()=>deps.board(principal.shopId));
  const visit=board.visits.find(v=>v.id===visitId);
  requireThat(visit,"Visit not found at this location",404);
  const base:WorkflowHistory={visitId,vin:null,currentShopId:principal.shopId,checkedAt:new Date().toISOString(),
    events:[],locations:[],sharing:{enabled:false}};
  if(visit.provider!=="protractor"||!visit.sourceId)return {...base,reason:"This visit has no verified provider vehicle link. History has not been matched by name or plate."};
  const vin=workflowHistoryVin(await budget(()=>deps.cachedOrder(principal.shopId,visit.sourceId!)));
  if(!vin)return {...base,reason:"A unique, complete VIN is not available in this location's synced repair order. Refresh the repair order before retrying history."};
  const [local,shared]=await Promise.all([
    budget(()=>deps.local(principal.shopId,vin,"Current location")).catch(()=>({
      events:[] as HistoryEvent[],coverage:{shopId:principal.shopId,name:"Current location",state:"unavailable" as const,hasMore:false,fetchedAt:null,
        reason:"Local history could not be loaded. This does not mean the vehicle has no history."},
    })),
    budget(()=>deps.shared(principal.shopId,principal.email,vin)).catch(()=>null),
  ]);
  const finalPrincipal=await budget(deps.authorize);
  requireThat(finalPrincipal.shopId===principal.shopId&&finalPrincipal.email===principal.email,"History access changed; reopen the card.",403);
  const current=await budget(()=>deps.board(principal.shopId));
  const finalVisit=current.visits.find(v=>v.id===visitId);
  requireThat(finalVisit?.provider===visit.provider&&finalVisit?.sourceId===visit.sourceId,"The vehicle link changed; reopen the card.",409);
  const confirmedVin=workflowHistoryVin(await budget(()=>deps.cachedOrder(principal.shopId,visit.sourceId!)));
  requireThat(confirmedVin===vin,"The vehicle link changed; reopen the card.",409);
  const validShared=shared?.enabled&&shared.vin===vin&&shared.currentShopId===principal.shopId;
  const siblings=validShared?shared.locations.filter(l=>l.shopId!==principal.shopId):[];
  const allowed=new Set(siblings.map(l=>l.shopId));
  return {...base,vin,checkedAt:new Date().toISOString(),
    events:deduplicateHistory([...local.events.filter(e=>e.shopId===principal.shopId&&e.readOnly===true),
      ...(validShared?shared.events.filter(e=>allowed.has(e.shopId)&&e.readOnly===true):[])]),
    locations:[{...local.coverage,shopId:principal.shopId},...siblings],
    sharing:{enabled:!!validShared,reason:shared?.reason??(!shared?"Enterprise history is temporarily unavailable. Local coverage is shown separately.":undefined)},
  };
}
