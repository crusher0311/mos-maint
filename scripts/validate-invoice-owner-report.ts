/**
 * Bounded read-only source inspection -> disposable local reporting simulation.
 * No provider requests, production writes, automatic repair or finality override.
 * Scope: normalized PG/Mongo copies for the previously reviewed owner closure;
 * not a replacement for archive-wide reconciliation or full-fleet validation.
 */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {userInfo} from "node:os";
import postgres from "postgres";
import {MongoClient} from "mongodb";
import {planOwnerStructure} from "./invoice-owner-repair-model";
import {reconcileStored} from "./invoice-stored-evidence";
import {INVOICE_HOURS_SQL} from "../lib/invoice-hours-query";
import {aggregateInvoiceHours} from "../lib/invoice-hours-contract";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
const refs=(p:any)=>[...new Set<string>((p?.sourceIds??[])
  .filter((s:any)=>s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType))
  .map((s:any)=>String(s.idValue).toLowerCase()))];
async function main(){
  const port=Number(process.argv[2]);assert.ok(port>1024&&port<65536);
  const snapshot=JSON.parse(readFileSync("/tmp/invoice-owner-closure.json","utf8"));
  const plan=planOwnerStructure(snapshot);
  const local=postgres({host:"127.0.0.1",port,username:userInfo().username,database:"postgres",max:1,onnotice:()=>{}});
  const source=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:8,
    connection:{default_transaction_read_only:true,statement_timeout:5000},onnotice:()=>{}});
  const mongo=new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,
    {serverSelectionTimeoutMS:10000});
  const shops=[...new Set<number>(snapshot.nodes.map((n:any)=>n.shop))].sort();
  let owners=0,parents=0;
  const reasons:Record<string,number>={};
  const evidenceScope={insideRequestedPeriod:0,outsideRequestedPeriod:0,withDeferredHours:0};
  let expectedInvoices=0,expectedSold=0,expectedPresented=0;
  try{
    assert.equal((await local`select current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
    await local`CREATE TABLE normalized_work_orders(id text PRIMARY KEY,shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
    await local`CREATE TABLE proposed_work_orders(LIKE normalized_work_orders INCLUDING ALL)`;
    await mongo.connect();const db=mongo.db("mos-maintenance-mvp");
    for(const shop of shops){
      const candidates=await source`select id from normalized_work_orders where shop_id=${shop} limit 100001`;
      assert.ok(candidates.length<=100000,"Shop identity-directory cap reached");
      const expected=snapshot.nodes.filter((n:any)=>n.shop===shop);
      const ids=candidates.filter(r=>expected.some((n:any)=>n.record===hash(`${shop}:${r.id}`)));
      assert.equal(ids.length,expected.length,"Reviewed parent is missing");
      for(const {id} of ids){
        const [row]=await source`select id,status,soft_delete,provenance,custom_fields,work_order_number,raw_data->'rawPayload' raw
          from normalized_work_orders where shop_id=${shop} and id=${id}`;
        const node=expected.find((n:any)=>n.record===hash(`${shop}:${id}`));
        const sourceIds=refs(row.provenance);
        assert.deepEqual(sourceIds.map(x=>hash(`${shop}:${x}`)).sort(),[...node.sourceIds].sort(),"Owner evidence changed");
        assert.equal(hash(`${shop}:${row.work_order_number}`),node.number);
        const keys=[...new Set(sourceIds.flatMap(x=>[x,x.toUpperCase()]))];
        const copies=await db.collection("normalized_work_orders").find({
          shopId:{$in:[shop,String(shop)]},"provenance.sourceSystem":"protractor",
          "provenance.sourceIds.idValue":{$in:keys}},
          {projection:{rawPayload:1},maxTimeMS:5000}).hint("unique_shop_source_idValue").limit(101).toArray();
        assert.ok(copies.length<101,"Source-copy cap reached");
        const raws=[row.raw,...copies.map(c=>c.rawPayload)].filter(Boolean);
        assert.ok(raws.every(r=>sourceIds.includes(String(r.ID??"").toLowerCase())),"Unexpected source identity");
        await local`insert into normalized_work_orders values(
          ${node.record},${shop},${row.status},${local.json(row.soft_delete)},${local.json(row.provenance)},${local.json(row.custom_fields)})`;
        parents++;
        for(const ownerId of sourceIds){
          const owner=hash(`${shop}:${ownerId}`),bound=raws.filter(r=>String(r.ID).toLowerCase()===ownerId);
          assert.ok(bound.length>0,"Missing owner payload");
          const desired=plan.parents.find(p=>p.owner===owner)!;assert.ok(desired);
          assert.ok(bound.every(r=>hash(`${shop}:${r.WorkOrderNumber}`)===desired.number),"Work-order number conflict");
          const reconciled=reconcileStored([ownerId],bound,[]);
          reasons[reconciled.reason]=(reasons[reconciled.reason]??0)+1;
          if(reconciled.evidence){
            const e=reconciled.evidence;
            if(e.date>="2026-09-18T00:00:00.000Z"&&e.date<="2026-10-17T23:59:59.999Z")evidenceScope.insideRequestedPeriod++;
            else evidenceScope.outsideRequestedPeriod++;
            if(e.sold!==null&&e.presented!==null&&e.presented>e.sold)evidenceScope.withDeferredHours++;
            if(!row.soft_delete?.isDeleted&&e.date>="1900-01-01T00:00:00.000Z"&&e.sold!==null&&e.presented!==null){
              expectedInvoices++;expectedSold+=e.sold;expectedPresented+=e.presented;
            }
          }
          // No chronology relaxation, latest-copy selection, or cross-owner evidence.
          // Unknowns stay visible instead of inheriting an unrelated parent's open status.
          const provenance={sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"invoice_id",idValue:ownerId}]};
          const custom={invoiceHours:reconciled.evidence};
          await local`insert into proposed_work_orders values(
            ${owner},${shop},${reconciled.evidence?"invoiced":"unknown"},
            ${local.json(row.soft_delete)},${local.json(provenance)},${local.json(custom)})`;
          owners++;
        }
      }
    }
    assert.equal(parents,snapshot.nodes.length);assert.equal(owners,plan.parents.length);
    const start="2026-09-18T00:00:00.000Z",end="2026-10-17T23:59:59.999Z";
    for(const [label,table] of [["before","normalized_work_orders"],["after_owner_separation","proposed_work_orders"]]){
      const rows=await local.unsafe(INVOICE_HOURS_SQL.replaceAll("normalized_work_orders",table),[`{${shops.join(",")}}`,start,end]);
      console.log(JSON.stringify({event:"owner_cohort_report",label,rows:rows.length,
        summary:aggregateInvoiceHours(rows as any,new Date(start),new Date(end)).summary}));
    }
    // An all-date control checks actual hours too: excluding old invoices from the
    // requested period alone would not establish financial/report parity.
    const from="1900-01-01T00:00:00.000Z",until="9999-12-31T23:59:59.999Z";
    const control=await local.unsafe(INVOICE_HOURS_SQL.replaceAll("normalized_work_orders","proposed_work_orders"),
      [`{${shops.join(",")}}`,from,until]);
    const summary=aggregateInvoiceHours(control as any,new Date(from),new Date(until)).summary;
    assert.equal(summary.invoiceCount,expectedInvoices);
    assert.equal(summary.invoiceSoldCovered,expectedInvoices);
    assert.equal(summary.invoicePresentedCovered,expectedInvoices);
    assert.ok(summary.invoiceSoldHours!=null&&summary.invoicePresentedHours!=null);
    assert.ok(Math.abs(summary.invoiceSoldHours-expectedSold)<0.000001);
    assert.ok(Math.abs(summary.invoicePresentedHours-expectedPresented)<0.000001);
    console.log(JSON.stringify({event:"owner_all_date_financial_control",summary,evidenceScope,sourceTotalsMatchReport:true}));
    console.log(JSON.stringify({event:"owner_report_simulation_complete",parents,owners,structurallyPreservedChildren:plan.children.length,
      reasons,scope:"Reviewed closure only; normalized stored copies, not archive-wide or full-fleet validation",
      childFinancialRowsRebuilt:false,productionWrites:0,providerRequests:0}));
  }finally{await local.end();await source.end();await mongo.close();}
}
main().catch(e=>{console.error(JSON.stringify({event:"owner_report_simulation_failed",code:e.code??e.name,
  reason:e.name==="AssertionError"?e.message:"Source or local operation failed"}));process.exitCode=1;});
