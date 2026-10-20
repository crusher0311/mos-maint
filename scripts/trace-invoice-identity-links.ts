/** Bounded stored-only audit. No provider imports or production mutations. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import postgres from "../lib/invoice-repair/postgres-client";
import {MongoClient} from "../lib/invoice-repair/mongo-client";
const hash=(v:unknown)=>createHash("sha256").update(String(v)).digest("hex");
const targets=new Map([
  [227,["24e7e83c1d","519710e3d6","78921649","b24a68b2","cf68e0e8"]],
  [229,["89aa0365","cf298a65","d3f8c3d8"]],
  [230,["522c77c0","8c364d15"]],
]);
const sourceIds=(p:any)=>(p?.sourceIds??[]).filter((s:any)=>s.system==="protractor"&&
  ["invoice_id","work_order_id"].includes(s.idType));
function describe(raw:any,shop:number) {
  if(!raw)return {present:false};
  const number=(v:any)=>v==null?null:hash(`${shop}:${String(v)}`);
  return {present:true,idHash:hash(String(raw.ID??"").toLowerCase()),
    workOrderNumberHash:number(raw.WorkOrderNumber),invoiceNumberHash:number(raw.InvoiceNumber),
    workOrderNumberZero:[0,"0"].includes(raw.WorkOrderNumber),
    invoiceNumberZero:[0,"0"].includes(raw.InvoiceNumber),
    stage:/^[a-z ]+$/i.test(raw.WorkflowStage??"")?raw.WorkflowStage:null,
    invoiceTime:raw.InvoiceTime,modified:raw.Header?.LastModifiedTime};
}
async function main() {
  const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
    connection:{default_transaction_read_only:true,statement_timeout:5000,lock_timeout:1000},onnotice:()=>{}});
  const mongo=new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,{serverSelectionTimeoutMS:10000});
  try {
    await mongo.connect();
    const db=mongo.db("mos-maintenance-mvp");
    assert.equal((await db.collection("enterprise_accounts").findOne({shopIds:227},
      {projection:{name:1},maxTimeMS:5000}))?.name,"JWT");
    let count=0;
    for(const [shop,prefixes] of targets) {
      const selected=await pg.begin("isolation level repeatable read read only",async sql=>{
        const rows=await sql.unsafe("SELECT id FROM normalized_work_orders WHERE shop_id=$1 LIMIT 100001",[shop]);
        assert.ok(rows.length<=100000);
        const ids=rows.filter(r=>prefixes.some(p=>hash(`${shop}:${r.id}`).startsWith(p))).map(r=>r.id);
        assert.equal(ids.length,prefixes.length,"Expected every previously identified target");
        return sql.unsafe(`SELECT id,work_order_number,provenance,raw_data->'rawPayload' raw
          FROM normalized_work_orders WHERE shop_id=$1 AND id=ANY($2::text[])`,[shop,ids]);
      });
      for(const row of selected) {
        const ids=sourceIds(row.provenance),values=ids.map((s:any)=>String(s.idValue).toLowerCase());
        const keys=[...new Set(values.flatMap((s:string)=>[s,s.toUpperCase()]))];
        const copies=await db.collection("normalized_work_orders").find(
          {shopId:{$in:[shop,String(shop)]},"provenance.sourceSystem":"protractor",
            "provenance.sourceIds.idValue":{$in:keys}},
          {projection:{workOrderNumber:1,provenance:1,rawPayload:1},maxTimeMS:5000})
          .hint("unique_shop_source_idValue").limit(101).toArray();
        assert.ok(copies.length<101);
        if(process.argv.includes("--repair-preview")){
          const list=(v:any):any[]=>Array.isArray(v)?v:Array.isArray(v?.ItemCollection)?v.ItemCollection:[];
          const owners=new Map<string,Set<string>>();
          const bind=(kind:string,id:any,owner:string)=>{
            if(!id)return;const key=`${kind}:${String(id).toLowerCase()}`;
            owners.set(key,new Set([...(owners.get(key)??[]),owner]));
          };
          // Stored mirrors are evidence, not complete provider history.
          for(const copy of copies){
            const raw:any=copy.rawPayload;if(!raw?.ID)continue;
            const owner=hash(String(raw.ID).toLowerCase());
            for(const job of [...list(raw.ServicePackages),...list(raw.DeferredServicePackages)]){
              bind("service_job_id",job.ID,owner);
              for(const line of list(job.ServicePackageLines))bind("line_item_id",line.ID,owner);
            }
            for(const payment of list(raw.Payments))bind("payment_id",payment.ID,owner);
          }
          const details:any[]=[];
          const candidateParents:any[]=[];
          await pg.begin("isolation level repeatable read read only",async sql=>{
            for(const copy of copies){
              const raw:any=copy.rawPayload;
              if(!raw?.ID||!raw.WorkOrderNumber)continue;
              const matches=await sql.unsafe(`SELECT id,provenance FROM normalized_work_orders
                WHERE shop_id=$1 AND work_order_number=$2 LIMIT 3`,[shop,String(raw.WorkOrderNumber)]);
              candidateParents.push({providerIdHash:hash(String(raw.ID).toLowerCase()),
                workOrderNumberHash:hash(`${shop}:${raw.WorkOrderNumber}`),
                existingOwners:matches.map(m=>({record:hash(`${shop}:${m.id}`),isCurrent:m.id===row.id,
                  providerIds:sourceIds(m.provenance).map((s:any)=>hash(String(s.idValue).toLowerCase()))}))});
            }
            const jobOwners=new Map<string,string>();
            for(const [table,kind] of [
              ["normalized_service_jobs","service_job_id"],
              ["normalized_line_items","line_item_id"],
              ["normalized_payments","payment_id"],
            ]){
              const children=await sql.unsafe(`SELECT id,provenance${kind==="line_item_id"?",service_job_id":""} FROM ${table}
                WHERE shop_id=$1 AND work_order_id=$2 LIMIT 5001`,[shop,row.id]);
              assert.ok(children.length<=5000,"Child preview cap reached");
              const grouped:Record<string,number>={};
              let mismatchedJobLinks=0;
              for(const child of children){
                const refs=(child.provenance?.sourceIds??[]).filter((s:any)=>s.system==="protractor"&&s.idType===kind);
                const candidates=new Set<string>();
                let missing=refs.length===0;
                for(const ref of refs){
                  const matches=owners.get(`${kind}:${String(ref.idValue).toLowerCase()}`);
                  if(!matches?.size)missing=true;
                  for(const owner of matches??[])candidates.add(owner);
                }
                const assignment=missing?"unverified":candidates.size===1?[...candidates][0]:"ambiguous";
                if(kind==="service_job_id")jobOwners.set(child.id,assignment);
                if(kind==="line_item_id"&&jobOwners.get(child.service_job_id)!==assignment)mismatchedJobLinks++;
                grouped[assignment]=(grouped[assignment]??0)+1;
              }
              details.push({table,rows:children.length,provisionalOwners:grouped,mismatchedJobLinks});
            }
          });
          console.log(JSON.stringify({event:"repair_preview",shop,record:hash(`${shop}:${row.id}`),
            disposition:"hold_no_write_plan",reason:"Parent and dependent ownership require full archived-source and FK review",
            candidateParents,children:details,productionWrites:0,providerRequests:0}));
        }
        console.log(JSON.stringify({event:"identity_link",record:hash(`${shop}:${row.id}`),shop,
          normalizedNumberHash:hash(`${shop}:${row.work_order_number}`),
          sourceIds:ids.map((s:any)=>({type:s.idType,idHash:hash(String(s.idValue).toLowerCase()),primary:s.isPrimary})),
          pg:describe(row.raw,shop),mirrors:copies.map(d=>({
            normalizedNumberHash:hash(`${shop}:${d.workOrderNumber}`),
            sourceIds:sourceIds(d.provenance).map((s:any)=>({type:s.idType,idHash:hash(String(s.idValue).toLowerCase()),primary:s.isPrimary})),
            raw:describe(d.rawPayload,shop)}))}));
        count++;
      }
    }
    assert.equal(count,10);
    console.log(JSON.stringify({event:"identity_trace_complete",records:count,productionWrites:0,providerRequests:0}));
  } finally {await mongo.close();await pg.end();}
}
main().catch(e=>{console.error(JSON.stringify({event:"identity_trace_failed",
  code:/^[A-Z0-9]{1,8}$/.test(String(e?.code))?e.code:"UNCLASSIFIED"}));process.exitCode=1;});
