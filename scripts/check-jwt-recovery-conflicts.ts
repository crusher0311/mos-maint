import postgres from "postgres";
import { readFileSync } from "node:fs";
import { captureApprovedRecoverySource } from "../lib/jwt-approved-recovery-source";

async function main() {
  const bundle=JSON.parse(readFileSync(process.argv[2],"utf8"));
  if(bundle.shopId!==227) throw Error("Unexpected shop");
  const {invoices}=captureApprovedRecoverySource(bundle.invoices);
  const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{
    max:1,connect_timeout:10,
    connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000"},
  });
  try {
    const numbers=invoices.flatMap(r=>[String(r.WorkOrderNumber),String(r.InvoiceNumber)]);
    const rows=await pg.unsafe(`SELECT id,work_order_number,status,provenance,soft_delete,
      vehicle_id,customer_id FROM normalized_work_orders
      WHERE shop_id=227 AND work_order_number=ANY($1::text[]) LIMIT 50`,
      [`{${numbers.join(",")}}`]);
    const counts={missing:0,matchingSource:0,conflicting:0,missingVehicleLinks:0,missingCustomerLinks:0};
    const conflicts:string[]=[];
    let unresolvedNewParents=0;
    let newMissingVehicles=0,newMissingCustomers=0,ambiguousParents=0;
    for(const r of invoices) {
      const matches=rows.filter(x=>x.work_order_number===String(r.WorkOrderNumber) ||
        x.work_order_number===String(r.InvoiceNumber));
      if(!matches.length) {
        counts.missing++;
        const vin=String(r.ServiceItem?.VIN || r.ServiceItem?.Lookup || "").trim().toUpperCase();
        const vehicles=await pg.unsafe(`SELECT id FROM normalized_vehicles
          WHERE shop_id=227 AND vin=$1 AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false) LIMIT 2`,[vin]);
        const customers=await pg.unsafe(`SELECT id FROM normalized_customers
          WHERE shop_id=227 AND (provenance->'sourceIds' @> $1::text::jsonb OR provenance->'sourceIds' @> $2::text::jsonb)
          AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false) LIMIT 2`,
          [JSON.stringify([{system:"protractor",idValue:String(r.Contact?.ID||"")}]),
           JSON.stringify([{system:"protractor",idValue:String(r.ID)}])]);
        if(!vehicles.length) newMissingVehicles++;
        if(!customers.length) newMissingCustomers++;
        if(vehicles.length>1 || customers.length>1) ambiguousParents++;
        if(vehicles.length!==1 || customers.length!==1) unresolvedNewParents++;
        continue;
      }
      const x=matches[0];
      const ids=x.provenance?.sourceIds;
      if(matches.length!==1 || x.work_order_number!==String(r.WorkOrderNumber) ||
        x.soft_delete?.isDeleted || !Array.isArray(ids) ||
        !ids.some((i:any)=>i.system==="protractor" && i.idValue===r.ID)) {
        counts.conflicting++;conflicts.push(String(r.WorkOrderNumber));continue;
      }
      counts.matchingSource++;
      if(!x.vehicle_id) counts.missingVehicleLinks++;
      if(!x.customer_id) counts.missingCustomerLinks++;
    }
    console.log(JSON.stringify({readOnly:true,counts,unresolvedNewParents,newMissingVehicles,newMissingCustomers,ambiguousParents,conflictingWorkOrders:conflicts},null,2));
  } finally {await pg.end({timeout:5});}
}
main().catch(()=>{console.error("Bounded recovery conflict check failed; no writes performed");process.exit(1)});
