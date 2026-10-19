/**
 * Bounded read-only source inspection -> disposable local reporting simulation.
 * No provider requests, production writes, automatic repair or finality override.
 * Scope: ten-location JWT fleet in one PG snapshot, plus bounded retained
 * campaign archives and caches. Mongo reads are not cross-store atomic.
 */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {userInfo} from "node:os";
import postgres from "postgres";
import {MongoClient} from "mongodb";
import {planOwnerStructure} from "./invoice-owner-repair-model";
import {reconcileOwnerCopies,queryOwnerReport,assertOwnerFinancialControl} from "./invoice-owner-report-model";
import {INVOICE_HOURS_SQL} from "../lib/invoice-hours-query";
import {aggregateInvoiceHours} from "../lib/invoice-hours-contract";
import {INVOICE_HOURS_MAX_ORDERS} from "../lib/invoice-hours-query";
import {captureFleet,retainedArchives} from "./invoice-owner-retained-sources";
import {collectChildEvidence,auditChild,childKinds} from "./invoice-owner-financial-audit";
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
  const fleetShops=[227,228,229,230,231,232,233,234,235,236];
  const childReasons:Record<string,number>={};
  let auditedChildren=0,archiveMatches=0,cacheCopies=0;
  let owners=0,parents=0;
  const reasons:Record<string,number>={};
  const evidenceScope={insideRequestedPeriod:0,outsideRequestedPeriod:0,withDeferredHours:0};
  let expectedInvoices=0,expectedSold=0,expectedPresented=0;
  try{
    assert.equal((await local`select current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
    await local`CREATE TABLE normalized_work_orders(id text PRIMARY KEY,shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
    await local`CREATE TABLE proposed_work_orders(LIKE normalized_work_orders INCLUDING ALL)`;
    await local`CREATE TABLE fleet_work_orders(LIKE normalized_work_orders INCLUDING ALL)`;
    await local`CREATE TABLE fleet_proposed_work_orders(LIKE normalized_work_orders INCLUDING ALL)`;
    await local`CREATE TABLE child_audit(table_name text,id text,owner text,reason text,details jsonb,PRIMARY KEY(table_name,id))`;
    await local`CREATE TABLE child_before(kind text,id text,parent text,job text,values jsonb,PRIMARY KEY(kind,id))`;
    await local`CREATE TABLE child_after(LIKE child_before INCLUDING ALL)`;
    assert.deepEqual(snapshot.foreignKeys.map((f:any)=>String(f.child).replace(/^public\./,"")).sort(),
      Object.keys(childKinds).sort(),"Unreviewed inbound foreign key");
    await mongo.connect();const db=mongo.db("mos-maintenance-mvp");
    const enterprise=await db.collection("enterprise_accounts").findOne({shopIds:227},{projection:{name:1,shopIds:1},maxTimeMS:5000});
    assert.equal(enterprise?.name,"JWT");
    assert.deepEqual([...new Set(enterprise!.shopIds.map(Number))].sort((a:any,b:any)=>a-b),fleetShops);
    const cutoff=new Date();
    const archives=new Map<number,Map<string,any[]>>();
    for(const shop of shops)archives.set(shop,await retainedArchives(db,shop,cutoff));
    // One PG repeatable-read view for the fleet, parent payloads and children.
    await source.begin("isolation level repeatable read read only",async transaction=>{
    const sql=transaction as unknown as typeof source;
    const snapshotInfo=await sql`select transaction_timestamp()::text captured_at,pg_current_snapshot()::text snapshot`;
    const fleetRows=await captureFleet(sql,local,fleetShops);
    console.log(JSON.stringify({event:"fleet_snapshot",fleetRows,...snapshotInfo[0]}));
    for(const shop of shops){
      const candidates=await sql`select id from normalized_work_orders where shop_id=${shop} limit 100001`;
      assert.ok(candidates.length<=100000,"Shop identity-directory cap reached");
      const expected=snapshot.nodes.filter((n:any)=>n.shop===shop);
      const ids=candidates.filter(r=>expected.some((n:any)=>n.record===hash(`${shop}:${r.id}`)));
      assert.equal(ids.length,expected.length,"Reviewed parent is missing");
      for(const {id} of ids){
        const [row]=await sql`select id,status,soft_delete,provenance,custom_fields,work_order_number,raw_data->'rawPayload' raw
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
        const cache=await db.collection("protractor_work_orders").find(
          {shopId:{$in:[shop,String(shop)]},workOrderId:{$in:keys}},
          {projection:{rawPayload:1},maxTimeMS:5000}).hint("protractor_wo_shop_work_order").limit(101).toArray();
        assert.ok(cache.length<101,"Work-order cache cap reached");
        const archived=sourceIds.flatMap(id=>archives.get(shop)!.get(id)??[]);
        archiveMatches+=archived.length;cacheCopies+=cache.length;
        const raws=[row.raw,...copies.map(c=>c.rawPayload),...cache.map(c=>c.rawPayload),...archived].filter(Boolean);
        assert.ok(raws.every(r=>sourceIds.includes(String(r.ID??"").toLowerCase())),"Unexpected source identity");
        const childEvidence=collectChildEvidence(raws,shop);
        for(const table of Object.keys(childKinds)){
          const children=await sql.unsafe(`select * from ${table} where shop_id=$1 and work_order_id=$2 limit 5001`,[shop,id]);
          assert.ok(children.length<=5000);
          assert.equal(children.length,plan.children.filter((c:any)=>c.parent===node.record&&c.table===table).length);
          for(const child of children){
            const expected=plan.children.find((c:any)=>c.table===table&&c.id===hash(`${shop}:${child.id}`));
            assert.ok(expected,"Child closure changed");
            const {work_order_id,service_job_id,...immutable}=child;
            assert.equal(hash(JSON.stringify(immutable)),expected.immutableHash,"Child values changed since closure review");
            const result=auditChild(table,child,expected.owner,childEvidence);
            if(table==="normalized_line_items"&&result.sourceJobs){
              const job=plan.children.find((c:any)=>c.table==="normalized_service_jobs"&&c.id===expected.job);
              assert.ok(job&&job.owner===expected.owner,"Line/job owner mismatch");
              const [jobRow]=await sql`select provenance from normalized_service_jobs where shop_id=${shop} and id=${service_job_id}`;
              const jobRefs=(jobRow?.provenance?.sourceIds??[]).filter((s:any)=>s.system==="protractor"&&s.idType==="service_job_id")
                .map((s:any)=>String(s.idValue).toLowerCase());
              if(!result.sourceJobs.every(j=>j!==null&&jobRefs.includes(j)))result.reason="conflicting_source_job_link";
            }
            childReasons[result.reason]=(childReasons[result.reason]??0)+1;auditedChildren++;
            await local`insert into child_audit values(${table},${expected.id},${expected.owner},${result.reason},${local.json(result)})`;
            await local`insert into child_before values(${table},${expected.id},${node.record},${expected.job},${local.json(result.stored)})`;
            await local`insert into child_after values(${table},${expected.id},${expected.owner},${expected.job},${local.json(result.stored)})`;
          }
        }
        await local`insert into normalized_work_orders values(
          ${node.record},${shop},${row.status},${local.json(row.soft_delete)},${local.json(row.provenance)},${local.json(row.custom_fields)})`;
        parents++;
        for(const ownerId of sourceIds){
          const owner=hash(`${shop}:${ownerId}`),bound=raws.filter(r=>String(r.ID).toLowerCase()===ownerId);
          assert.ok(bound.length>0,"Missing owner payload");
          const desired=plan.parents.find(p=>p.owner===owner)!;assert.ok(desired);
          assert.ok(bound.every(r=>hash(`${shop}:${r.WorkOrderNumber}`)===desired.number),"Work-order number conflict");
          const reconciled=reconcileOwnerCopies(ownerId,raws);
          console.log(JSON.stringify({event:"owner_evidence",shop,owner,reason:reconciled.reason,
            copies:bound.length,archiveCopies:archived.filter(r=>String(r.ID).toLowerCase()===ownerId).length,
            evidence:reconciled.evidence?{date:reconciled.evidence.date,sold:reconciled.evidence.sold,presented:reconciled.evidence.presented}:null}));
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
    });
    assert.equal(parents,snapshot.nodes.length);assert.equal(owners,plan.parents.length);
    assert.equal(auditedChildren,plan.children.length);
    await local`delete from fleet_proposed_work_orders where id in(select id from normalized_work_orders)`;
    await local`insert into fleet_proposed_work_orders select * from proposed_work_orders`;
    await local`ALTER TABLE child_before ADD FOREIGN KEY(parent) REFERENCES normalized_work_orders(id)`;
    await local`ALTER TABLE child_after ADD FOREIGN KEY(parent) REFERENCES proposed_work_orders(id)`;
    const [preserved]=await local`select count(*)::int n,count(*) filter(where a.id is null or b.id is null or a.values<>b.values)::int changed
      from child_before b full join child_after a using(kind,id)`;
    assert.equal(preserved.n,plan.children.length);assert.equal(preserved.changed,0);
    const brokenJobLinks=await local`select l.id from child_after l left join child_after j on j.kind='normalized_service_jobs'
      and j.id=l.job and j.parent=l.parent where l.kind='normalized_line_items' and j.id is null limit 1`;
    assert.equal(brokenJobLinks.length,0);
    const totals=await local`select kind,f.key,sum((f.value#>>'{}')::numeric)::text total,
      count(*) filter(where f.value='null'::jsonb)::int unknown
      from child_after,jsonb_each(values) f group by 1,2 order by 1,2`;
    console.log(JSON.stringify({event:"child_value_preservation",...preserved,brokenJobLinks:0,totals,
      note:"Stored values preserved, not automatically repaired; source agreement is audited separately"}));
    for(const table of ["fleet_work_orders","fleet_proposed_work_orders"]){
      await local.unsafe(`CREATE INDEX ON ${table}(shop_id)`);
      await local.unsafe(`CREATE INDEX ON ${table}(shop_id,(lower(custom_fields->'invoiceHours'->>'id')))`);
      await local.unsafe(`ANALYZE ${table}`);
    }
    await local`SET statement_timeout='90s'`;
    const start="2026-09-18T00:00:00.000Z",end="2026-10-17T23:59:59.999Z";
    for(const table of ["fleet_work_orders","fleet_proposed_work_orders"]){
      const rows=await local.unsafe(INVOICE_HOURS_SQL.replaceAll("normalized_work_orders",table),
        [`{${fleetShops.join(",")}}`,start,end]);
      console.log(JSON.stringify({event:"fleet_report",label:table,rows:rows.length,
        bounded:rows.length>INVOICE_HOURS_MAX_ORDERS,
        summary:rows.length>INVOICE_HOURS_MAX_ORDERS?null:aggregateInvoiceHours(rows as any,new Date(start),new Date(end)).summary}));
      // Keep the real fleet cap intact. Independent shop scopes cannot share
      // invoice identities; their uncapped union is an offline diagnostic only.
      const all:any[]=[];
      for(const shop of fleetShops){
        const location=await local.unsafe(INVOICE_HOURS_SQL.replaceAll("normalized_work_orders",table),
          [`{${shop}}`,start,end]);
        assert.ok(location.length<=INVOICE_HOURS_MAX_ORDERS,"Location report row cap reached");
        all.push(...location);
        console.log(JSON.stringify({event:"location_report",label:table,shop,rows:location.length,
          summary:aggregateInvoiceHours(location as any,new Date(start),new Date(end)).summary}));
      }
      console.log(JSON.stringify({event:"fleet_location_union_diagnostic",label:table,rows:all.length,
        summary:aggregateInvoiceHours(all,new Date(start),new Date(end)).summary}));
    }
    const childDetails=await local`select table_name,reason,count(*)::int n from child_audit group by 1,2 order by 1,2`;
    const mismatchedFields=await local`select table_name,reason,f.field,count(*)::int n from child_audit,
      jsonb_array_elements_text(coalesce(details->'fields','[]'::jsonb)) f(field) group by 1,2,3 order by 1,2,3`;
    console.log(JSON.stringify({event:"child_financial_audit",auditedChildren,childReasons,childDetails,mismatchedFields,
      cacheCopies,archiveMatches,productionRepairSafe:false}));
    for(const [label,table] of [["before","normalized_work_orders"],["after_owner_separation","proposed_work_orders"]] as const){
      const {rows,summary}=await queryOwnerReport(local,table,shops,start,end);
      console.log(JSON.stringify({event:"owner_cohort_report",label,rows:rows.length,
        summary}));
    }
    // An all-date control checks actual hours too: excluding old invoices from the
    // requested period alone would not establish financial/report parity.
    const from="1900-01-01T00:00:00.000Z",until="9999-12-31T23:59:59.999Z";
    const {summary}=await queryOwnerReport(local,"proposed_work_orders",shops,from,until);
    assertOwnerFinancialControl(summary,{invoices:expectedInvoices,sold:expectedSold,presented:expectedPresented});
    console.log(JSON.stringify({event:"owner_all_date_financial_control",summary,evidenceScope,sourceTotalsMatchReport:true}));
    console.log(JSON.stringify({event:"owner_report_simulation_complete",parents,owners,structurallyPreservedChildren:plan.children.length,
      reasons,scope:"Same-PG-snapshot ten-location JWT fleet; retained campaign archives and caches read sequentially (not cross-store atomic)",
      childFinancialRowsRebuilt:false,productionWrites:0,providerRequests:0}));
  }finally{await local.end();await source.end();await mongo.close();}
}
main().catch(e=>{console.error(JSON.stringify({event:"owner_report_simulation_failed",code:e.code??e.name,
  reason:e.name==="AssertionError"?e.message:"Source or local operation failed"}));process.exitCode=1;});
