/** Read-only retained evidence capture. No app boot, provider client or apply path.
 * Private raw payloads stay in memory; output contains hashes and financial fields only.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import postgres from "../lib/invoice-repair/postgres-client";
import {MongoClient} from "../lib/invoice-repair/mongo-client";
import {planOwnerStructure} from "./invoice-owner-repair-model";
import {reconcileOwnerCopies} from "./invoice-owner-report-model";
import {retainedArchives} from "./invoice-owner-retained-sources";
import {collectChildEvidence,auditChild,childKinds} from "./invoice-owner-financial-audit";
import {getProtractorPackageLines} from "../lib/integrations/protractor/package-normalization";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
// Explicit allowlist: no customer, vehicle, descriptions, notes, IDs or credentials.
const numericKeys=["Quantity","quantity","Price","UnitPrice","unitPrice","ExtendedTotal","ExtendedPrice",
  "extendedPrice","Total","total","Rate","LaborRate","laborRate","Hours","EstimatedHours","ActualHours",
  "BilledHours","LaborHours","laborHours","Cost","UnitCost","TotalCost","ExtendedCost","VendorCost",
  "CoreCharge","Discount","DiscountAmount","DiscountPercent","TaxRate","TaxAmount","LaborTotal",
  "PartsTotal","SubletTotal","FeesTotal","DiscountTotal","Amount","TipAmount","RefundedAmount",
  "SellPrice","SellTotal","SellSubtotal","BuyPrice","BuyTotal","Labor","Parts","ShopSupplies",
  "GrandTotal","TotalAmount","Subtotal"];
function native(raw:any):any{
  const result:any={};
  for(const k of numericKeys)if(Object.hasOwn(raw,k)){
    const v=raw[k];
    result[k]=v==null||v===""?null:
      (typeof v==="number"||typeof v==="string")&&Number.isFinite(Number(v))?String(v):"invalid";
  }
  if(raw.PriceSummary)result.PriceSummary=native(raw.PriceSummary);
  const lines=getProtractorPackageLines(raw);
  if(lines.length)result.lines=lines.map(native);
  for(const k of ["Type","LineType"])if(typeof raw[k]==="string")
    result[k]=["labor","part","material","sublet","fee","discount","other"].includes(raw[k].toLowerCase())?raw[k].toLowerCase():"other";
  return result;
}
async function main(){
  const snapshot=JSON.parse(readFileSync("/tmp/invoice-owner-closure.json","utf8"));
  const plan=planOwnerStructure(snapshot);
  assert.equal(snapshot.nodes.length,26);assert.equal(plan.parents.length,36);assert.equal(plan.children.length,329);
  assert.deepEqual(snapshot.foreignKeys.map((f:any)=>String(f.child).replace(/^public\./,"")).sort(),Object.keys(childKinds).sort());
  const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:8,
    connection:{default_transaction_read_only:true,statement_timeout:5000},onnotice:()=>{}});
  const mongo=new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,{serverSelectionTimeoutMS:10000});
  const result:any={version:1,cutoff:new Date().toISOString(),owners:[],children:[],productionWrites:0,providerRequests:0};
  try{
    await mongo.connect();const db=mongo.db("mos-maintenance-mvp");
    const archives=new Map<number,Map<string,any[]>>();
    for(const shop of [227,229,230])archives.set(shop,await retainedArchives(db,shop,new Date(result.cutoff)));
    await pg.begin("isolation level repeatable read read only",async transaction=>{
      const sql=transaction as unknown as typeof pg;
      [result.snapshot]=await sql`select transaction_timestamp()::text captured_at,pg_current_snapshot()::text snapshot`;
      for(const shop of [227,229,230]){
        const ids=await sql`select id from normalized_work_orders where shop_id=${shop} limit 100001`;
        assert.ok(ids.length<=100000);
        const nodes=snapshot.nodes.filter((n:any)=>n.shop===shop);
        const selected=ids.filter(r=>nodes.some((n:any)=>n.record===hash(`${shop}:${r.id}`)));
        assert.equal(selected.length,nodes.length);
        for(const {id} of selected){
          const node=nodes.find((n:any)=>n.record===hash(`${shop}:${id}`));
          const [row]=await sql`select work_order_number,provenance,raw_data->'rawPayload' raw from normalized_work_orders where shop_id=${shop} and id=${id}`;
          assert.equal(hash(`${shop}:${row.work_order_number}`),node.number);
          const refs=[...new Set<string>(row.provenance.sourceIds.filter((s:any)=>s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType)).map((s:any)=>String(s.idValue).toLowerCase()))];
          assert.deepEqual(refs.map(s=>hash(`${shop}:${s}`)).sort(),[...node.sourceIds].sort());
          const keys=[...new Set(refs.flatMap(s=>[s,s.toUpperCase()]))];
          const mirror=await db.collection("normalized_work_orders").find({shopId:{$in:[shop,String(shop)]},
            "provenance.sourceSystem":"protractor","provenance.sourceIds.idValue":{$in:keys}},
            {projection:{rawPayload:1},maxTimeMS:5000}).hint("unique_shop_source_idValue").limit(101).toArray();
          const cache=await db.collection("protractor_work_orders").find({shopId:{$in:[shop,String(shop)]},workOrderId:{$in:keys}},
            {projection:{rawPayload:1},maxTimeMS:5000}).hint("protractor_wo_shop_work_order").limit(101).toArray();
          assert.ok(mirror.length<101&&cache.length<101);
          const copies=[{channel:"postgres",raw:row.raw},...mirror.map(c=>({channel:"mirror",raw:c.rawPayload})),
            ...cache.map(c=>({channel:"cache",raw:c.rawPayload})),...refs.flatMap(s=>(archives.get(shop)!.get(s)??[]).map(raw=>({channel:"archive",raw})))].filter(c=>c.raw);
          const raws=copies.map(c=>c.raw);
          assert.ok(raws.every(r=>refs.includes(String(r.ID).toLowerCase())));
          const evidence=collectChildEvidence(raws,shop);
          for(const ownerId of refs){
            const owner=hash(`${shop}:${ownerId}`),bound=raws.filter(r=>String(r.ID).toLowerCase()===ownerId);
            const desired=plan.parents.find(p=>p.owner===owner)!;
            assert.ok(bound.every(r=>hash(`${shop}:${r.WorkOrderNumber}`)===desired.number));
            const reconciled=reconcileOwnerCopies(ownerId,raws);
            result.owners.push({shop,owner,parent:node.record,reason:reconciled.reason,
              copies:copies.filter(c=>String(c.raw.ID).toLowerCase()===ownerId).map(c=>({
                channel:c.channel,digest:hash(JSON.stringify(c.raw)),
                date:c.raw.InvoiceTime??null,positiveInvoiceNumber:Number(c.raw.InvoiceNumber)>0,
              }))});
          }
          const childRows=new Map<string,any[]>();
          for(const table of Object.keys(childKinds)){
            const rows=await sql.unsafe(`select * from ${table} where shop_id=$1 and work_order_id=$2 limit 5001`,[shop,id]);
            assert.ok(rows.length<=5000);
            assert.equal(rows.length,plan.children.filter((c:any)=>c.parent===node.record&&c.table===table).length);
            childRows.set(table,rows);
          }
          for(const [table,rows] of childRows)for(const child of rows){
            const expected=plan.children.find((c:any)=>c.table===table&&c.id===hash(`${shop}:${child.id}`))!;
            assert.ok(expected);
            const {work_order_id,service_job_id,...immutable}=child;
            assert.equal(hash(JSON.stringify(immutable)),expected.immutableHash);
            const refs=child.provenance.sourceIds.filter((s:any)=>s.system==="protractor"&&s.idType===childKinds[table]);
            const matches=refs.flatMap((s:any)=>evidence.get(`${table}:${String(s.idValue).toLowerCase()}`)??[]);
            let sourceJobLink=true;
            if(table==="normalized_line_items"){
              const job=childRows.get("normalized_service_jobs")!.find(j=>j.id===service_job_id);
              const jobRefs=job?.provenance.sourceIds.filter((s:any)=>s.system==="protractor"&&s.idType==="service_job_id").map((s:any)=>String(s.idValue).toLowerCase())??[];
              sourceJobLink=matches.every((m:any)=>m.job!==null&&jobRefs.includes(m.job));
            }
            result.children.push({table,id:expected.id,owner:expected.owner,sourceJobLink,
              ...auditChild(table,child,expected.owner,evidence),
              matches:matches.map((m:any)=>({copy:m.copy,owner:m.owner,values:m.values,native:native(m.native)}))});
          }
        }
      }
    });
    assert.equal(result.owners.length,36);assert.equal(result.children.length,329);
    writeFileSync(process.argv[2]??"/tmp/invoice-owner-financial-evidence.json",JSON.stringify(result,null,2),{mode:0o600,flag:"wx"});
    console.log(JSON.stringify({event:"financial_evidence_captured",owners:36,children:329,snapshot:result.snapshot,productionWrites:0,providerRequests:0}));
  }finally{await mongo.close();await pg.end();}
}
main().catch(()=>{console.error("Financial evidence capture failed; no repair is authorized.");process.exitCode=1;});
