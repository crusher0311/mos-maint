import assert from "node:assert/strict";
import {resumeWindows} from "../lib/jwt-overnight-resume";
const windows=Array.from({length:30},(_,i)=>`228:2026-09-${String(i+1).padStart(2,"0")}`);
const parent={status:"paused",manifestHash:"hash",cursor:24,page:0,runId:"fa7377a4-5f91-4d75-b1a6-14eb24920b3e",
 outcomes:{corrected:231,held:267,"already-matches":84},holds:[{shopId:228,day:"2026-09-01"}]};
assert.deepEqual(resumeWindows(parent,windows,"hash"),[...windows.slice(24),windows[0]]);
for(const patch of [{cursor:0},{page:1},{status:"completed"},{manifestHash:"changed"},{outcomes:{corrected:232}},
 {holds:[{shopId:100,day:"2026-09-01"}]}])assert.throws(()=>resumeWindows({...parent,...patch},windows,"hash"));
console.log("Resume preserves original checkpoint, deferred windows, and refuses changed parent evidence");
