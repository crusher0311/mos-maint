/** Bounded read-only preflight. No provider requests, mutations or index builds. */
import {getDb,getMongoClient} from "../lib/mongo";
import {getEnterpriseByShopId} from "../lib/enterprise";
import {writeFileSync} from "node:fs";
async function main(){
 const db=await getDb(), now=new Date();
 const enterprise=await getEnterpriseByShopId(227);
 if(enterprise?.name!=="JWT"||enterprise.shopIds.length>50)throw Error("JWT membership unavailable");
 const ids=enterprise.shopIds.map(Number);
 const result:any={checkedAt:now.toISOString(),readOnly:true,shopIds:ids};
 async function collect(name:string,work:()=>Promise<any>){
 try{result[name]=await work();}catch(e:any){result[name]={unavailable:true,error:e.codeName??e.name};}
 }
 await collect("activity",async()=>{
 const cap=20000;
 const rows=await db.collection("api_usage").find({provider:"protractor",environment:"production",
 timestamp:{$gte:new Date(now.getTime()-24*3600000)}},{projection:{timestamp:1,statusCode:1,latencyMs:1,transport:1,endpoint:1},
 hint:{provider:1,timestamp:-1},maxTimeMS:2500}).sort({timestamp:-1}).limit(cap+1).toArray();
 const truncated=rows.length>cap,sample=rows.slice(0,cap);
 const bins=new Map<string,number>(),statuses:Record<string,number>={},transport:Record<string,number>={};
 for(const r of sample){const key=new Date(r.timestamp).toISOString().slice(0,16);bins.set(key,(bins.get(key)??0)+1);
 statuses[String(r.statusCode)]=(statuses[String(r.statusCode)]??0)+1;
 const t=r.transport==="relay"||r.endpoint==="relay"?"relay":"other-or-unspecified";
 transport[t]=(transport[t]??0)+1;}
 const latency=sample.map(r=>Number(r.latencyMs)).filter(Number.isFinite).sort((a,b)=>a-b);
 return {windowHours:24,sampled:sample.length,truncated,newest:sample[0]?.timestamp,oldest:sample.at(-1)?.timestamp,
 maxRecordedEventsPerMinute:Math.max(0,...bins.values()),statuses,transport,p95LatencyMs:latency[Math.floor(latency.length*.95)]??null,
 note:"Telemetry events are not necessarily unique physical requests. Capped samples and logging gaps cannot prove spare capacity."};
 });
 await collect("transportPolicy",async()=>db.collection("api_rate_limits").findOne(
 {_id:"protractor-physical-transport-v1" as any},{maxTimeMS:2500,projection:{
 _id:0,"operatorStop.active":1,"operatorStop.updatedAt":1,
 "canary.mode":1,"canary.scope":1,"canary.startedAt":1,"canary.expiresAt":1,"canary.endedBy":1,
 "canary.workersSuspendedConfirmed":1,"canary.maxAdmissions":1,"canary.remainingAdmissions":1,"canary.consumedAdmissions":1}}));
 await collect("jwtBackfill",async()=>db.collection("backfill_progress").find(
 {shopId:{$in:ids}},{maxTimeMS:2500,projection:{_id:0,shopId:1,provider:1,status:1,completed:1,startDate:1,endDate:1,
 currentDate:1,lastProcessedDate:1,lastRunAt:1,lastActivityAt:1,updatedAt:1,lockUntil:1,lockExpiresAt:1,paused:1,pausedUntil:1}})
 .limit(60).toArray());
 await collect("breaker",async()=>db.collection("protractor_circuit_breakers").findOne({_id:"provider" as any},{maxTimeMS:2500,
 projection:{_id:0,openUntil:1,probeUntil:1,updatedAt:1}}));
 await collect("hostLoad",async()=>db.collection("host_load_samples").find(
 {host:/^srv-d55jaqkhg0os73a5dd8g-/,sampledAt:{$gte:new Date(now.getTime()-15*60000)}},{maxTimeMS:2500,
 projection:{_id:0,sampledAt:1,host:1,cpu:1,eventLoopLagMs:1,pg:1,"mongo.connections":1,captureError:1}})
 .sort({sampledAt:-1}).limit(10).toArray());
 writeFileSync("docs/reporting/jwt-overnight-preflight.json",JSON.stringify(result,null,2)+"\n");
 console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.name,"Preflight failed");process.exitCode=1;})
 .finally(async()=>{await(await getMongoClient()).close();});
