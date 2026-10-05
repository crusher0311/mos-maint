import { createHash } from "node:crypto";
import candidates from "@/docs/reporting/jwt-701-september-recovery-candidates.json";

export const JWT_RECOVERY_ID="jwt-701-september-2026-v1";
export const JWT_RECOVERY_PAGE_SIZE=25;
export type Outcome={wo:string;state:string;reason?:string};
export type RecoveryState={
  phase:"collect"|"repair"|"complete";offset:number;cursor:number;outcomes:Outcome[];
};
export const recoveryCandidates=candidates;
export function initialRecoveryState():RecoveryState {
  return {phase:"collect",offset:0,cursor:0,outcomes:candidates
    .filter(n=>!["absent_by_both_numbers","nonterminal"].includes(n.classification))
    .map(n=>({wo:n.wo,state:"held",reason:"Ambiguous stored invoice identity"}))};
}
export interface RecoveryDeps {
  readPage(offset:number):Promise<any[]>;
  saveSource(wo:string,raw:any,page:number,digest:string):Promise<boolean>;
  loadSource(wo:string):Promise<any|null>;
  recover(text:string):Promise<{outcomes:Outcome[]}>;
}
/** One checkpointable piece. No arbitrary shop/date/provider inputs. */
export async function advanceRecovery(input:RecoveryState,deps:RecoveryDeps):Promise<RecoveryState> {
  const state:RecoveryState=structuredClone(input);
  if(state.phase==="complete") return state;
  if(state.phase==="collect") {
    if(state.offset>=1000) throw new Error("Source page limit reached; recovery paused");
    const rows=await deps.readPage(state.offset);
    if(!Array.isArray(rows)||rows.length>JWT_RECOVERY_PAGE_SIZE)
      throw new Error("Unexpected source page; recovery paused");
    if(Buffer.byteLength(JSON.stringify(rows))>4_000_000)
      throw new Error("Source page exceeds size limit; recovery paused");
    for(const r of rows) {
      const n=candidates.find(n=>n.wo===String(r?.WorkOrderNumber)&&n.invoice===String(r?.InvoiceNumber));
      if(!n || state.outcomes.some(x=>x.wo===n.wo)) continue;
      if(rows.filter(x=>String(x?.WorkOrderNumber)===n.wo || String(x?.InvoiceNumber)===n.invoice ||
        (r.ID && x?.ID===r.ID)).length>1) {
        state.outcomes.push({wo:n.wo,state:"held",reason:"Duplicate source identity in page"});
        continue;
      }
      const text=JSON.stringify(r);
      const digest=createHash("sha256").update(text).digest("hex");
      if(Buffer.byteLength(text)>1_000_000) {
        state.outcomes.push({wo:n.wo,state:"held",reason:"Invoice exceeds source-size limit"});
      } else if(!await deps.saveSource(n.wo,r,state.offset,digest)) {
        state.outcomes.push({wo:n.wo,state:"held",reason:"Duplicate or changed source invoice"});
      }
    }
    state.offset+=rows.length;
    if(rows.length<JWT_RECOVERY_PAGE_SIZE) state.phase="repair";
    return state;
  }
  while(state.cursor<candidates.length && state.outcomes.some(x=>x.wo===candidates[state.cursor].wo)) state.cursor++;
  if(state.cursor===candidates.length) {state.phase="complete";return state;}
  const n=candidates[state.cursor];
  const raw=await deps.loadSource(n.wo);
  let outcome:Outcome;
  if(!raw) outcome={wo:n.wo,state:"held",reason:"Unique final invoice unavailable in scoped source listing"};
  else {
    try {
      const result=await deps.recover(JSON.stringify({shopId:227,location:"701",date:n.date,invoices:[raw]}));
      if(result.outcomes.length!==1 || result.outcomes[0].wo!==n.wo)
        throw new Error("Unexpected recovery outcome");
      outcome=result.outcomes[0];
    } catch(e) {
      if(["23505","23503"].includes(String((e as {code?:string})?.code))) {
        state.outcomes.push({wo:n.wo,state:"held",reason:"Conflicting or concurrently changed related-record identity; invoice transaction rolled back"});
        state.cursor++;
        return state;
      }
      if((e as Error)?.name!=="AssertionError") throw e;
      outcome={wo:n.wo,state:"held",reason:"Final source identity, date, structure or financial validation failed"};
    }
  }
  state.outcomes.push(outcome);state.cursor++;
  if(state.cursor===candidates.length) state.phase="complete";
  return state;
}
