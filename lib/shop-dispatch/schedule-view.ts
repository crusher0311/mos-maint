import type { Board } from "./model";
/** Hashes and idempotency fingerprints are server-only, including in dashboard snapshots. */
export function scheduleBoardView(board:Board):Board{
  return {...board,receipts:[],schedule:board.schedule?{...board.schedule,holds:board.schedule.holds.map(h=>({...h,owner:"",requestId:"",digest:""}))}:undefined};
}
