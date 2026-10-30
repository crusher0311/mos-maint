/** Read-only CSV-anchored evidence comparison; no provider calls or DB writes. */
import { MongoClient } from "mongodb";
import { readFile, writeFile } from "node:fs/promises";
import { emptyTireResult, extractTireInvoice, validateTireDefinition, tireCoverageGap, tireCsv } from "../lib/tire-dot-report";
const start = process.argv[2] || "2026-10-01", end = process.argv[3] || "2026-10-20";
const validatedRange = validateTireDefinition({dateRange:{start,end},locationIds:[1]}).dateRange;
const out = process.argv[2] ? `generated-artifacts/heart-tire-dot-validation/${start}_${end}` : "generated-artifacts/heart-tire-dot-validation";
const fields: Record<string,string> = { "Labor Sales":"laborSales","Parts sales":"partsSales","Sublet Sales":"subletSales","Fees":"feeTotal","Discounts":"discountTotal","Tax Collected":"taxes","Total Sales":"totalSales" };
async function main() {
  const input = JSON.parse(await readFile(`${out}/export-input.json`, "utf8"));
  const client = new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`, { maxPoolSize:1, serverSelectionTimeoutMS:10000 });
  const comparisons: any[] = [], diagnostics: any[] = [];
  try {
    await client.connect();
    const db = client.db("mos-maintenance-mvp");
    const e = await db.collection("enterprise_accounts").findOne({name:"HEART Certified Auto Care"},{projection:{shopIds:1},maxTimeMS:3000});
    if (!e) throw new Error("Enterprise unavailable");
    const shops = await db.collection("shops").find({shopId:{$in:e.shopIds}},{projection:{shopId:1,name:1,locationIdentifier:1},maxTimeMS:3000}).limit(100).toArray();
    const definition=validateTireDefinition({dateRange:validatedRange,locationIds:e.shopIds});
    const result=emptyTireResult(definition,shops.map(s=>({shopId:s.shopId,name:s.locationIdentifier})));
    tireCoverageGap(result,"CSV-anchored verification only; not a full upstream coverage audit. CSV uses CDT; report uses inclusive UTC days.");
    for (const location of [...new Set<string>(input.map((r:any)=>r.location))]) {
      const city=location.split(" - ").at(-1)!;
      const matches=shops.filter(s=>String(s.locationIdentifier).toLowerCase().includes(city.toLowerCase()));
      if(matches.length!==1)throw new Error(`Ambiguous location mapping: ${location}`);
      const shop=matches[0], expected=input.filter((r:any)=>r.location===location);
      const candidates=await db.collection("normalized_work_orders").find({
        shopId:{$in:[shop.shopId,String(shop.shopId)]},"provenance.sourceSystem":"tekmetric",
        "provenance.sourceIds.idValue":{$in:expected.flatMap((x:any)=>[x.invoice,Number(x.invoice)])},
      },{projection:{workOrderNumber:1,provenance:1},maxTimeMS:5000}).hint("unique_shop_source_idValue").limit(5001).toArray();
      if(candidates.length>5000)throw new Error("Candidate limit reached");
      const normalized=new Map<string,any[]>();
      for(const n of candidates){const key=String(n.workOrderNumber);normalized.set(key,[...(normalized.get(key)||[]),n]);}
      const identity=new Map<string,string>();
      for(const x of expected){
        const ns=normalized.get(x.invoice)||[];
        const ids=[...new Set(ns.flatMap(n=>(n.provenance?.sourceIds||[]).filter((s:any)=>s.system==="tekmetric"&&s.idType==="repair_order_id").map((s:any)=>String(s.idValue))))];
        if(ids.length===1)identity.set(x.invoice,ids[0] as string);
      }
      const raws=new Map<string,any[]>();
      const ids=[...identity.values()];
      for(let i=0;i<ids.length;i+=40){
        const batch=ids.slice(i,i+40);
        const docs=await db.collection("tekmetric_work_orders").find({shopId:{$in:[shop.shopId,String(shop.shopId)]},workOrderId:{$in:batch.flatMap(id=>[id,Number(id)])}},
          {projection:{shopId:1,workOrderId:1,status:1,deletedDate:1,archivedDate:1,
            "data.id":1,"data.repairOrderNumber":1,"data.postedDate":1,"data.repairOrderStatus":1,"data.deletedDate":1,
            "data.milesIn":1,"data.milesOut":1,"data.laborSales":1,"data.partsSales":1,"data.subletSales":1,"data.feeTotal":1,"data.discountTotal":1,"data.taxes":1,"data.totalSales":1,
            "data.jobs":1},maxTimeMS:5000}).hint("shopId_workOrderId").limit(100).toArray();
        for(const doc of docs){const key=String(doc.workOrderId);raws.set(key,[...(raws.get(key)||[]),doc]);}
      }
      const summary:any={location,shopId:shop.shopId,exportInvoices:expected.length,located:0,amountMatches:0,amountMismatches:0,notLocated:0,statuses:{},rawWithDot:0};
      for(const x of expected){
        const id=identity.get(x.invoice), docs=raws.get(id||"")||[];
        const doc=docs.length===1?docs[0]:null, raw=doc?.data;
        const identified=raw&&String(raw.repairOrderNumber)===x.invoice&&String(raw.id)===id;
        const differences=identified?Object.entries(fields).filter(([csv,key])=>!Number.isSafeInteger(raw[key])||raw[key]!==x.amounts[csv]).map(([csv])=>csv):[];
        const status=!identified?"not_located_or_ambiguous":differences.length?"amount_mismatch":"matched";
        if(identified){
          summary.located++; summary[ differences.length?"amountMismatches":"amountMatches"]++;
          const rs=String(raw.repairOrderStatus?.name??raw.repairOrderStatus); summary.statuses[rs]=(summary.statuses[rs]||0)+1;
          if(raw.jobs?.some((j:any)=>j.parts?.some((p:any)=>p.dotNumbers?.length)))summary.rawWithDot++;
          extractTireInvoice(result,shop.shopId,doc);
        }else summary.notLocated++;
        comparisons.push({location,shopId:shop.shopId,invoice:x.invoice,providerRoId:id||"",status,exportTotalCents:x.amounts["Total Sales"],
          storedTotalCents:identified?raw.totalSales:null, differenceCents:identified&&Number.isSafeInteger(raw.totalSales)?raw.totalSales-x.amounts["Total Sales"]:null,
          differingFields:differences.join("; "),exportPosted:x.posted,storedPosted:identified?raw.postedDate:null});
      }
      diagnostics.push(summary);
      await writeFile(`${out}/sales-comparison.json`,JSON.stringify({diagnostics,comparisons},null,2),{mode:0o600});
      console.log(JSON.stringify(summary));
    }
    result.generatedAt=new Date().toISOString();
    await writeFile(`${out}/verified-tire-result.json`,JSON.stringify(result,null,2),{mode:0o600});
    await writeFile(`${out}/verified-tire-invoices.csv`,tireCsv(result,"invoices"),{mode:0o600});
    const keys=Object.keys(comparisons[0]);
    const cell=(x:any)=>`"${String(x??"").replace(/"/g,'""')}"`;
    await writeFile(`${out}/sales-reconciliation.csv`,"\uFEFF"+[keys,...comparisons.map(row=>keys.map(k=>row[k]))].map(row=>row.map(cell).join(",")).join("\r\n"),{mode:0o600});
    console.log(JSON.stringify({tireCounts:result.counts,coverage:result.coverage}));
  }finally{await client.close();}
}
main().catch(e=>{console.error(e.code||e.name||"Reconciliation failed");process.exitCode=1;});
