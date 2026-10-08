import {createHash} from "node:crypto";
import {validateJwtOvernightGrant, type JwtOvernightGrant} from "./protractor-jwt-overnight-policy";

export function recoveryCheckpointDigest(job:any):string {
 return createHash("sha256").update(JSON.stringify({
  runId:job.runId,manifestHash:job.manifestHash,cursor:job.cursor,page:job.page,
  outcomes:job.outcomes??{},results:job.results??[],
  completedWindowKeys:job.completedWindowKeys??[],windowPages:job.windowPages??{}
 })).digest("hex");
}
export function recoveryGrantDigest(grant:JwtOvernightGrant):string {
 return createHash("sha256").update(JSON.stringify(grant)).digest("hex");
}

/** Explicit one-use operator handoff, never automatic recovery of a stopped run. */
export function validateEligibleHandoff(job:any,grant:JwtOvernightGrant,now=new Date()):void {
 const proof=job?.eligibleResume;
 if(job?._id!=="jwt-overnight-2026-10-07"||job.status!=="paused"||job.stopped!==true||
    !proof||proof.claimedBy||proof.approval!=="eligible-shops-first"||
    !/^job-[a-z0-9]+$/.test(proof.renderJobId??"")||
    proof.checkpointDigest!==recoveryCheckpointDigest(job)||
    proof.grantDigest!==recoveryGrantDigest(grant))
  throw Error("Missing or changed operator-approved recovery handoff");
 validateJwtOvernightGrant(grant);
 if(grant.runId!==job.runId||grant.manifestHash!==job.manifestHash||!grant.stopped||
    grant.expiresAt.getTime()<=now.getTime()||grant.notBefore.getTime()>now.getTime()||
    grant.consumedRequests>=grant.maxRequests)
  throw Error("Recovery handoff permit is unavailable");
}

export function recoverySchedule(windows:string[],job:any) {
 if(!Number.isInteger(job.cursor)||job.cursor<0||job.cursor>windows.length||
    !Number.isInteger(job.page)||job.page<0||job.page>4)
  throw Error("Invalid recovery checkpoint");
 const completed=new Set<string>(job.completedWindowKeys??windows.slice(0,job.cursor));
 if([...completed].some(k=>!windows.includes(k))||
    windows.slice(0,job.cursor).some(k=>!completed.has(k)))
  throw Error("Invalid completed-window ledger");
 const pages:Record<string,number>={...(job.windowPages??{})};
 if(job.cursor<windows.length&&pages[windows[job.cursor]]===undefined)
  pages[windows[job.cursor]]=job.page;
 for(const [key,page] of Object.entries(pages)){
  if(!windows.includes(key)||!Number.isInteger(page)||page<0||page>4)
   throw Error("Invalid per-window page checkpoint");
 }
 return {completed,pages};
}

export function nextEligibleWindow(windows:string[],completed:Set<string>,eligible:(shopId:number)=>boolean):number {
 return windows.findIndex(key=>!completed.has(key)&&eligible(Number(key.split(":")[0])));
}

export function scheduleCheckpoint(windows:string[],completed:Set<string>,pages:Record<string,number>) {
 const missing=windows.findIndex(key=>!completed.has(key));
 const cursor=missing<0?windows.length:missing;
 return {cursor,page:pages[windows[cursor]]??0,
  completedWindowKeys:[...completed],windowPages:pages,completedWindows:completed.size};
}
