import assert from "node:assert/strict";
import {userInfo} from "node:os";
import postgres from "postgres";
import {INVOICE_HOURS_SQL,INVOICE_HOURS_INDEX_SQL,INVOICE_HOURS_MAX_ORDERS} from "../lib/invoice-hours-query";
import {aggregateInvoiceHours} from "../lib/invoice-hours-contract";
const port=Number(process.argv[2]);
assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
const pg=postgres({host:"127.0.0.1",port,database:"postgres",username:userInfo().username,max:1,onnotice:()=>{}});
async function main(){
  assert.equal((await pg`SELECT current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
  if(process.argv[3]==="schema"){
    await pg`CREATE TABLE normalized_work_orders (id text PRIMARY KEY,shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
    await pg`CREATE TABLE proposed_evidence (id text PRIMARY KEY,evidence jsonb)`;
    return;
  }
  const counts=await pg`SELECT shop_id,count(*)::int n FROM normalized_work_orders GROUP BY shop_id ORDER BY shop_id`;
  assert.equal(counts.length,10);assert.ok(counts.reduce((n,r)=>n+r.n,0)<=500000);
  const shops=counts.map(r=>r.shop_id);
  assert.deepEqual(shops,[227,228,229,230,231,232,233,234,235,236]);
  await pg`CREATE INDEX ON normalized_work_orders(shop_id)`;
  for(const sql of INVOICE_HOURS_INDEX_SQL.replaceAll("CONCURRENTLY ","").split(";").filter(s=>s.trim()))await pg.unsafe(sql);
  await pg`ANALYZE normalized_work_orders`;
  await pg`SET statement_timeout='90s'`;
  async function report(label:string,scope:number[]){
    const start="2026-09-18T00:00:00.000Z",end="2026-10-17T23:59:59.999Z";
    const rows=await pg.unsafe(INVOICE_HOURS_SQL,[`{${scope.join(",")}}`,start,end]);
    const summary=rows.length>INVOICE_HOURS_MAX_ORDERS?null:aggregateInvoiceHours(rows as any,new Date(start),new Date(end)).summary;
    console.log(JSON.stringify({event:"replayed_report",label,shops:scope,rows:rows.length,
      bounded:rows.length>INVOICE_HOURS_MAX_ORDERS,summary}));
    return summary;
  }
  await report("before",shops);
  const applied=await pg`UPDATE normalized_work_orders w SET custom_fields=jsonb_set(
    coalesce(w.custom_fields,'{}'::jsonb),'{invoiceHours}',p.evidence)
    FROM proposed_evidence p WHERE p.id=w.id AND
      (w.custom_fields->'invoiceHours' IS NULL OR w.custom_fields->'invoiceHours'='null'::jsonb)`;
  await pg`ANALYZE normalized_work_orders`;
  const summary=await report("after",shops);
  for(const shop of shops)await report("after_location",[shop]);
  const missing=await pg`SELECT shop_id,status,count(*)::int n FROM normalized_work_orders
    WHERE custom_fields->'invoiceHours' IS NULL OR custom_fields->'invoiceHours'='null'::jsonb
    GROUP BY shop_id,status ORDER BY shop_id,status`;
  console.log(JSON.stringify({event:"replay_complete",localUpdates:applied.count,missingByStatus:missing,
    completeCoverage:!!summary&&summary.invoicePopulationUnknown===0&&
      summary.averagePresentedHoursPerInvoice!=null&&summary.averageSoldHoursPerInvoice!=null,
    productionRepairApproved:false,productionWrites:0,providerRequests:0}));
}
main().catch(e=>{console.error(JSON.stringify({event:"replay_failed",code:e?.code??"VALIDATION"}));process.exitCode=1}).finally(()=>pg.end());
