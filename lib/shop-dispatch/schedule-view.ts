import type { Board } from "./model";
/** Hashes and idempotency fingerprints are server-only, including in dashboard snapshots. */
export function scheduleBoardView(board:Board,managerEmail?:string):Board{
  // Reveal only this manager's current undo token; never other actors' receipts
  // or idempotency digests. External/public callers get none.
  const receipts=managerEmail?board.receipts.filter(r=>r.actor===managerEmail.toLowerCase()&&r.undoPlan?.revision===board.revision&&Date.parse(r.undoPlan.expiresAt)>Date.now()).map(r=>({...r,digest:""})):[];
  return {...board,receipts,schedule:board.schedule?{...board.schedule,holds:board.schedule.holds.map(h=>({...h,owner:"",requestId:"",digest:""}))}:undefined};
}
