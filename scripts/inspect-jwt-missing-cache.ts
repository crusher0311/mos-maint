import { readFileSync } from "node:fs";
import { getDb, getMongoClient } from "../lib/mongo";
async function main() {
  const sample=(JSON.parse(readFileSync("/tmp/jwt-701-identity-diff.json","utf8")) as {wo:string;invoice:string;date:string;classification:string}[])
    .filter(r=>r.classification!=="included");
  const db=await getDb();
  try {
    const numbers=sample.flatMap(r=>[Number(r.wo),r.wo,Number(r.invoice),r.invoice]);
    const rows=await db.collection("protractor_work_orders").find(
      {shopId:227, $or:[
        {workOrderNumber:{$in:numbers}}, {"data.WorkOrderNumber":{$in:numbers}},
        {"rawPayload.WorkOrderNumber":{$in:numbers}},
      ]},
      {projection:{workOrderNumber:1,status:1,completed:1,fetchedAt:1,
        "rawPayload.InvoiceTime":1,"rawPayload.Type":1,"rawPayload.WorkOrderNumber":1,
        "rawPayload.InvoiceNumber":1, "data.WorkOrderNumber":1,
        "data.InvoiceTime":1,"data.Type":1},maxTimeMS:5000}
    ).limit(1001).toArray();
    if(rows.length>1000) throw new Error("Cache identity row cap exceeded");
    const matches=(n:typeof sample[number])=>rows.filter(r=>
      [r.workOrderNumber,r.rawPayload?.WorkOrderNumber,r.data?.WorkOrderNumber].some(v=>String(v)===n.wo));
    console.log(JSON.stringify({sampled:sample.length,cacheMatches:rows.length,
      dates: sample.map(n=>({nativeDate:n.date,classification:n.classification,
        matchedByWorkOrder:matches(n).length>0,
        records:matches(n).map(r=>({status:r.status,completed:r.completed,
          fetchedAt:r.fetchedAt,invoiceTime:r.rawPayload?.InvoiceTime??r.data?.InvoiceTime,
          type:r.rawPayload?.Type??r.data?.Type}))}))},null,2));
  } finally { await (await getMongoClient()).close(); }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
