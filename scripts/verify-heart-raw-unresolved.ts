/** Direct raw lookup, without normalized-record gating. Read-only, bounded. */
import { MongoClient } from "mongodb";
import { readFile, writeFile } from "node:fs/promises";
import { validateTireDefinition } from "../lib/tire-dot-report";
const range = validateTireDefinition({dateRange:{start:process.argv[2] || "2026-10-01",end:process.argv[3] || "2026-10-20"},locationIds:[1]}).dateRange;
const dir = process.argv[2] ? `generated-artifacts/heart-tire-dot-validation/${range.start}_${range.end}` : "generated-artifacts/heart-tire-dot-validation";
async function main() {
  const baseline = JSON.parse(await readFile(`${dir}/sales-comparison.json`, "utf8"));
  const expected = JSON.parse(await readFile(`${dir}/export-input.json`, "utf8"));
  const unresolved = baseline.comparisons.filter((r:any)=>r.status !== "matched");
  const client = new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`, {maxPoolSize:1,serverSelectionTimeoutMS:10000});
  const results:any[] = [], diagnostics:any[] = [];
  try {
    await client.connect();
    const db=client.db("mos-maintenance-mvp");
    const enterprise=await db.collection("enterprise_accounts").findOne({name:"HEART Certified Auto Care"},{projection:{shopIds:1},maxTimeMS:3000});
    for(const shopId of [...new Set<number>(unresolved.map((r:any)=>r.shopId))]) {
      if(!enterprise?.shopIds.includes(shopId))throw new Error("Current enterprise membership changed");
      const invoices=unresolved.filter((r:any)=>r.shopId===shopId).map((r:any)=>r.invoice);
      const variants=invoices.flatMap((n:string)=>[n,Number(n)]);
      const status:any={shopId,requested:invoices.length,found:0,completed:false};
      diagnostics.push(status);
      const cursor=db.collection("tekmetric_work_orders").find({shopId:{$in:[shopId,String(shopId)]},$or:[
        {"data.repairOrderNumber":{$in:variants}}, {workOrderNumber:{$in:variants}}, {repairOrderNumber:{$in:variants}},
      ]},{projection:{workOrderId:1,workOrderNumber:1,repairOrderNumber:1,status:1,
        "data.id":1,"data.repairOrderNumber":1,"data.postedDate":1,"data.repairOrderStatus":1,
        "data.laborSales":1,"data.partsSales":1,"data.subletSales":1,"data.feeTotal":1,"data.discountTotal":1,"data.taxes":1,"data.totalSales":1,
        "data.jobs.parts.dotNumbers":1},maxTimeMS:10000})
        .hint("shopId_workOrderId").sort({workOrderId:-1}).limit(150).batchSize(1);
      try {
        for await (const doc of cursor) {
          const number=String(doc.data?.repairOrderNumber??doc.workOrderNumber??doc.repairOrderNumber);
          const prior=unresolved.find((r:any)=>r.shopId===shopId&&r.invoice===number);
          if(!prior)continue;
          const reference=expected.find((r:any)=>r.location===prior.location&&r.invoice===number);
          const fields:Record<string,string>={"Labor Sales":"laborSales","Parts sales":"partsSales","Sublet Sales":"subletSales","Fees":"feeTotal","Discounts":"discountTotal","Tax Collected":"taxes","Total Sales":"totalSales"};
          const differences=Object.entries(fields).filter(([csv,k])=>doc.data?.[k]!==reference.amounts[csv]).map(([csv])=>csv);
          results.push({shopId,invoice:number,providerRoId:String(doc.workOrderId),rawInvoiceNumber:doc.data?.repairOrderNumber,
            differences,exportTotalCents:prior.exportTotalCents,storedTotalCents:doc.data?.totalSales,
            dotEntries:(doc.data?.jobs||[]).reduce((n:number,j:any)=>n+(j.parts||[]).reduce((a:number,p:any)=>a+(Array.isArray(p.dotNumbers)?p.dotNumbers.length:0),0),0)});
          status.found++;
        }
        status.completed=status.found<150;
      }catch(e:any){status.errorCode=e.code||e.name;}
      finally{await cursor.close();}
      await writeFile(`${dir}/direct-raw-unresolved.json`,JSON.stringify({diagnostics,results},null,2),{mode:0o600});
      console.log(JSON.stringify(status));
    }
    console.log(JSON.stringify({foundRows:results.length,uniqueInvoices:new Set(results.map(r=>`${r.shopId}:${r.invoice}`)).size,
      amountMatches:results.filter(r=>!r.differences.length).length,dotEntries:results.reduce((n,r)=>n+r.dotEntries,0)}));
  }finally{await client.close();}
}
main().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});
