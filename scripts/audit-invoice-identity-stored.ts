/**
 * Read-only header audit. No provider imports, raw customer fields, repairs or
 * alternate invoice-number fabrication. Counts are stored records, not invoices.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MongoClient } from "../lib/invoice-repair/mongo-client";
import postgres from "../lib/invoice-repair/postgres-client";
import { invoiceHoursEvidence } from "../lib/invoice-hours-contract";

const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
const vocabulary=(v:unknown)=>typeof v==="string"&&/^[A-Za-z][A-Za-z _-]{0,39}$/.test(v)?v:"missing_or_other";
const numberKind=(v:unknown)=>v===0||v==="0"?"zero":
  (typeof v==="number"||typeof v==="string")&&Number(v)>0?"positive":"missing_or_invalid";
let stage="connect";
async function main() {
  const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{
    max:1,connect_timeout:10,onnotice:()=>{},
    connection:{default_transaction_read_only:true,statement_timeout:10000,application_name:"invoice_identity_readonly_audit"},
  });
  const mongo=new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,{serverSelectionTimeoutMS:10000});
  try {
    await mongo.connect();
    const db=mongo.db("mos-maintenance-mvp");
    const enterprise=await db.collection("enterprise_accounts").findOne({shopIds:227},{projection:{name:1,shopIds:1},maxTimeMS:5000});
    assert.equal(enterprise?.name,"JWT");
    const shops=[...new Set((enterprise!.shopIds as number[]).map(Number))].sort((a,b)=>a-b);
    assert.deepEqual(shops,[227,228,229,230,231,232,233,234,235,236]);
    const groups=new Map<string,number>();
    const count=(key:object)=>{const k=JSON.stringify(key);groups.set(k,(groups.get(k)??0)+1);};
    const cutoff=new Date();
    let total=0,pages=0;
    for(const shop of shops) {
      stage="archive";
      const verified=new Map<string,Set<string>>();
      let shopPages=0;
      for(const campaign of ["protractor-weekend-2026-10-17","invoice-evidence-recovery-2026-10-17"]) {
        const prefix=`${campaign}:${shop}:`;
        const cursor=db.collection<any>("operator_history_import_pages").find(
          {_id:{$gte:prefix,$lt:`${campaign}:${shop};`},capturedAt:{$lte:cutoff}},
          {projection:{shopId:1,invoices:1,digest:1},maxTimeMS:10000}).sort({_id:1}).batchSize(10);
        for await(const page of cursor) {
          assert.ok(++shopPages<=2000);
          pages++;
          assert.equal(page.shopId,shop);
          assert.ok(Array.isArray(page.invoices)&&page.invoices.length<=100);
          assert.equal(hash(JSON.stringify(page.invoices)),page.digest);
          for(const raw of page.invoices) {
            const e=invoiceHoursEvidence(raw);
            count({source:"capture_archive",type:vocabulary(raw.Type),stage:vocabulary(raw.WorkflowStage),
              number:numberKind(raw.InvoiceNumber),strictEvidence:!!e});
            if(e) {
              const key=hash(e.id);
              const dates=verified.get(key)??new Set<string>();
              dates.add(e.date);verified.set(key,dates);
            }
          }
        }
      }
      stage="headers";
      await pg.begin("isolation level repeatable read read only",async sql=>{
        assert.equal((await sql.unsafe("SHOW transaction_read_only"))[0].transaction_read_only,"on");
        const ids=await sql.unsafe("SELECT id FROM normalized_work_orders WHERE shop_id=$1",[shop]);
        assert.ok(ids.length<=100000);
        for(let offset=0;offset<ids.length;offset+=250) {
          const rows=await sql.unsafe(`SELECT provenance->>'sourceSystem' provider,
            provenance->'sourceIds' source_ids,
            (SELECT jsonb_object_agg(key,value) FROM jsonb_each(
              CASE WHEN jsonb_typeof(raw_data->'rawPayload')='object' THEN raw_data->'rawPayload' ELSE '{}'::jsonb END)
              WHERE key IN ('ID','Type','WorkflowStage','Status','InvoiceNumber','InvoiceTime',
                'WorkOrderNumber','InvoiceNo','InvoiceID','InvoiceId')) raw
            FROM normalized_work_orders WHERE shop_id=$1 AND id=ANY($2::text[])`,
            [shop,ids.slice(offset,offset+250).map(r=>r.id)]);
          for(const row of rows) {
            assert.ok(++total<=500000);
            if(row.provider!=="protractor")continue;
            const r=row.raw??{};
            const stamp=typeof r.InvoiceTime==="string"?r.InvoiceTime:"";
            const d=new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(stamp)?stamp:stamp+"Z");
            const validDate=Number.isFinite(+d)&&d.getUTCFullYear()>=1900;
            const dates=verified.get(hash(String(r.ID??"").toLowerCase()));
            const sourceIds=Array.isArray(row.source_ids)?row.source_ids:[];
            const bound=sourceIds.some((s:any)=>s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType)&&
              String(s.idValue).toLowerCase()===String(r.ID??"").toLowerCase());
            count({source:"normalized_raw",type:vocabulary(r.Type),stage:vocabulary(r.WorkflowStage),
              status:vocabulary(r.Status),number:numberKind(r.InvoiceNumber),
              date:validDate?"recorded":"missing_or_sentinel",
              dateScope:validDate?(+d>=Date.parse("2026-09-18T00:00:00Z")&&+d<Date.parse("2026-10-18T00:00:00Z")?"report_period":"outside_report_period"):"unknown",
              identityBound:bound,
              archivedPositiveInvoice:!dates?"none":dates.size!==1?"conflicting_dates":
                validDate&&dates.has(d.toISOString())?"same_identity_and_date":"different_date",
              readableRo:numberKind(r.WorkOrderNumber),
              alternateInvoiceNumber:numberKind(r.InvoiceNo),
            });
          }
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      });
      console.log(JSON.stringify({event:"identity_audit_shop",shop,total,pages}));
    }
    console.log(JSON.stringify({event:"identity_audit_complete",total,pages,productionWrites:0,providerRequests:0,
      groups:[...groups].map(([key,records])=>({...JSON.parse(key),records})).sort((a,b)=>b.records-a.records)}));
  } finally {await pg.end();await mongo.close();}
}
main().catch(e=>{console.error(JSON.stringify({event:"identity_audit_failed",stage,
  code:/^[A-Z0-9]{1,8}$/.test(String(e?.code))?String(e.code):"UNCLASSIFIED"}));process.exitCode=1;});
