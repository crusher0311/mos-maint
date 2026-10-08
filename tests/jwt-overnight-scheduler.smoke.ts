import assert from "node:assert/strict";
import {recoverySchedule,nextEligibleWindow,scheduleCheckpoint,recoveryCheckpointDigest,recoveryGrantDigest,validateEligibleHandoff} from "../lib/jwt-overnight-scheduler";
const windows=["233:2026-09-02","234:2026-09-02","227:2026-08-01","228:2026-08-01"];
const schedule=recoverySchedule(windows,{cursor:0,page:2});
const eligible=new Set([227,228]);
assert.equal(nextEligibleWindow(windows,schedule.completed,id=>eligible.has(id)),2);
schedule.completed.add(windows[2]);
let checkpoint=scheduleCheckpoint(windows,schedule.completed,schedule.pages);
assert.equal(checkpoint.cursor,0,"earliest blocked checkpoint is not advanced");
assert.equal(checkpoint.page,2,"partial page is retained while another shop runs");
assert.equal(checkpoint.completedWindows,1);
const resumed=recoverySchedule(windows,checkpoint);
assert.equal(nextEligibleWindow(windows,resumed.completed,id=>eligible.has(id)),3);
eligible.add(233);
assert.equal(nextEligibleWindow(windows,resumed.completed,id=>eligible.has(id)),0,"deferred work returns once eligible");
assert.equal(nextEligibleWindow(windows,resumed.completed,()=>false),-1);
windows.forEach(k=>resumed.completed.add(k));
assert.equal(scheduleCheckpoint(windows,resumed.completed,resumed.pages).cursor,4);
assert.equal(recoverySchedule(windows,{cursor:2,page:1}).completed.size,2,"legacy prefix converted");
assert.throws(()=>recoverySchedule(windows,{cursor:1,page:0,completedWindowKeys:[]}));
assert.throws(()=>recoverySchedule(windows,{cursor:0,page:5}));
assert.throws(()=>recoverySchedule(windows,{cursor:0,page:0,windowPages:{"unknown":1}}));

const grant={
 version:1 as const,runId:"00000000-0000-4000-8000-000000000001",
 canaryGeneration:"00000000-0000-4000-8000-000000000002",
 manifestHash:"a".repeat(64),notBefore:new Date("2026-10-07T23:00:00Z"),
 expiresAt:new Date("2026-10-08T10:00:00Z"),windowKeys:windows,
 consumedRequests:126,maxRequests:1000,stopped:true
};
const job:any={_id:"jwt-overnight-2026-10-07",status:"paused",stopped:true,
 runId:grant.runId,manifestHash:grant.manifestHash,cursor:1,page:0,
 results:[{shopId:233,day:"2026-09-02",wo:"synthetic",outcome:"held"}],outcomes:{held:1}};
job.eligibleResume={approval:"eligible-shops-first",renderJobId:"job-synthetic",
 checkpointDigest:recoveryCheckpointDigest(job),grantDigest:recoveryGrantDigest(grant)};
const now=new Date("2026-10-08T00:40:00Z");
validateEligibleHandoff(job,grant,now);
assert.throws(()=>validateEligibleHandoff({...job,status:"running"},grant,now));
assert.throws(()=>validateEligibleHandoff({...job,results:[]},grant,now));
assert.throws(()=>validateEligibleHandoff({...job,eligibleResume:{...job.eligibleResume,claimedBy:"old"}},grant,now));
assert.throws(()=>validateEligibleHandoff(job,{...grant,consumedRequests:65},now),"budget cannot reset");
assert.throws(()=>validateEligibleHandoff(job,{...grant,stopped:false},now));
assert.throws(()=>validateEligibleHandoff(job,grant,new Date("2026-10-08T10:00:00Z")));
console.log("PASS eligible-first scheduling, deferred/partial restart checkpoints, one-use handoff and preserved budget");
