/** Bounded stored-only audit. No provider imports or production mutations. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import postgres from "postgres";
import {MongoClient} from "mongodb";
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
    connection:{default_transaction_read_only:true,statement_timeout:10000},onnotice:()=>{}});
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
