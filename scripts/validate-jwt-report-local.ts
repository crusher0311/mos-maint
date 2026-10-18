/**
 * Read-only external stores -> disposable loopback PostgreSQL.
 * No provider client imports, production writes, or apply mode.
 * Only minimal reporting rows are persisted locally; source payloads stay in memory.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { MongoClient } from "mongodb";
import postgres from "postgres";
import { invoiceHoursEvidence, aggregateInvoiceHours, type InvoiceEvidence } from "../lib/invoice-hours-contract";
import { INVOICE_HOURS_SQL, INVOICE_HOURS_INDEX_SQL, INVOICE_HOURS_MAX_ORDERS } from "../lib/invoice-hours-query";
import { protractorInvoiceLaborEvidence } from "../lib/integrations/protractor/labor-evidence";
import { reconcileStored } from "./invoice-stored-evidence";
import { reviewUninvoiced, uninvoicedShape } from "./invoice-uninvoiced-review";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const same = (a: any,b: any) => a===b || (!!a&&!!b&&
  ["version","id","date","sold","presented"].every(k=>a[k]===b[k]));
const start="2026-09-18T00:00:00.000Z",end="2026-10-17T23:59:59.999Z";
let stage="arguments";
async function main() {
  const port=Number(process.argv[2]);
  assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
  const local=postgres({host:"127.0.0.1",port,database:"postgres",username:userInfo().username,max:1,onnotice:()=>{}});
  const source=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{
    max:1,connect_timeout:10,onnotice:()=>{},
    connection:{default_transaction_read_only:true,statement_timeout:10000,application_name:"invoice_readonly_preview"},
  });
  const mongo=new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,{serverSelectionTimeoutMS:10000});
  try {
    stage="local_identity";
    const [identity]=await local`SELECT current_setting('invoice_preview.disposable',true) marker`;
    assert.equal(identity.marker,"yes","Target must be marked disposable by the local launcher");
    await mongo.connect();
    const db=mongo.db("mos-maintenance-mvp");
    stage="enterprise";
    const enterprise=await db.collection("enterprise_accounts").findOne({shopIds:227},
      {projection:{name:1,shopIds:1},maxTimeMS:5000});
    assert.equal(enterprise?.name,"JWT");
    const shops=[...new Set((enterprise!.shopIds as number[]).map(Number))].sort((a,b)=>a-b);
    assert.equal(shops.length,10);
    assert.ok(shops.every(s=>Number.isSafeInteger(s)&&s>0));
    console.log(JSON.stringify({event:"scope_verified",shops,start,end,productionReadOnly:true}));
    await local`CREATE TABLE IF NOT EXISTS normalized_work_orders (
      id text PRIMARY KEY, shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
    await local`CREATE TABLE IF NOT EXISTS proposed_evidence (id text PRIMARY KEY,evidence jsonb)`;
    await local`CREATE TABLE IF NOT EXISTS evidence_diagnostics (id text PRIMARY KEY,shop_id int,reason text,matched_copies int)`;
    await local`CREATE TABLE IF NOT EXISTS completed_shop_copies (shop_id int PRIMARY KEY, mode text, inventory jsonb)`;
    const reconcile = process.argv.includes("--stored-reconcile");
    const classify = process.argv.includes("--classify-uninvoiced");
    assert.ok(!classify || reconcile,"Classification requires full stored reconciliation");
    await local`CREATE TABLE IF NOT EXISTS uninvoiced_review (id text PRIMARY KEY,shop_id int,classification text,shape jsonb)`;
    const mode=classify?"stored-reconcile-uninvoiced":reconcile?"stored-reconcile":"archive";
    const completed=await local`SELECT * FROM completed_shop_copies`;
    assert.ok(completed.every(r=>r.mode===mode),"Cannot resume with a different validation mode");
    const [baseline]=await local`SELECT to_regclass('invoice_preview_baseline') present`;
    if(baseline.present)await local`UPDATE normalized_work_orders w SET custom_fields=b.custom_fields
      FROM invoice_preview_baseline b WHERE b.id=w.id`;
    await local`CREATE TABLE IF NOT EXISTS invoice_status_baseline (id text PRIMARY KEY,status text)`;
    await local`UPDATE normalized_work_orders w SET status=b.status FROM invoice_status_baseline b WHERE b.id=w.id`;
    // These legacy invoice collections lack shop/invoice indexes. Build a
    // temporary identity directory with bounded _id keyset reads, then fetch
    // matching payloads by _id. No production index or data writes.
    const directory=new Map<string,{collection:string;id:any}[]>();
    const invoiceCollections=["protractor_invoice_cache","protractor_invoices"];
    if(reconcile&&completed.length<shops.length)for(const collection of invoiceCollections) {
      stage="invoice_cache_directory";
      const col=db.collection(collection);
      const [last]=await col.find({},{projection:{_id:1},maxTimeMS:5000}).sort({_id:-1}).limit(1).toArray();
      let after:any=undefined,scanned=0,matched=0;
      while(last) {
        const docs=await col.find({_id:{...(after?{$gt:after}:{}),$lte:last._id}},
          {projection:{_id:1,shopId:1,invoiceId:1},maxTimeMS:5000}).sort({_id:1}).hint("_id_").limit(1000).toArray();
        if(!docs.length)break;
        scanned+=docs.length;assert.ok(scanned<=1000000,"Invoice directory cap reached");
        for(const d of docs)if(shops.includes(Number(d.shopId))&&d.invoiceId) {
          const key=`${Number(d.shopId)}:${String(d.invoiceId).toLowerCase()}`;
          const entries=directory.get(key)??[];entries.push({collection,id:d._id});directory.set(key,entries);matched++;
        }
        after=docs[docs.length-1]._id;
        await new Promise(r=>setTimeout(r,100));
      }
      console.log(JSON.stringify({event:"invoice_cache_directory",collection,scanned,matched}));
    }
    const pgCaches:string[]=[];
    if(reconcile)for(const table of ["protractor_work_orders","protractor_invoices","protractor_invoice_cache"]) {
      const [r]=await source.unsafe("SELECT to_regclass($1) present",[table]);
      if(r.present)pgCaches.push(table);
    }
    let total=0;
    const inventory:any[]=[];
    const archiveCutoff = new Date();
    console.log(JSON.stringify({event:"archive_cutoff",at:archiveCutoff.toISOString(),
      campaigns:["protractor-weekend-2026-10-17","invoice-evidence-recovery-2026-10-17"]}));
    for(const shop of shops) {
      const checkpoint=completed.find(r=>r.shop_id===shop);
      if(checkpoint) {
        const [copied]=await local`SELECT count(*)::int rows FROM normalized_work_orders WHERE shop_id=${shop}`;
        assert.equal(copied.rows,checkpoint.inventory.rows,"Retained shop snapshot is incomplete");
        inventory.push(checkpoint.inventory);total+=checkpoint.inventory.rows;
        console.log(JSON.stringify({event:"shop_copy_resumed",...checkpoint.inventory}));
        continue;
      }
      // A stopped shop is recopied; completed shops remain unchanged locally.
      await local`DELETE FROM proposed_evidence WHERE id IN (SELECT id FROM normalized_work_orders WHERE shop_id=${shop})`;
      await local`DELETE FROM evidence_diagnostics WHERE shop_id=${shop}`;
      await local`DELETE FROM uninvoiced_review WHERE shop_id=${shop}`;
      await local`DELETE FROM normalized_work_orders WHERE shop_id=${shop}`;
      stage="archive";
      const archive=new Map<string,InvoiceEvidence|null>();
      let pages=0;
      for (const campaign of ["protractor-weekend-2026-10-17","invoice-evidence-recovery-2026-10-17"]) {
      const prefix=`${campaign}:${shop}:`;
      const cursor=db.collection<any>("operator_history_import_pages").find(
        {_id:{$gte:prefix,$lt:`${campaign}:${shop};`},
          ...(campaign==="invoice-evidence-recovery-2026-10-17"
            ? {capturedAt:{$lte:archiveCutoff}} : {})},
        {projection:{shopId:1,invoices:1,digest:1},maxTimeMS:10000}).sort({_id:1}).batchSize(10);
      for await(const page of cursor) {
        assert.ok(++pages<=2000,"Archive cap reached");
        assert.equal(page.shopId,shop);
        assert.ok(Array.isArray(page.invoices)&&page.invoices.length<=100);
        assert.equal(hash(JSON.stringify(page.invoices)),page.digest);
        for(const raw of page.invoices) {
          const e=invoiceHoursEvidence(raw);if(!e)continue;
          const old=archive.get(e.id);
          archive.set(e.id,old===undefined?e:same(old,e)?e:null);
        }
      }
      }
      const count={shop,rows:0,archivePages:pages,archiveIdentities:archive.size,existing:0,
        proposed:0,unrecoverable:0,conflict:0,notProtractor:0};
      stage="source_snapshot";
      await source.begin("isolation level repeatable read read only",async sql=>{
        assert.equal((await sql.unsafe("SHOW transaction_read_only"))[0].transaction_read_only,"on");
        const identifiers=await sql.unsafe("SELECT id FROM normalized_work_orders WHERE shop_id=$1",[shop]);
        assert.ok(identifiers.length<=100000,"Per-shop row cap reached");
        console.log(JSON.stringify({event:"shop_copy_started",shop,rows:identifiers.length}));
        // Project only invoice evidence inputs, not contacts/vehicles/addresses.
        for(let offset=0;offset<identifiers.length;offset+=100) {
        const batch=await sql.unsafe(`SELECT id,shop_id,status::text,soft_delete,provenance,
          CASE WHEN custom_fields ? 'invoiceHours' THEN jsonb_build_object('invoiceHours',custom_fields->'invoiceHours')
            ELSE '{}'::jsonb END custom_fields,
          (SELECT jsonb_object_agg(key,value) FROM jsonb_each(
            CASE WHEN jsonb_typeof(raw_data->'rawPayload')='object' THEN raw_data->'rawPayload' ELSE '{}'::jsonb END)
            WHERE key IN ('ID','Type','WorkflowStage','Status','InvoiceNumber','InvoiceTime',
              'ServicePackages','DeferredServicePackages')) raw
          FROM normalized_work_orders
          WHERE shop_id=$1 AND id=ANY($2::text[])`,
          [shop,identifiers.slice(offset,offset+100).map(r=>r.id)]);
          assert.equal(batch.length,Math.min(100,identifiers.length-offset),"Incomplete source batch");
          const copies:any[]=[];const proposals:any[]=[];
          const diagnostics:any[]=[];
          const statusReviews:any[]=[];
          const rowIds=(row:any)=>(row.provenance?.sourceIds??[])
            .filter((s:any)=>s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType))
            .map((s:any)=>String(s.idValue));
          // Read copies for every row, including conflicts and apparently complete rows.
          // Exact natural-key queries only: never unbounded VIN or regex scans.
          const lookup=[...new Set(batch.flatMap(rowIds).flatMap(id=>[id,id.toUpperCase(),id.toLowerCase()]))];
          let cached:any[]=[],mirrors:any[]=[],invoiceCopies:any[]=[];
          if(reconcile&&lookup.length) {
            cached=await db.collection("protractor_work_orders").find(
              {shopId:{$in:[shop,String(shop)]},workOrderId:{$in:lookup}},
              {projection:{shopId:1,workOrderId:1,rawPayload:1},maxTimeMS:5000})
              .hint("protractor_wo_shop_work_order").limit(1001).toArray();
            mirrors=await db.collection("normalized_work_orders").find(
              {shopId:{$in:[shop,String(shop)]},"provenance.sourceSystem":"protractor",
                "provenance.sourceIds.idValue":{$in:lookup}},
              {projection:{shopId:1,provenance:1,rawPayload:1},maxTimeMS:5000})
              .hint("unique_shop_source_idValue").limit(1001).toArray();
            assert.ok(cached.length<1001&&mirrors.length<1001,"Stored copy cap reached");
            for(const collection of invoiceCollections) {
              const entries=[...new Set(lookup.map(id=>id.toLowerCase()))]
                .flatMap(id=>directory.get(`${shop}:${id}`)??[]).filter(d=>d.collection===collection);
              assert.ok(entries.length<=2000,"Invoice copy cap reached");
              for(let at=0;at<entries.length;at+=100)invoiceCopies.push(...await db.collection(collection).find(
                {_id:{$in:entries.slice(at,at+100).map(d=>d.id)}},
                {projection:{shopId:1,invoiceId:1,invoice:1,rawPayload:1},maxTimeMS:5000}).toArray());
            }
            for(const table of pgCaches) {
              const key=table==="protractor_work_orders"?"work_order_id":"invoice_id";
              const docs=await sql.unsafe(`SELECT shop_id,${key} source_id,
                payload->'rawPayload' raw,payload->'invoice' invoice
                FROM ${table} WHERE shop_id=$1 AND ${key}=ANY($2::text[]) LIMIT 1001`,[shop,lookup]);
              assert.ok(docs.length<1001,"PG cache cap reached");
              invoiceCopies.push(...docs.map(d=>({shopId:d.shop_id,invoiceId:d.source_id,rawPayload:d.raw,invoice:d.invoice})));
            }
          }
          for(const row of batch) {
            assert.ok(++total<=500000,"Row cap reached: snapshot incomplete");
            count.rows++;
            const id=hash(`${shop}:${row.id}`);
            copies.push({id,shop_id:shop,status:row.status,
              soft_delete:row.soft_delete==null?null:{isDeleted:row.soft_delete.isDeleted??false},
              provenance:{sourceSystem:row.provenance?.sourceSystem,
                sourceIds:(row.provenance?.sourceIds??[]).filter((s:any)=>
                  ["invoice_id","work_order_id"].includes(s.idType)).map((s:any)=>({
                    system:s.system,idType:s.idType,idValue:s.idValue,
                  }))},custom_fields:row.custom_fields});
            if(row.provenance?.sourceSystem!=="protractor"){count.notProtractor++;continue;}
            const ids=(row.provenance.sourceIds??[]).filter((s:any)=>s.system==="protractor"&&
              ["invoice_id","work_order_id"].includes(s.idType)).map((s:any)=>String(s.idValue).toLowerCase());
            const raw=row.raw;
            const stored=invoiceHoursEvidence(raw);
            const choices=ids.filter((id:string)=>archive.has(id)).map((id:string)=>archive.get(id));
            if(stored)choices.push(stored);
            const present=row.custom_fields?.invoiceHours;
            if(reconcile) {
              const cache=cached.filter(d=>Number(d.shopId)===shop&&ids.includes(String(d.workOrderId).toLowerCase()));
              const mirror=mirrors.filter(d=>Number(d.shopId)===shop&&(d.provenance?.sourceIds??[])
                .some((s:any)=>s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType)&&ids.includes(String(s.idValue).toLowerCase())));
              const invoices=invoiceCopies.filter(d=>Number(d.shopId)===shop&&ids.includes(String(d.invoiceId).toLowerCase()));
              const payloads=[raw,...cache.map(d=>d.rawPayload),...mirror.map(d=>d.rawPayload),
                ...invoices.flatMap(d=>[d.rawPayload,d.invoice])].filter(Boolean);
              // A key match alone is not authority for a payload with a missing/mismatched ID.
              const validPayloads=payloads.filter(p=>p===raw||p?.ID&&ids.includes(String(p.ID).toLowerCase()));
              const checked=reconcileStored(ids,validPayloads,ids.filter((id:string)=>archive.has(id)).map((id:string)=>archive.get(id)!));
              let reason=checked.reason;
              if(validPayloads.length!==payloads.length&&payloads.some(Boolean)) {
                reason="matched_copy_missing_or_mismatched_identity";
                checked.evidence=null;
              }
              diagnostics.push({id,shop_id:shop,reason,matched_copies:validPayloads.filter(Boolean).length});
              if(classify) {
                const classification=reviewUninvoiced(ids,payloads,
                  present!=null || ids.some((key:string)=>archive.has(key)) || checked.evidence!=null ||
                  reason.startsWith("conflicting") || reason.startsWith("matched_copy"));
                statusReviews.push({id,shop_id:shop,classification,shape:uninvoicedShape(payloads)});
              }
              if(present!=null){count.existing++;if(checked.evidence&&!same(present,checked.evidence))count.conflict++;continue;}
              if(!checked.evidence) {
                if(reason.startsWith("conflicting")||reason.startsWith("matched_copy"))count.conflict++;
                else count.unrecoverable++;
                continue;
              }
              count.proposed++;proposals.push({id,evidence:checked.evidence});continue;
            }
            if(present!=null) {
              count.existing++;
              // Existing evidence is not silently replaced by a repair preview.
              if(choices.some((e:any)=>e===null||!same(e,present)))count.conflict++;
              continue;
            }
            if(!choices.length){count.unrecoverable++;continue;}
            const e=choices[0];
            if(!e||!ids.includes(e.id)||choices.some((x:any)=>!same(x,e))||
              (raw?.ID&&String(raw.ID).toLowerCase()!==e.id)) {count.conflict++;continue;}
            if(raw?.InvoiceTime) {
              const text=String(raw.InvoiceTime);
              const stamp=new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(text)?text:`${text}Z`);
              if(!Number.isFinite(+stamp)||stamp.toISOString()!==e.date){count.conflict++;continue;}
            }
            // Older snapshots may lack a positive invoice number but still
            // contain contradictory hours. Use them only as a veto, never as
            // evidence establishing an invoice identity or denominator.
            const oldHours=protractorInvoiceLaborEvidence(raw);
            if(oldHours&&(["sold","presented"] as const).some(k=>
              oldHours[k]!==null&&e[k]!==null&&oldHours[k]!==e[k])) {
              count.conflict++;continue;
            }
            count.proposed++;
            proposals.push({id,evidence:e});
          }
          stage="local_copy";
          await local.begin(async t=>{
            if(statusReviews.length)await t.unsafe(`INSERT INTO uninvoiced_review SELECT * FROM jsonb_to_recordset($1::jsonb)
              AS r(id text,shop_id int,classification text,shape jsonb)`,[t.json(statusReviews)]);
            if(diagnostics.length)await t.unsafe(`INSERT INTO evidence_diagnostics SELECT * FROM jsonb_to_recordset($1::jsonb)
              AS r(id text,shop_id int,reason text,matched_copies int)`,[t.json(diagnostics)]);
            await t.unsafe(`INSERT INTO normalized_work_orders SELECT * FROM jsonb_to_recordset($1::jsonb)
              AS r(id text,shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`,
              [t.json(copies)]);
            if(proposals.length)await t.unsafe(`INSERT INTO proposed_evidence SELECT * FROM jsonb_to_recordset($1::jsonb)
              AS r(id text,evidence jsonb)`,[t.json(proposals)]);
          });
          stage="source_snapshot";
          await new Promise(r=>setTimeout(r,100));
        }
      });
      await local`INSERT INTO completed_shop_copies VALUES (${shop},${mode},${local.json(count)})`;
      inventory.push(count);console.log(JSON.stringify({event:"shop_snapshot",...count}));
    }
    stage="local_indexes";
    await local`CREATE INDEX IF NOT EXISTS invoice_preview_shop ON normalized_work_orders(shop_id)`;
    for(const statement of INVOICE_HOURS_INDEX_SQL.replaceAll("CONCURRENTLY ","").split(";").filter(s=>s.trim()))
      await local.unsafe(statement);
    await local`ANALYZE normalized_work_orders`;
    await local`SET statement_timeout='90s'`;
    async function report(label:string,scope:number[]) {
      const rows=await local.unsafe(INVOICE_HOURS_SQL,[`{${scope.join(",")}}`,start,end]);
      console.log(JSON.stringify({event:"local_report",label,shops:scope,rows:rows.length,
        bounded:rows.length>INVOICE_HOURS_MAX_ORDERS,
        summary:rows.length>INVOICE_HOURS_MAX_ORDERS?null:aggregateInvoiceHours(rows as any,new Date(start),new Date(end)).summary}));
    }
    await local`CREATE TABLE IF NOT EXISTS invoice_preview_baseline AS SELECT id,custom_fields FROM normalized_work_orders`;
    stage="baseline_report";await report("before",shops);
    stage="local_repair";
    await local`UPDATE normalized_work_orders w SET custom_fields=jsonb_set(
      coalesce(w.custom_fields,'{}'::jsonb),'{invoiceHours}',p.evidence)
      FROM proposed_evidence p WHERE p.id=w.id AND (w.custom_fields->'invoiceHours' IS NULL OR w.custom_fields->'invoiceHours'='null'::jsonb)`;
    await local`ANALYZE normalized_work_orders`;
    stage="repaired_report";await report("after",shops);
    if(classify) {
      const facts=await local.unsafe(INVOICE_HOURS_SQL,[`{${shops.join(",")}}`,start,end]);
      assert.ok(facts.length<=INVOICE_HOURS_MAX_ORDERS,"Cannot classify capped report");
      const review=await local`SELECT classification,shape,count(*)::int records FROM uninvoiced_review
        WHERE id=ANY(${local.array(facts.map(r=>r.id))}) GROUP BY classification,shape ORDER BY records DESC`;
      console.log(JSON.stringify({event:"uninvoiced_candidate_review",groups:review}));
      await local`INSERT INTO invoice_status_baseline SELECT id,status FROM normalized_work_orders ON CONFLICT DO NOTHING`;
      // Disposable local rows only. Existing invoice evidence always takes precedence.
      await local`UPDATE normalized_work_orders w SET status='open' FROM uninvoiced_review r
        WHERE r.id=w.id AND r.classification='verified_stored_uninvoiced'
        AND (w.custom_fields->'invoiceHours' IS NULL OR w.custom_fields->'invoiceHours'='null'::jsonb)`;
      await report("after_stored_status_classification",shops);
    }
    if(reconcile) {
      const grouped=await local`SELECT shop_id,reason,count(*)::int records,
        sum(matched_copies)::int matched_copies FROM evidence_diagnostics GROUP BY shop_id,reason ORDER BY shop_id,reason`;
      console.log(JSON.stringify({event:"stored_reconciliation_diagnostics",scope:"all copied history",groups:grouped}));
      const facts=await local.unsafe(INVOICE_HOURS_SQL,[`{${shops.join(",")}}`,start,end]);
      assert.ok(facts.length<=INVOICE_HOURS_MAX_ORDERS,"Cannot classify capped report");
      const selected=await local`SELECT d.reason,count(*)::int records FROM evidence_diagnostics d
        WHERE d.id=ANY(${local.array(facts.map(r=>r.id))}) GROUP BY d.reason ORDER BY d.reason`;
      console.log(JSON.stringify({event:"report_candidate_diagnostics",groups:selected,
        note:"Candidate row counts are not deduplicated invoice counts; unknown dates are not proof of in-period invoices."}));
    }
    for(const shop of shops)await report("after_location",[shop]);
    console.log(JSON.stringify({event:"validation_complete",total,inventory,productionWrites:0,providerRequests:0}));
  } finally {await mongo.close();await source.end();await local.end();}
}
main().catch(e=>{console.error(JSON.stringify({event:"validation_failed",stage,code:/^[A-Z0-9]{1,8}$/.test(String(e?.code))?String(e.code):"UNCLASSIFIED",productionWrites:0}));process.exitCode=1;});
