/** Bounded read-only verification against archived source, native export and PG. */
import {readFileSync} from "node:fs";
import postgres from "postgres";
import {getDb,getMongoClient} from "../lib/mongo";
import {verifyOvernightHeader} from "../lib/jwt-overnight-header-guard";
import {cents} from "../lib/jwt-labor-header-correction-guard";
async function main(){
 const db=await getDb(),jobId="jwt-overnight-2026-10-05";
 const job=await db.collection("operator_invoice_recovery_jobs").findOne({_id:jobId as any},{maxTimeMS:5000});
 if(!job||job.status!=="paused")throw Error("Expected paused run");
 const native=JSON.parse(readFileSync("docs/reporting/jwt-overnight-native-manifest.json","utf8"));
 const target=new Map<string,any>((job.results??[]).filter((r:any)=>r.outcome==="corrected").map((r:any)=>[`${r.shopId}:${r.day}:${r.wo}`,r]));
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
   connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000 -c timezone=UTC"}});
 const verified=new Set<string>();let totalCents=0,pages=0;
 try{
  for await(const page of db.collection("operator_invoice_recovery_sources").find({jobId},{maxTimeMS:10000}).limit(30).batchSize(1)){
   if(++pages>25)throw Error("Unexpected source page count");
   const candidates=page.invoices.filter((s:any)=>target.has(`${page.shopId}:${page.day}:${s.WorkOrderNumber}`));
   if(!candidates.length)continue;
   const keys=candidates.flatMap((s:any)=>[String(s.ID),String(s.WorkOrderNumber),String(s.InvoiceNumber)]);
   const rows=await pg.unsafe(`SELECT id,shop_id,work_order_number,status,provenance,soft_delete,labor_total,
     raw_data->>'laborTotal' raw_labor,to_char(coalesce(closed_date,completed_date),'YYYY-MM-DD') business_date
     FROM normalized_work_orders WHERE shop_id=$1 AND work_order_number=ANY($2::text[]) LIMIT 400`,[page.shopId,keys]);
   for(const s of candidates){
    const n=native.orders.find((x:any)=>x.shopId===page.shopId&&x.date===page.day&&x.wo===String(s.WorkOrderNumber));
    const matches=rows.filter(r=>[n.wo,n.invoice,s.ID].includes(r.work_order_number));
    if(matches.length!==1)throw Error("Correction identity no longer unique");
    verifyOvernightHeader(matches[0],n,s,page.shopId);
    if(cents(matches[0].labor_total)!==n.laborCents||cents(matches[0].raw_labor)!==n.laborCents)throw Error("Corrected totals differ");
    const key=`${page.shopId}:${page.day}:${s.WorkOrderNumber}`;
    if(!verified.has(key))totalCents+=n.laborCents;
    verified.add(key);
   }
  }
  if(verified.size!==target.size)throw Error("Not all corrected invoices verified");
  console.log(JSON.stringify({readOnly:true,corrected:target.size,verified:verified.size,totalLaborDollars:totalCents/100,sourcePages:pages,cursor:job.cursor,page:job.page}));
 }finally{await pg.end({timeout:5});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(async()=>{await(await getMongoClient()).close()});
