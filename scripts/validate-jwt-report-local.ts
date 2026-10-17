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
    await local`CREATE TABLE normalized_work_orders (
      id text PRIMARY KEY, shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
    await local`CREATE TABLE proposed_evidence (id text PRIMARY KEY,evidence jsonb)`;
    let total=0;
    const inventory:any[]=[];
    for(const shop of shops) {
      stage="archive";
      const archive=new Map<string,InvoiceEvidence|null>();
      let pages=0;
      const prefix=`protractor-weekend-2026-10-17:${shop}:`;
      const cursor=db.collection<any>("operator_history_import_pages").find(
        {_id:{$gte:prefix,$lt:`protractor-weekend-2026-10-17:${shop};`}},
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
      inventory.push(count);console.log(JSON.stringify({event:"shop_snapshot",...count}));
    }
    stage="local_indexes";
    await local`CREATE INDEX ON normalized_work_orders(shop_id)`;
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
    stage="baseline_report";await report("before",shops);
    stage="local_repair";
    await local`UPDATE normalized_work_orders w SET custom_fields=jsonb_set(
      coalesce(w.custom_fields,'{}'::jsonb),'{invoiceHours}',p.evidence)
      FROM proposed_evidence p WHERE p.id=w.id AND (w.custom_fields->'invoiceHours' IS NULL OR w.custom_fields->'invoiceHours'='null'::jsonb)`;
    await local`ANALYZE normalized_work_orders`;
    stage="repaired_report";await report("after",shops);
    for(const shop of shops)await report("after_location",[shop]);
    console.log(JSON.stringify({event:"validation_complete",total,inventory,productionWrites:0,providerRequests:0}));
  } finally {await mongo.close();await source.end();await local.end();}
}
main().catch(e=>{console.error(JSON.stringify({event:"validation_failed",stage,code:/^[A-Z0-9]{1,8}$/.test(String(e?.code))?String(e.code):"UNCLASSIFIED",productionWrites:0}));process.exitCode=1;});
