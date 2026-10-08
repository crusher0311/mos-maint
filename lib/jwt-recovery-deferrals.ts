export interface RecoveryDeferral {
 attempts:number;retryAt:Date;exhausted:boolean;page:number;
 pendingInvoices:number;phase:string;sqlState:string;
}
/** Bounded window passes, independent of the three retries per transaction. */
export function deferRecoveryWindow(previous:RecoveryDeferral|undefined,page:number,pendingInvoices:number,
 phase:string,sqlState:string,now=Date.now()):RecoveryDeferral {
 const attempts=(previous?.attempts??0)+1;
 return {attempts,retryAt:new Date(now+Math.min(15*60_000,60_000*2**(attempts-1))),
  exhausted:attempts>=4,page,pendingInvoices,phase,sqlState};
}
export function windowReady(deferral:RecoveryDeferral|undefined,now=Date.now()):boolean {
 return !deferral||(!deferral.exhausted&&new Date(deferral.retryAt).getTime()<=now);
}
