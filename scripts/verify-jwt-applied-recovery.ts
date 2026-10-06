import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import postgres from "postgres";
async function main() {
  const bundle=JSON.parse(readFileSync(process.argv[2],"utf8"));
  const result=JSON.parse(readFileSync(process.argv[3],"utf8"));
  assert.equal(result.apply,true); assert.equal(bundle.shopId,227);
  const applied=result.outcomes.filter((r:any)=>r.state==="applied");
  const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
    connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000"}});
  try {
    let net=0,total=0,jobs=0,lines=0;
    for(const r of applied) {
      const source=bundle.invoices.find((x:any)=>String(x.WorkOrderNumber)===r.wo);
      assert.ok(source);
      const rows=await pg.unsafe(`SELECT id,status,labor_total,grand_total,customer_id,vehicle_id,vehicle,
        (closed_date AT TIME ZONE 'UTC')::date::text AS date FROM normalized_work_orders
        WHERE shop_id=227 AND work_order_number=$1`,[r.wo]);
      assert.equal(rows.length,1);const w=rows[0];
      assert.equal(w.status,"closed");assert.equal(w.date,"2026-09-01");
      assert.equal(Math.round(Number(w.labor_total)*100),Math.round(source.Summary.LaborTotal*100));
      assert.equal(Math.round(Number(w.grand_total)*100),Math.round(source.Summary.GrandTotal*100));
      if(r.unlinkedVehicle) {assert.equal(w.vehicle_id,null);assert.equal(w.vehicle?.vin,null);}
      if(r.newVehicle) {
        const v=await pg.unsafe(`SELECT vin FROM normalized_vehicles WHERE shop_id=227 AND id=$1`,[w.vehicle_id]);
        assert.equal(v.length,1);
        assert.equal(v[0].vin,String(source.ServiceItem.VIN||source.ServiceItem.Lookup).trim().toUpperCase());
      }
      for(const [table,expected] of [["normalized_service_jobs",r.packages],["normalized_line_items",r.lines]]) {
        const c=await pg.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE shop_id=227 AND work_order_id=$1
          AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false)`,[w.id]);
        assert.equal(c[0].n,expected);
      }
      for(const deferred of source.DeferredServicePackages?.ItemCollection??[]) {
        const j=await pg.unsafe(`SELECT id,status FROM normalized_service_jobs WHERE shop_id=227
          AND work_order_id=$1 AND provenance->'sourceIds' @> $2::text::jsonb LIMIT 2`,
          [w.id,JSON.stringify([{system:"protractor",idValue:deferred.ID}])]);
        assert.equal(j.length,1);assert.equal(j[0].status,"deferred");
        const n=await pg.unsafe(`SELECT count(*)::int AS n FROM normalized_line_items WHERE shop_id=227 AND work_order_id=$1 AND service_job_id=$2`,
          [w.id,j[0].id]);
        assert.equal(n[0].n,deferred.ServicePackageLines.ItemCollection.length);
      }
      for(const [table,expected] of [["normalized_service_jobs",r.archivedJobs],["normalized_line_items",r.archivedLines]]) {
        if(expected===undefined) continue;
        const c=await pg.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE shop_id=227 AND work_order_id=$1
          AND (soft_delete->>'isDeleted')::boolean=true
          AND soft_delete->>'reason'='operator-approved obsolete invoice package'`,[w.id]);
        assert.equal(c[0].n,expected);
      }
      if(r.newCustomer) {
        const c=await pg.unsafe(`SELECT id FROM normalized_customers WHERE shop_id=227 AND
          (provenance->'sourceIds' @> $1::text::jsonb OR provenance->'sourceIds' @> $2::text::jsonb) LIMIT 3`,
          [JSON.stringify([{system:"protractor",idValue:source.Contact.ID}]),
           JSON.stringify([{system:"protractor",idValue:source.ID}])]);
        assert.equal(c.length,1,"Customer identity must resolve uniquely");
        assert.equal(c[0].id,w.customer_id);
      }
      net+=Math.round(Number(w.labor_total)*100);total+=Math.round(Number(w.grand_total)*100);
      jobs+=r.packages;lines+=r.lines;
    }
    console.log(JSON.stringify({verifiedApplied:applied.length,serviceJobs:jobs,lineItems:lines,
      sourceMatchedNetLabor:net/100,sourceMatchedInvoiceTotal:total/100,customerIdentityLinksVerified:true},null,2));
  } finally {await pg.end({timeout:5});}
}
main().catch(e=>{console.error("Read-only verification failed",{name:e.name,code:e.code});process.exitCode=1});
