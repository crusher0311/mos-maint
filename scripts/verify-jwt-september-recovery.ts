import {getDb,getMongoClient} from "../lib/mongo";
import postgres from "postgres";
import {writeFileSync} from "node:fs";
import candidates from "../docs/reporting/jwt-701-september-recovery-candidates.json";

async function main(){
 const db=await getDb();
 const job=await db.collection("operator_invoice_recovery_jobs").findOne(
   {_id:"jwt-701-september-2026-v1"} as any,
   {projection:{_id:0,state:1,pauseRequested:1,updatedAt:1,error:1},maxTimeMS:3000});
 if(!job?.state || job.state.phase!=="complete") throw new Error("Recovery is not complete");
 const outcomes=job.state.outcomes as {wo:string;state:string;reason?:string}[];
 if(outcomes.length!==candidates.length || new Set(outcomes.map(x=>x.wo)).size!==candidates.length ||
    outcomes.some(o=>!candidates.some(c=>c.wo===o.wo))) throw new Error("Outcome identity mismatch");
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
   connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000"}});
 try {
   const rows:any[]=[];
   for(let i=0;i<candidates.length;i+=50) {
     const ids=candidates.slice(i,i+50).map(c=>c.wo);
     rows.push(...await pg.unsafe(`SELECT work_order_number,status,
       (coalesce(closed_date,completed_date) AT TIME ZONE 'UTC')::date::text AS business_date,
       coalesce((soft_delete->>'isDeleted')::boolean,false) AS deleted,
       customer_id IS NOT NULL AND
         (vehicle_id IS NOT NULL OR
           raw_data->'customFields'->>'recoveryVehicleIdentity' =
             'unknown; source side-by-side; no verified vehicle link') AS related_links,
       vehicle_id IS NULL AND raw_data->'customFields'->>'recoveryVehicleIdentity' =
         'unknown; source side-by-side; no verified vehicle link' AS documented_unknown_vehicle,
       raw_data->'customFields'->>'jwtRecoverySourceDigest' IS NOT NULL AS recovery_digest
       FROM normalized_work_orders WHERE shop_id=227 AND work_order_number=ANY($1::text[])`,
       [`{${ids.join(",")}}`]));
   }
   const applied=outcomes.filter(o=>["applied","already-applied"].includes(o.state));
   const verificationFailures=applied.filter(o=>{
     const matches=rows.filter(r=>r.work_order_number===o.wo), c=candidates.find(c=>c.wo===o.wo)!;
     return matches.length!==1 || matches[0].deleted ||
       !["closed","invoiced","paid"].includes(matches[0].status) ||
       matches[0].business_date!==c.date || !matches[0].related_links || !matches[0].recovery_digest;
   }).map(o=>o.wo);
   const counts:Record<string,number>={},heldReasons:Record<string,number>={};
   const verificationIssues:Record<string,string[]>={};
   for(const wo of verificationFailures){
     const matches=rows.filter(r=>r.work_order_number===wo), c=candidates.find(c=>c.wo===wo)!;
     verificationIssues[wo]=matches.length!==1?["nonunique or missing header"]:[
       ...(matches[0].deleted?["deleted"]:[]),
       ...(!["closed","invoiced","paid"].includes(matches[0].status)?["nonterminal"]:[]),
       ...(matches[0].business_date!==c.date?[`date mismatch: ${matches[0].business_date} vs ${c.date}`]:[]),
       ...(!matches[0].related_links?["missing related link"]:[]),
       ...(!matches[0].recovery_digest?["missing recovery digest"]:[])];
   }
   for(const o of outcomes){counts[o.state]=(counts[o.state]??0)+1;
     if(o.state==="held")heldReasons[o.reason??"unspecified"]=(heldReasons[o.reason??"unspecified"]??0)+1;}
   const report={checkedAt:new Date().toISOString(),shopId:227,location:"701",phase:job.state.phase,
     sourceRowsScanned:job.state.offset,total:outcomes.length,counts,heldReasons,
     verifiedAppliedHeaders:applied.length-verificationFailures.length,
     documentedUnknownVehicles:rows.filter(r=>r.documented_unknown_vehicle && applied.some(o=>o.wo===r.work_order_number)).length,
     verificationFailures,verificationIssues,
     verificationScope:"Read-only exact candidate identities, active terminal status, native date, customer/vehicle link presence or documented unknown vehicle, and recovery digest; not native financial reconciliation.",
     outcomes};
   writeFileSync("docs/reporting/jwt-701-september-recovery-results.json",JSON.stringify(report,null,2)+"\n");
   const {outcomes:_,...summary}=report;console.log(JSON.stringify(summary,null,2));
   if(verificationFailures.length)process.exitCode=1;
 } finally {await pg.end({timeout:5});}
}
main().catch(e=>{console.error(e.name,e.code??"verification failed");process.exitCode=1;})
 .finally(async()=>{await(await getMongoClient()).close();});
