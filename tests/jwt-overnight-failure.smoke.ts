import assert from "node:assert/strict";
import {JwtRecoveryHold,recoveryHoldReason} from "../lib/jwt-overnight-holds";
assert.equal(recoveryHoldReason(new JwtRecoveryHold("ambiguous identity")),"ambiguous identity");
for(const failure of ["connection lost","permission denied","statement timeout","unexpected SQL"]){
  const error=new Error(failure);
  let checkpoint=0,paused=false;
  try{
    // Same page boundary as the runner: only recognized holds permit advancing.
    try{throw error;}catch(e){recoveryHoldReason(e);}
    checkpoint++;
  }catch(e){assert.equal(e,error);paused=true;}
  assert.equal(paused,true);
  assert.equal(checkpoint,0);
}
console.log("Overnight failures preserve unfinished checkpoint; validation holds remain explicit");
