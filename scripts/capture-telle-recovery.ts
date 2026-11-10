/** Disabled operator capture entrypoint. No grant installation and no source repair. */
import {readFile,writeFile,mkdir,rename} from "node:fs/promises";
import {resolve,join} from "node:path";
import {collectInvoiceEvidence,validatedLookupScope,endpointsFor} from "./lib/telle-recovery-capture";
import {recoveryProofs} from "../lib/protractor-telle-recovery-policy";
import {historyBindingDigest,runWithShopHistory} from "../lib/integrations/protractor/shop-history-context";
const emit=(v:unknown)=>process.stdout.write(JSON.stringify(v)+"\n");
async function main(){
  const [mode,input,out,runId,...extra]=process.argv.slice(2);
  if(mode!=="--approved-capture"||extra.length||!input||!out||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId??"")||
    process.env.PROTRACTOR_TELLE_CAPTURE_ENABLED!=="true"||
    process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED!=="true"||process.env.NODE_ENV!=="production"||
    !process.env.RENDER_GIT_COMMIT)throw Error("capture_disabled");
  const destination=resolve(out),root=resolve("generated-artifacts")+"/";
  if(!destination.startsWith(root))throw Error("private_staging_required");
  const rows=validatedLookupScope(JSON.parse(await readFile(input,"utf8")));
  const manifest=recoveryProofs(endpointsFor(rows));
  // Exclusive directory prevents accidental replay of a partially completed capture.
  await mkdir(destination,{mode:0o700});
  const save=async(name:string,value:unknown)=>{
    const path=join(destination,name);
    await writeFile(path+".tmp",JSON.stringify(value),{mode:0o600});
    await rename(path+".tmp",path);
  };
  // Never expose provider clients' ordinary logs or response excerpts.
  console.log=console.info=console.warn=console.error=console.debug=()=>{};
  const {getDb}=await import("../lib/mongo");
  const {resolveProtractorConfig,protractorFetch,getEffectiveProtractorOutboundPolicy}=await import("../lib/integrations/protractor/client");
  const db=await getDb(),controls=db.collection("api_rate_limits");
  let owned=false,consumed=0;
  const grant=async()=>{
    const state=await controls.findOne({_id:"protractor-physical-transport-v1" as any},
      {projection:{telleRecovery:1,"operatorStop.active":1,"canary.generation":1,"canary.mode":1},maxTimeMS:2500});
    const g=state?.telleRecovery;
    if(!g||g.runId!==runId||g.shopId!==282||g.stopped||g.expiresAt<=new Date()||
      g.canaryGeneration!==state?.canary?.generation||state?.canary?.mode!=="live"||
      state?.operatorStop?.active!==false)throw Error("capture_grant_unavailable");
    return g;
  };
  try{
    const g=await grant();owned=true;
    if(g.consumedRequests!==0)throw Error("grant_already_used");
    const policy=await getEffectiveProtractorOutboundPolicy();
    if(!policy.allowed||!policy.relayRequired)throw Error("relay_policy_required");
    const result=await collectInvoiceEvidence(rows,{
      now:Date.now,
      reserve:async endpoint=>{
        await grant();consumed++;
        // Durable process-local attempt trail; physical transport separately
        // atomically consumes the grant before dispatch. Neither is refunded.
        await save("attempt.json",{runId,attempt:consumed,endpoint,at:new Date().toISOString()});
      },
      get:async(endpoint,signal)=>{
        if(signal.aborted)throw Error("capture_aborted");
        const g=await grant(),config=await resolveProtractorConfig(282);
        if(!config.configured||config.shopId!==282||historyBindingDigest(282,config.connectionId)!==g.bindingDigest)
          throw Error("capture_binding_changed");
        const response=await runWithShopHistory(g,{runId,shopId:282,day:"2026-01-01",
          pilot:"telleRecovery",endpoint,proof:manifest.proofs[endpoint]},()=>protractorFetch<any>(
            endpoint,config,{method:"GET"},0,282,{maxRetries:0,timeoutMs:30000,
              deadlineAtMs:Math.min(Date.now()+40000,+g.expiresAt)}));
        if(!response.ok||signal.aborted)throw Error("capture_request_failed");
        return response.data;
      },
      checkpoint:async(captures,outcomes)=>save("checkpoint.json",{captures,outcomes,complete:false}),
    });
    await save("capture.json",result);await save("captures.json",result.captures);
    emit({complete:result.complete,captured:result.captures.length,requests:result.requests,sourceWrites:0,deliveries:0});
    if(!result.complete)throw Error("capture_incomplete");
  }finally{
    if(owned){
      await controls.updateOne({_id:"protractor-physical-transport-v1" as any,"telleRecovery.runId":runId},
        {$set:{"telleRecovery.stopped":true}});
      const row=await controls.findOne({_id:"protractor-physical-transport-v1" as any},
        {projection:{"telleRecovery.runId":1,"telleRecovery.stopped":1},maxTimeMS:2500});
      if(row?.telleRecovery?.runId!==runId||row.telleRecovery.stopped!==true)throw Error("revocation_unconfirmed");
      emit({revoked:true,sourceWrites:0,deliveries:0});
    }
  }
}
main().then(()=>process.stdout.write("",()=>process.exit(0))).catch(e=>{
  process.stdout.write(JSON.stringify({stopped:true,reason:e instanceof Error&&/^[a-z_]+$/.test(e.message)?e.message:"capture_failed"})+"\n",()=>process.exit(1));
});
