import { applyCommand, type Board } from "./model";
import { mapProtractorWorkOrder } from "./protractor";
import { isVisitVisible, terminalSourceStatus } from "./source-preferences";
import type { ProtractorWorkOrder } from "@/lib/integrations/protractor/client";

export interface SourceSnapshot {
  shopId:number|string; workOrderId:string; fetchedAt?:Date|string;
  rawPayload?:unknown; data?:unknown;
  completed?:boolean; workflowStage?:string|null; status?:string|null;
}
const sourceActor={email:"system:protractor-cache",manager:true,technicianId:null};

/** Pure reconciliation: selected new visits, all already tracked visits. No
 * automatic authorization, local closure, assignment or inspection deletion. */
export function reconcileSourceSnapshots(input:Board,shopId:number,rows:SourceSnapshot[],now:string){
  let board=input,failed=0;
  const seen=new Set<string>();
  for(const row of rows){
    if(Number(row.shopId)!==shopId)continue;
    const id=row.workOrderId?.toLowerCase();
    if(!id||seen.has(id))continue;
    seen.add(id);
    const existing=board.visits.find(v=>v.provider==="protractor"&&v.sourceId===id);
    if(existing?.closed)continue;
    const fetched= row.fetchedAt ? new Date(row.fetchedAt).getTime() : NaN;
    if(!Number.isFinite(fetched)){failed++;continue;}
    if(existing?.sourceFetchedAt && Date.parse(existing.sourceFetchedAt)>=fetched)continue;
    const payload=(row.rawPayload ?? row.data) as ProtractorWorkOrder|undefined;
    const status=row.workflowStage ?? payload?.WorkflowStage ?? row.status ?? payload?.Status ?? "Unknown";
    const terminal=row.completed||payload?.Completed||[status,payload?.Type,payload?.Status].some(terminalSourceStatus);
    if(terminal){
      if(existing){
        board=structuredClone(board);
        const visit=board.visits.find(v=>v.id===existing.id)!;
        visit.sourceStatus=terminalSourceStatus(status)?status:"Closed";
        visit.sourceFetchedAt=new Date(fetched).toISOString();
        board.audit.push({at:now,actor:sourceActor.email,action:"sourceStatus",target:visit.id,detail:"Provider marked order terminal; local work retained"});
        board.revision++;board.updatedAt=now;
      }
      continue;
    }
    if(!existing&&!isVisitVisible({provider:"protractor",sourceStatus:status},board.sourceStatuses))continue;
    try{
      if(!payload)throw new Error("Missing provider snapshot");
      const intake=mapProtractorWorkOrder(payload,id);
      board=applyCommand(board,{type:"sync",workOrderId:id},sourceActor,now,intake);
      board.visits.find(v=>v.provider==="protractor"&&v.sourceId===id)!.sourceFetchedAt=new Date(fetched).toISOString();
    }catch{failed++;}
  }
  return {board,failed};
}

export interface SourceSyncDependencies {
  list:(shopId:number,tracked:string[])=>Promise<SourceSnapshot[]>;
  save:(shopId:number,revision:number,board:Board)=>Promise<boolean>;
  read:(shopId:number)=>Promise<Board>;
}
export async function syncCachedSources(shopId:number,input:Board,deps:SourceSyncDependencies){
  try{
    const tracked=input.visits.filter(v=>!v.closed&&v.provider==="protractor"&&v.sourceId).map(v=>v.sourceId!);
    const rows=await deps.list(shopId,tracked);
    const result=reconcileSourceSnapshots(input,shopId,rows.slice(0,500),new Date().toISOString());
    if(result.board.audit.length>5000||Buffer.byteLength(JSON.stringify(result.board),"utf8")>8*1024*1024)
      return {board:input,sourceSyncWarning:"Workflow storage capacity reached. Existing work is available; arrange archival before importing more orders."};
    const warning=result.failed||rows.length>500||tracked.length>500
      ? "Some provider orders could not be imported or exceed the 500-order sync limit. Existing work is preserved. Use RO-number intake for missing orders."
      : undefined;
    if(result.board!==input&&!await deps.save(shopId,input.revision,result.board))
      return {board:await deps.read(shopId),sourceSyncWarning:"Another user saved during source refresh. Their work is preserved; automatic intake will retry on the next refresh."};
    return {board:result.board,sourceSyncWarning:warning};
  }catch{
    return {board:input,sourceSyncWarning:"Protractor cache refresh is unavailable. Showing saved workflow; automatic intake will retry on the next refresh."};
  }
}
