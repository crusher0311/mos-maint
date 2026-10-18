/** Targeted read-only trace from an existing disposable preview; no provider calls. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {userInfo} from "node:os";
import postgres from "postgres";
import {MongoClient} from "mongodb";
import {invoiceHoursEvidence} from "../lib/invoice-hours-contract";
import {INVOICE_HOURS_SQL,INVOICE_HOURS_MAX_ORDERS} from "../lib/invoice-hours-query";
import {reviewInvoiceChronology} from "./invoice-date-review";
import {extractProtractorServicePackages,getProtractorPackageLines} from "../lib/integrations/protractor/package-normalization";
import {protractorLaborLineEvidence} from "../lib/labor-reporting-contract";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const vocabulary=(v:any)=>typeof v==="string"&&/^[a-z _-]{1,40}$/i.test(v)?v:"missing_or_other";
function safeTime(v:any) {
  if(!(v instanceof Date)&&!(typeof v==="string"&&/^\d{4}-\d\d-\d\dT/.test(v)))return null;
  const d=new Date(v);return Number.isFinite(+d)&&d.getUTCFullYear()>=1900?d.toISOString():null;
}
function timing(doc:any) {
  return {fetchedAt:safeTime(doc?.fetchedAt),updatedAt:safeTime(doc?.updatedAt),
    sourceModified:safeTime(doc?.rawPayload?.Header?.LastModifiedTime)};
}
function describe(raw:any) {
  if(!raw)return {present:false};
  const evidence=invoiceHoursEvidence(raw);
  const jobs=extractProtractorServicePackages(raw);
  return {present:true,type:vocabulary(raw.Type),stage:vocabulary(raw.WorkflowStage),
    sourceModified:safeTime(raw.Header?.LastModifiedTime),sourceCreated:safeTime(raw.Header?.CreationTime),
    status:vocabulary(raw.Status),number:raw.InvoiceNumber===0||raw.InvoiceNumber==="0"?"zero":
      Number(raw.InvoiceNumber)>0?"positive":"missing",
    invoiceDate:typeof raw.InvoiceTime==="string"&&/^\d{4}-\d{2}-\d{2}T/.test(raw.InvoiceTime)?raw.InvoiceTime:null,
    strictEvidence:evidence?{sold:evidence.sold,presented:evidence.presented}:null,
    deferredField:Object.hasOwn(raw,"DeferredServicePackages")?"present":"omitted",
    regularCollection:Array.isArray(raw.ServicePackages)?"array":
      Array.isArray(raw.ServicePackages?.ItemCollection)?"wrapped_array":
      !Object.hasOwn(raw,"ServicePackages")?"omitted":raw.ServicePackages===null?"null":"malformed",
    jobs:jobs.map(j=>({status:vocabulary(j.Status),deferred:!!j._isDeferred,
      isInvoicing:typeof j.IsInvoicing==="boolean"?j.IsInvoicing:null,
      identityPresent:!!(j.ID||j.ServicePackageID),
      billedHours:typeof j.BilledHours==="number"?j.BilledHours:null,
      lines:getProtractorPackageLines(j).map(l=>({
        type:vocabulary(l.Type??l.LineType),unit:vocabulary(l.Unit),
        hasQuantity:l.Quantity!=null,hasHours:l.Hours!=null,hasBilledHours:l.BilledHours!=null,
        hasEstimatedHours:l.EstimatedHours!=null,evidence:protractorLaborLineEvidence(l),
      }))}))};
}
let stage="connect";
async function main() {
  const port=Number(process.argv[2]);
  assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
  const local=postgres({host:"127.0.0.1",port,username:userInfo().username,database:"postgres",max:1,
    connection:{default_transaction_read_only:true,statement_timeout:10000}});
  const source=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,onnotice:()=>{},
    connection:{default_transaction_read_only:true,statement_timeout:10000}});
  const mongo=new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,{serverSelectionTimeoutMS:10000});
  try {
    assert.equal((await local`SELECT current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
    const facts=await local.unsafe(INVOICE_HOURS_SQL,["{227,228,229,230,231,232,233,234,235,236}",
      "2026-09-18T00:00:00Z","2026-10-17T23:59:59.999Z"]);
    assert.ok(facts.length<=INVOICE_HOURS_MAX_ORDERS);
    const mixed=process.argv.includes("--mixed-remainder");
    const remaining=process.argv.includes("--current-remainder");
    const chosen=remaining?JSON.parse(readFileSync("/tmp/invoice-current-targets.json","utf8")):[];
    const targets=remaining?await local`SELECT w.id,w.shop_id,w.provenance,d.reason FROM normalized_work_orders w
      JOIN evidence_diagnostics d ON d.id=w.id WHERE w.id=ANY(${local.array(chosen.map((r:any)=>r.id))})
      ORDER BY w.shop_id,w.id`:mixed?await local`
      SELECT w.id,w.shop_id,w.provenance,d.reason FROM normalized_work_orders w
      JOIN evidence_diagnostics d ON d.id=w.id JOIN date_reviews r ON r.id=w.id
      JOIN uninvoiced_review u ON u.id=w.id
      WHERE w.id=ANY(${local.array(facts.map(r=>r.id))})
      AND d.reason='missing_positive_invoice_number' AND r.classification='finality_unverified'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(u.shape) s WHERE s::jsonb->>'stage'='Invoice')
      ORDER BY w.shop_id,w.id
    `:await local`WITH ranked AS (
      SELECT w.id,w.shop_id,w.provenance,d.reason,row_number() OVER(PARTITION BY w.shop_id,d.reason ORDER BY w.id) n
      FROM normalized_work_orders w JOIN evidence_diagnostics d ON d.id=w.id
      LEFT JOIN proposed_evidence p ON p.id=w.id
      WHERE w.id=ANY(${local.array(facts.map(r=>r.id))}) AND (d.reason='missing_positive_invoice_number' OR
        (d.reason='verified_incomplete_hours' AND p.evidence->>'date'>='2026-09-18'
         AND p.evidence->>'date'<'2026-10-18')))
      SELECT * FROM ranked WHERE n<=3 ORDER BY shop_id,reason,n`;
    if(mixed)assert.equal(targets.length,48,"Expected the retained mixed-state cohort");
    if(remaining)assert.equal(targets.length,107);
    assert.ok(targets.length<=(remaining?107:60)&&targets.every(t=>t.shop_id>=227&&t.shop_id<=236));
    await mongo.connect();const db=mongo.db("mos-maintenance-mvp");
    assert.equal((await db.collection("enterprise_accounts").findOne({shopIds:227},{projection:{name:1},maxTimeMS:5000}))?.name,"JWT");
    console.log(JSON.stringify({event:"targeted_trace_start",records:targets.length,productionWrites:0,providerRequests:0}));
    for(const shop of [...new Set(targets.map(t=>t.shop_id))]) {
      const selected=targets.filter(t=>t.shop_id===shop);
      const ids=(t:any)=>(t.provenance?.sourceIds??[]).filter((s:any)=>s.system==="protractor"&&
        ["invoice_id","work_order_id"].includes(s.idType)).map((s:any)=>String(s.idValue).toLowerCase());
      const wanted=new Set(selected.flatMap(ids));
      const captured=new Map<string,any[]>();
      stage="archive";let pages=0;
      for(const campaign of ["protractor-weekend-2026-10-17","invoice-evidence-recovery-2026-10-17"]) {
        const cursor=db.collection<any>("operator_history_import_pages").find(
          {_id:{$gte:`${campaign}:${shop}:`,$lt:`${campaign}:${shop};`}},
          {projection:{shopId:1,invoices:1,digest:1},maxTimeMS:10000}).batchSize(10);
        for await(const page of cursor) {
          assert.ok(++pages<=2000);assert.equal(page.shopId,shop);
          assert.equal(hash(JSON.stringify(page.invoices)),page.digest);
          for(const raw of page.invoices)if(wanted.has(String(raw.ID).toLowerCase())){
            const key=String(raw.ID).toLowerCase();captured.set(key,[...(captured.get(key)??[]),describe(raw)]);
          }
        }
      }
      stage="source";
      const originals=await source.begin("isolation level repeatable read read only",async sql=>{
        const all=await sql.unsafe("SELECT id FROM normalized_work_orders WHERE shop_id=$1",[shop]);
        assert.ok(all.length<=100000);
        const matching=all.filter(r=>selected.some(t=>hash(`${shop}:${r.id}`)===t.id)).map(r=>r.id);
        return matching.length?sql.unsafe("SELECT id,raw_data FROM normalized_work_orders WHERE shop_id=$1 AND id=ANY($2::text[])",[shop,matching]):[];
      });
      for(const t of selected) {
        const keys=ids(t),lookup=[...new Set(keys.flatMap((k:string)=>[k,k.toUpperCase()]))];
        const wo=await db.collection("protractor_work_orders").find(
          {shopId:{$in:[shop,String(shop)]},workOrderId:{$in:lookup}},
          {projection:{rawPayload:1,fetchedAt:1,updatedAt:1},maxTimeMS:5000}).hint("protractor_wo_shop_work_order").limit(101).toArray();
        const mirror=await db.collection("normalized_work_orders").find(
          {shopId:{$in:[shop,String(shop)]},"provenance.sourceSystem":"protractor","provenance.sourceIds.idValue":{$in:lookup}},
          {projection:{rawPayload:1,fetchedAt:1,updatedAt:1},maxTimeMS:5000}).hint("unique_shop_source_idValue").limit(101).toArray();
        assert.ok(wo.length<101&&mirror.length<101);
        const original:any=originals.find((r:any)=>hash(`${shop}:${r.id}`)===t.id);
        const chronology=(mixed||remaining)&&keys.every((k:string)=>!captured.get(k)?.length)
          ?reviewInvoiceChronology(keys,[original?.raw_data?.rawPayload,...wo.map(r=>r.rawPayload),
            ...mirror.map(r=>r.rawPayload)].filter(Boolean)):null;
        console.log(JSON.stringify({event:"targeted_trace_record",shop,record:t.id,reason:t.reason,
          chronology,
          pg:describe(original?.raw_data?.rawPayload),
          pgEnvelopeKeys:Object.keys(original?.raw_data??{}),
          workOrderCache:wo.map(r=>({...describe(r.rawPayload),timing:timing(r)})),
          normalizedMirror:mirror.map(r=>({...describe(r.rawPayload),timing:timing(r)})),
          captured:keys.flatMap((k:string)=>captured.get(k)??[])}));
      }
    }
    console.log(JSON.stringify({event:"targeted_trace_complete",records:targets.length,productionWrites:0,providerRequests:0}));
  } finally {await mongo.close();await source.end();await local.end();}
}
main().catch(e=>{console.error(JSON.stringify({event:"targeted_trace_failed",stage,
  code:/^[A-Z0-9]{1,8}$/.test(String(e?.code))?String(e.code):"UNCLASSIFIED"}));process.exitCode=1;});
