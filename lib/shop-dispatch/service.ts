import { createHash } from "node:crypto";
import { actorFor, applyCommand, DispatchError, mutationSchema, requireThat, type Board, type Intake } from "./model";
export interface Principal {shopId:number;email:string;role:string}
export interface DispatchDependencies {
  read:(shopId:number)=>Promise<Board>;
  save:(shopId:number,revision:number,board:Board)=>Promise<boolean>;
  intake:(shopId:number,workOrderId:string)=>Promise<Intake>;
  now:()=>string;
}
export function digest(value:unknown):string{return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
export async function executeDispatchMutation(principal:Principal,raw:unknown,deps:DispatchDependencies):Promise<Board>{
  const parsed=mutationSchema.safeParse(raw);
  requireThat(parsed.success,"Invalid command. Check required fields and lengths.",400);
  const {requestId,revision,command}=parsed.data;
  const board=await deps.read(principal.shopId);
  const actor=actorFor(board,principal.email,principal.role);
  const hash=digest(command),receipt=board.receipts.find(r=>r.id===requestId);
  if(receipt){
    requireThat(receipt.actor===actor.email&&receipt.digest===hash,"Request ID already used for different work",409);
    return board;
  }
  requireThat(board.revision===revision,"Another user changed the workflow. Refresh, review the latest state and submit again.",409);
  requireThat(board.receipts.length<5000,"Pilot receipt capacity reached; arrange archival before continuing.",409);
  if(command.type==="sync")requireThat(actor.manager,"Only managers may import repair orders",403);
  const intake=command.type==="sync"?await deps.intake(principal.shopId,command.workOrderId):undefined;
  const result=applyCommand(board,command,actor,deps.now(),intake);
  result.receipts.push({id:requestId,actor:actor.email,digest:hash});
  requireThat(Buffer.byteLength(JSON.stringify(result),"utf8")<=8*1024*1024,"Pilot storage capacity reached. Export and arrange archival.",409);
  if(!await deps.save(principal.shopId,revision,result)){
    // A retry may have committed while the original request was still running.
    const latest=await deps.read(principal.shopId);
    if(latest.receipts.some(r=>r.id===requestId&&r.actor===actor.email&&r.digest===hash))return latest;
    throw new DispatchError(409,"Another user saved first. Refresh and review before resubmitting.");
  }
  return result;
}
