/** Bounded read-only verification against archived source, native export and PG. */
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import assert, {AssertionError} from "node:assert/strict";
import postgres from "postgres";
import {getDb,getMongoClient} from "../lib/mongo";
import {verifyOvernightHeader} from "../lib/jwt-overnight-header-guard";
import {cents} from "../lib/jwt-labor-header-correction-guard";
import {resumeWindows} from "../lib/jwt-overnight-resume";
import {oct7Resume} from "../lib/jwt-overnight-resume-oct7";
async function main(){
 const db=await getDb(),jobId=process.argv.find(a=>a.startsWith("--job="))?.slice(6)??"jwt-overnight-2026-10-05";
 if(!["jwt-overnight-2026-10-05","jwt-overnight-2026-10-06","jwt-overnight-2026-10-07"].includes(jobId))throw Error("Unapproved reconciliation job");
 const job=await db.collection("operator_invoice_recovery_jobs").findOne({_id:jobId as any},{maxTimeMS:5000});
 if(!job||!["paused","completed","morning-stop"].includes(job.status))throw Error("Expected inactive run");
 const bytes=readFileSync("docs/reporting/jwt-overnight-native-manifest.json","utf8");
 const hash=createHash("sha256").update(bytes).digest("hex");
 assert.equal(hash,job.manifestHash,"Manifest changed");
 const native=JSON.parse(bytes);
 const results=job.results??[],counts:Record<string,number>={};
 const allKeys=new Set<string>();
 for(const r of results){
  assert.ok(["corrected","already-matches","held"].includes(r.outcome),"Unknown outcome");
  const key=`${r.shopId}:${r.day}:${r.wo}`;
  assert.ok(!allKeys.has(key),"Duplicate recorded outcome");allKeys.add(key);
  counts[r.outcome]=(counts[r.outcome]??0)+1;
 }
 assert.deepEqual(counts,job.outcomes,"Counters differ from recorded results");
 const target=new Map<string,any>(results.filter((r:any)=>r.outcome!=="held").map((r:any)=>[`${r.shopId}:${r.day}:${r.wo}`,r]));
 let windows=[...native.windowKeys].sort((a:string,b:string)=>{
  const rank=(k:string)=>k==="233:2026-09-01"?0:k.includes("2026-09")?1:2;
  return rank(a)-rank(b)||a.localeCompare(b);
 });
 if(job.parentJobId){
  const parent=await db.collection("operator_invoice_recovery_jobs").findOne({_id:job.parentJobId},{maxTimeMS:5000});
  if(jobId==="jwt-overnight-2026-10-07"){
   const grandparent=await db.collection("operator_invoice_recovery_jobs").findOne({_id:"jwt-overnight-2026-10-05" as any},{maxTimeMS:5000});
   windows=oct7Resume(parent,grandparent,windows,hash).windows;
  }else windows=resumeWindows(parent,windows,hash);
 }
 const checkpointWindow=windows[job.cursor];
 const partial:Record<string,number>={recorded:0,unrecordedNeedsCorrection:0,unrecordedAlreadyMatches:0,unrecordedHeld:0};
 let checkpointSeen=false;
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
   connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000 -c timezone=UTC"}});
 const verified=new Set<string>();let totalCents=0,pages=0,verifiedCorrected=0,mirrorMismatches=0;
 try{
  for await(const page of db.collection("operator_invoice_recovery_sources").find({jobId},{maxTimeMS:10000}).limit(1001).batchSize(1)){
   if(++pages>1000)throw Error("Unexpected source page count");
   assert.equal(createHash("sha256").update(JSON.stringify(page.invoices)).digest("hex"),page.sourceDigest,"Archived source changed");
   const isCheckpoint=`${page.shopId}:${page.day}`===checkpointWindow&&page.page===job.page;
   if(isCheckpoint)checkpointSeen=true;
   const candidates=page.invoices.filter((s:any)=>target.has(`${page.shopId}:${page.day}:${s.WorkOrderNumber}`)||
     (isCheckpoint&&native.orders.some((n:any)=>n.shopId===page.shopId&&n.date===page.day&&n.wo===String(s.WorkOrderNumber))));
   if(!candidates.length)continue;
   const keys=candidates.flatMap((s:any)=>[String(s.ID),String(s.WorkOrderNumber),String(s.InvoiceNumber)]);
   const rows=await pg.unsafe(`SELECT id,shop_id,work_order_number,status,provenance,soft_delete,labor_total,
     raw_data->>'laborTotal' raw_labor,to_char(coalesce(closed_date,completed_date),'YYYY-MM-DD') business_date
     FROM normalized_work_orders WHERE shop_id=$1 AND work_order_number=ANY($2::text[]) LIMIT 400`,[page.shopId,keys]);
   for(const s of candidates){
    const n=native.orders.find((x:any)=>x.shopId===page.shopId&&x.date===page.day&&x.wo===String(s.WorkOrderNumber));
    assert.ok(n,"Missing native evidence");
    const key=`${page.shopId}:${page.day}:${s.WorkOrderNumber}`;
    const matches=rows.filter(r=>[n.wo,n.invoice,s.ID].includes(r.work_order_number));
    if(isCheckpoint&&allKeys.has(key))partial.recorded++;
    if(!target.has(key)){
     if(allKeys.has(key))continue;
     try{
      assert.equal(matches.length,1);
      verifyOvernightHeader(matches[0],n,s,page.shopId);
      partial[cents(matches[0].labor_total)===n.laborCents?"unrecordedAlreadyMatches":"unrecordedNeedsCorrection"]++;
     }catch(error){if(!(error instanceof AssertionError))throw error;partial.unrecordedHeld++;}
     continue;
    }
    if(matches.length!==1)throw Error("Correction identity no longer unique");
    verifyOvernightHeader(matches[0],n,s,page.shopId);
    if(cents(matches[0].labor_total)!==n.laborCents)throw Error("Recorded totals differ");
    if(cents(matches[0].raw_labor)!==n.laborCents){
     if(target.get(key).outcome==="corrected")throw Error("Corrected raw mirror differs");
     mirrorMismatches++;
    }
    if(!verified.has(key)&&target.get(key).outcome==="corrected"){totalCents+=n.laborCents;verifiedCorrected++;}
    verified.add(key);
   }
  }
  if(verified.size!==target.size)throw Error("Not all corrected invoices verified");
  console.log(JSON.stringify({readOnly:true,jobId,counts,verifiedCorrected,verifiedAlreadyMatches:verified.size-verifiedCorrected,
   alreadyMatchingRawMirrorMismatches:mirrorMismatches,correctedLaborDollars:totalCents/100,sourcePages:pages,
   cursor:job.cursor,page:job.page,checkpointWindow,checkpointSeen,partial,duplicateResults:0}));
 }finally{await pg.end({timeout:5});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(async()=>{await(await getMongoClient()).close()});
