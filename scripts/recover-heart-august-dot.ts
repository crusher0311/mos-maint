/** Explicit operator recovery: bounded, read-only provider requests; private local results only. */
import { MongoClient } from "mongodb";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tireSaleCandidate, emptyTireResult, validateTireDefinition, extractTireInvoice, tireCoverageGap, tireCsv } from "../lib/tire-dot-report";
import { acquireSharedTekmetricSlot, isSharedLimiterPgCanonical, isSharedLimiterDisabled } from "../lib/integrations/tekmetric/shared-rate-limiter";
import { existingBudgetDatabase, waitForRecoverySlot } from "./lib/heart-recovery-budget";
const root="generated-artifacts/heart-tire-dot-validation/2026-08-01_2026-08-31";
const dir=`${root}/detail-recovery`;
const money={"Labor Sales":"laborSales","Parts sales":"partsSales","Sublet Sales":"subletSales","Fees":"feeTotal","Discounts":"discountTotal","Tax Collected":"taxes","Total Sales":"totalSales"} as const;
async function main(){
 const client=new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,{maxPoolSize:1,serverSelectionTimeoutMS:10000});
 await mkdir(dir,{recursive:true,mode:0o700});
 try{
  await client.connect();const db=client.db("mos-maintenance-mvp");
  const shared=process.argv.includes("--shared-budget");
  if(shared&&(isSharedLimiterPgCanonical()||isSharedLimiterDisabled()))throw new Error("Shared budget mode differs from the verified active Mongo bucket");
  const budgetDb=shared?await existingBudgetDatabase(db):undefined;
  const enterprise=await db.collection("enterprise_accounts").findOne({name:"HEART Certified Auto Care"},{projection:{shopIds:1},maxTimeMS:3000});
  if(!enterprise?.shopIds?.length)throw new Error("Missing membership");
  const shops=await db.collection("shops").find({shopId:{$in:enterprise.shopIds}},{projection:{shopId:1,locationIdentifier:1,integrationProvider:1,"tekmetric.shopId":1},maxTimeMS:3000}).limit(100).toArray();
  const baseline=JSON.parse(await readFile(`${root}/sales-comparison.json`,"utf8")).comparisons;
  const direct=JSON.parse(await readFile(`${root}/direct-raw-unresolved.json`,"utf8")).results;
  const expected=JSON.parse(await readFile(`${root}/export-input.json`,"utf8"));
  const candidates:any[]=[];
  for(const shop of shops){
   if(shop.integrationProvider&&shop.integrationProvider!=="tekmetric")throw new Error("Provider changed");
   const roIds=[...new Set<string>([...baseline,...direct].filter(r=>r.shopId===shop.shopId&&r.providerRoId).map(r=>r.providerRoId))];
   for(let i=0;i<roIds.length;i+=40){
    const batch=roIds.slice(i,i+40);
    const docs=await db.collection("tekmetric_work_orders").find({shopId:{$in:[shop.shopId,String(shop.shopId)]},workOrderId:{$in:batch.flatMap(id=>[id,Number(id)])}},
     {projection:{workOrderId:1,"data.id":1,"data.shopId":1,"data.repairOrderNumber":1,"data.jobs.parts":1},maxTimeMS:5000}).hint("shopId_workOrderId").limit(100).toArray();
    for(const doc of docs){
     const raw=doc.data;
     const hasCandidate=raw?.jobs?.some((j:any)=>j.parts?.some((p:any)=>tireSaleCandidate(p)||[p.width,p.ratio,p.diameter].every(n=>Number(n)>0)));
     const invoice=baseline.find((r:any)=>r.shopId===shop.shopId&&r.invoice===String(raw?.repairOrderNumber));
     if(!hasCandidate||!invoice)continue;
     if(Number(raw.shopId)!==Number(shop.tekmetric?.shopId)||String(raw.id)!==String(doc.workOrderId))throw new Error("Source identity mismatch");
     if(!candidates.some(c=>c.shopId===shop.shopId&&c.roId===String(raw.id)))candidates.push({shopId:shop.shopId,providerShopId:Number(shop.tekmetric.shopId),roId:String(raw.id),invoice:invoice.invoice,location:invoice.location});
    }
   }
  }
  await writeFile(`${dir}/plan.json`,JSON.stringify({candidates,cap:1000,scope:"August 1–31 2026, HEART; CSV-anchored tire candidates, not certified complete"},null,2),{mode:0o600});
  console.log(JSON.stringify({candidateInvoices:candidates.length,byShop:shops.map(s=>({shopId:s.shopId,count:candidates.filter(c=>c.shopId===s.shopId).length}))}));
  if(!process.argv.includes("--execute"))return;
  if(candidates.length>1000)throw new Error("Recovery exceeds 1000-invoice cap; no requests made");
  const result=emptyTireResult(validateTireDefinition({dateRange:{start:"2026-08-01",end:"2026-08-31"},locationIds:shops.map(s=>s.shopId)}),shops.map(s=>({shopId:s.shopId,name:s.locationIdentifier})));
  tireCoverageGap(result,"CSV-anchored candidate recovery only: missing raw invoices, ambiguous copies, omitted tire metadata, and unrecognized statuses can leave coverage incomplete. Export is CDT; report dates are UTC.");
  const outcomes:any[]=[];
  for(const c of candidates){
   const path=`${dir}/${c.shopId}-${c.roId}.json`;
   let saved:any;
   try{saved=JSON.parse(await readFile(path,"utf8"));}catch(e:any){if(e.code!=="ENOENT")throw e;}
   if(!saved){
    const liveShop=await db.collection("shops").findOne({shopId:{$in:[c.shopId,String(c.shopId)]}},{projection:{"tekmetric.shopId":1,integrationProvider:1},maxTimeMS:3000});
    const currentEnterprise=await db.collection("enterprise_accounts").findOne({_id:enterprise._id},{projection:{shopIds:1},maxTimeMS:3000});
    if(!currentEnterprise?.shopIds.includes(c.shopId)||Number(liveShop?.tekmetric?.shopId)!==c.providerShopId||(liveShop?.integrationProvider&&liveShop.integrationProvider!=="tekmetric"))throw new Error("Scope changed");
    const token=await db.collection("tekmetric_tokens").findOne({tokenKey:"current"},{projection:{accessToken:1,expiresAt:1},maxTimeMS:3000});
    if(!token?.accessToken||Date.parse(token.expiresAt)<Date.now()+60000)throw new Error("No fresh token; stopped without refresh");
    await new Promise(r=>setTimeout(r,1100));
    if(shared)await waitForRecoverySlot(()=>acquireSharedTekmetricSlot({priority:"background",bucketPrefix:"tek",dbOverride:budgetDb}));
    if(Date.parse(token.expiresAt)<Date.now()+20000)throw new Error("No fresh token after budget wait; no provider call made");
    // Persist attempt after acquiring capacity, immediately before HTTP.
    const reviewedRetry=process.argv.includes(`--reviewed-retry=${c.shopId}:${c.roId}`);
    await writeFile(`${dir}/${c.shopId}-${c.roId}${reviewedRetry?".manual":""}.attempt`,new Date().toISOString(),{flag:"wx",mode:0o600});
    const response=await fetch(`https://shop.tekmetric.com/api/v1/repair-orders/${c.roId}`,{headers:{Authorization:`Bearer ${token.accessToken}`,Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(15000)});
    if(!response.ok){await response.body?.cancel();throw new Error(`Provider HTTP ${response.status}; stopped, no retry`);}
    const reader=response.body!.getReader();const chunks:Uint8Array[]=[];let length=0;
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>3000000){await reader.cancel();throw new Error("Response exceeds cap");}chunks.push(value);}
    const raw=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(String(raw.id)!==c.roId||raw.shopId!==c.providerShopId||String(raw.repairOrderNumber)!==c.invoice)throw new Error("Provider identity mismatch");
    // Keep only reporting/financial fields: never retain customer/contact payloads or notes.
    const pick=(obj:any,keys:string[])=>Object.fromEntries(keys.filter(k=>obj[k]!==undefined).map(k=>[k,obj[k]]));
    const data=pick(raw,["id","shopId","repairOrderNumber","repairOrderStatus","postedDate","updatedDate","deletedDate","milesIn","milesOut",...Object.values(money)]);
    data.jobs=(raw.jobs||[]).map((j:any)=>({...pick(j,["id","authorized","archived","deletedDate","status"]),parts:(j.parts||[]).map((p:any)=>pick(p,["id","name","description","brand","partType","quantity","width","ratio","diameter","dotNumbers","deletedDate","archived","authorized","status"]))}));
    const source=expected.find((r:any)=>r.location===c.location&&r.invoice===c.invoice);
    saved={...c,fetchedAt:new Date().toISOString(),data,financialDifferences:Object.entries(money).filter(([csv,key])=>raw[key]!==source.amounts[csv]).map(([csv])=>csv)};
    await writeFile(path,JSON.stringify(saved),{mode:0o600});
   }
   extractTireInvoice(result,c.shopId,{workOrderId:c.roId,data:saved.data});
   outcomes.push({shopId:c.shopId,invoice:c.invoice,financialDifferences:saved.financialDifferences,dotEntries:saved.data.jobs.reduce((n:number,j:any)=>n+j.parts.reduce((m:number,p:any)=>m+(Array.isArray(p.dotNumbers)?p.dotNumbers.length:0),0),0)});
   result.generatedAt=new Date().toISOString();
   await writeFile(`${dir}/result.json`,JSON.stringify(result),{mode:0o600});
   await writeFile(`${dir}/outcomes.json`,JSON.stringify(outcomes),{mode:0o600});
   if(outcomes.length%25===0)console.log(JSON.stringify({recovered:outcomes.length,total:candidates.length,dotEntries:result.counts.dotEntries}));
  }
  for(const view of ["details","invoices"] as const)await writeFile(`${dir}/${view}.csv`,tireCsv(result,view),{mode:0o600});
  console.log(JSON.stringify({completed:outcomes.length,counts:result.counts,coverage:result.coverage}));
 }finally{await client.close();}
}
main().catch(e=>{console.error(/^(Recovery exceeds|Provider HTTP|Provider identity|Scope changed|No fresh token|Response exceeds|Source identity|Provider changed|Missing membership|Shared budget)/.test(e.message||"")?e.message:(e.code||e.name),"Recovery stopped; inspect local checkpoints before any retry.");process.exitCode=1;});
