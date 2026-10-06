/** Operational failures must escape to the runner's pause/checkpoint boundary. */
export class JwtRecoveryHold extends Error {}
export function recoveryHoldReason(error:unknown):string {
  if(error instanceof JwtRecoveryHold) return error.message;
  throw error;
}
