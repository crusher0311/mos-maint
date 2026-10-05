/**
 * Fixed-scope operator recovery. No provider calls, Mongo writes, background jobs,
 * deletes, migrations or updates to existing customers/vehicles.
 * Default: read-only plan. --apply-approved performs one atomic PG transaction.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../lib/db/schema";
import { getAdapter, generateContentHash } from "../lib/integrations/core/normalized-adapter";
import { SupabaseDualWriter } from "../lib/supabase-dual-writer";
import { captureApprovedRecoverySource } from "../lib/jwt-approved-recovery-source";
import native from "../docs/reporting/jwt-701-september-1-native-identities.json";
import { getEnterpriseByShopId } from "../lib/enterprise";
import { getMongoClient } from "../lib/mongo";
import { resolveRecoveryVehicle } from "../lib/jwt-recovery-vehicle-resolution";
import monthlyNative from "../docs/reporting/jwt-701-september-recovery-candidates.json";

class Hold extends Error {}
class Rehearsal extends Error { constructor(public outcomes:any[]){super("rollback rehearsal");} }
let phase="initialization";
const cents=(v:any)=>Math.round(Number(v)*100);
const id=(kind:string,key:string)=>createHash("sha256").update(`jwt-recovery|227|${kind}|${key}`).digest("hex").slice(0,24);
const sourceMatch=(row:any,key:string)=>Array.isArray(row?.provenance?.sourceIds) &&
  row.provenance.sourceIds.some((s:any)=>s.system==="protractor" && String(s.idValue).toLowerCase()===key.toLowerCase());
const active=(r:any)=>!r.soft_delete?.isDeleted;
const adapter=getAdapter("protractor")!;
function validate(r:any) {
  const packages=r.ServicePackages?.ItemCollection;
  assert.ok(Array.isArray(packages));
  const pids=new Set(),lids=new Set();
  let net=0;
  for(const p of packages) {
    assert.ok(p && typeof p==="object");
    assert.ok(p.ID && !pids.has(p.ID)); pids.add(p.ID);
    assert.equal(p.IsInvoicing,true);
    assert.ok(Array.isArray(p.ServicePackageLines?.ItemCollection));
    for(const l of p.ServicePackageLines.ItemCollection) {
      assert.ok(l && typeof l==="object");
      assert.ok(l.ID && !lids.has(l.ID)); lids.add(l.ID);
      if(l.Type==="Labor") {
        for(const k of ["Total","Discount","ExtendedTotal","Quantity"]) assert.ok(Number.isFinite(l[k]));
        assert.equal(cents(l.Total)-cents(l.Discount),cents(l.ExtendedTotal));
        net+=cents(l.ExtendedTotal);
      }
    }
  }
  assert.equal(net,cents(r.Summary.LaborTotal));
  assert.equal(cents(adapter.mapWorkOrder(227,r).laborTotal),net);
}
function doc(mapped:any,raw:any,old:any,kind:string,enterpriseId:string,sourceIds?:any[]) {
  const now=new Date();
  return {...old?.raw_data,...mapped,_id:old?.id??id(kind,raw.ID),shopId:227,enterpriseId,
    createdAt:old?.created_at?new Date(old.created_at):now,updatedAt:now,version:(old?.version??0)+1,
    softDelete:{isDeleted:false},rawPayload:raw,
    customFields:{...old?.custom_fields,...mapped.customFields},
    provenance:{...old?.provenance,sourceSystem:"protractor",
      sourceIds:sourceIds??adapter.getSourceIds(raw),contentHash:generateContentHash(mapped),
      lastSeenAt:now,lastSyncedAt:now,syncRunId:"jwt-approved-september-1-recovery"}};
}
export async function recoverJwtSource(text:string, options:{monthly?:boolean;apply?:boolean;rehearse?:boolean;finalFour?:boolean}={}) {
  const rehearse=!!options.rehearse;
  const apply=!!options.apply || rehearse;
  const finalFour=!!options.finalFour;
  const monthly=!!options.monthly;
  const bundle=JSON.parse(text);
  assert.equal(bundle.shopId,227); assert.equal(bundle.location,"701");
  let invoices:any[];
  if(monthly) {
    assert.equal(bundle.invoices.length,1);
    const r=bundle.invoices[0];
    const n=monthlyNative.find(n=>n.wo===String(r.WorkOrderNumber)&&n.invoice===String(r.InvoiceNumber));
    assert.ok(n && ["absent_by_both_numbers","nonterminal"].includes(n.classification),"Outside approved automatic scope");
    assert.equal(bundle.date,n.date);
    assert.equal(String(r.InvoiceTime).slice(0,10),n.date);
    assert.ok(Number.isFinite(Date.parse(r.InvoiceTime)));
    assert.equal(new Date(r.InvoiceTime).toISOString().slice(0,10),n.date);
    assert.equal(r.WorkflowStage,"Invoice");
    assert.ok(["WorkOrder","Invoice"].includes(r.Type));
    assert.ok(r.Status==null || ["Invoice","Invoiced","Paid","Closed"].includes(r.Status));
    assert.match(r.ID,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    invoices=[r];
  } else {
    assert.equal(bundle.date,"2026-09-01"); assert.equal(bundle.invoices.length,21);
    invoices=captureApprovedRecoverySource(bundle.invoices).invoices;
  }
  invoices.forEach(validate);
  const enterprise=await getEnterpriseByShopId(227);
  if(!enterprise || enterprise.name!=="JWT" || !enterprise.shopIds.some(s=>Number(s)===227)) throw new Error("Membership check failed");
  const enterpriseId=String(enterprise._id);
  const digest=createHash("sha256").update(text).digest("hex");
  if(finalFour) assert.equal(digest,"a102bd5aa6ea69253df6e07760bbd1a5a99f39e75ff540e35b12d8474f6a09dd");
  // CLI has an explicit production URL; deployed requests use the same
  // canonical connection selection as the application's normalized writer.
  const databaseUrl=process.env.SUPABASE_PROD_DATABASE_URL ||
    (monthly?(process.env.DATAONE_DATABASE_URL||process.env.DATABASE_URL):undefined);
  if(!databaseUrl) throw new Error("Recovery database is not configured");
  const pg=postgres(databaseUrl,{max:1,connect_timeout:10,
    connection:{options:`-c statement_timeout=5000 -c lock_timeout=2000${apply?"":" -c default_transaction_read_only=on"}`}});
  try {
    const result=await pg.begin(async tx=>{
      const lock=apply?" FOR UPDATE":"";
      const outcomes:any[]=[];
      const excluded=await tx.unsafe(`SELECT md5(to_jsonb(w)::text) AS hash FROM normalized_work_orders w
        WHERE shop_id=227 AND work_order_number='701008320'`);
      assert.equal(excluded.length,1);
      const numbers=invoices.map(r=>String(r.WorkOrderNumber));
      const vins=invoices.map(r=>String(r.ServiceItem?.VIN||r.ServiceItem?.Lookup||"").trim().toUpperCase()).filter(Boolean);
      const parents:Record<string,any[]>={};
      phase="protected-parent-identities";
      const parentIds=await tx.unsafe(`SELECT customer_id,vehicle_id FROM normalized_work_orders
        WHERE shop_id=227 AND work_order_number=ANY($1::text[])`,[numbers]);
      const vinIds=await tx.unsafe(`SELECT id FROM normalized_vehicles WHERE shop_id=227 AND vin=ANY($1::text[])`,[vins]);
      for(const table of ["normalized_customers","normalized_vehicles"]) {
        const fk=table==="normalized_customers"?"customer_id":"vehicle_id";
        phase=`protected-${table}`;
        const ids=[...new Set([...parentIds.map(r=>r[fk]),...(fk==="vehicle_id"?vinIds.map(r=>r.id):[])].filter(Boolean))];
        parents[table]=await tx.unsafe(`SELECT id,md5(to_jsonb(p)::text) AS hash FROM ${table} p
          WHERE shop_id=227 AND id=ANY($1::text[])`,[ids]);
      }
      for(const r of invoices) {
        try {
          const outcome=await tx.savepoint(async t=>{
            phase=`${r.WorkOrderNumber}:header`;
            // postgres-js savepoint clients omit options; expose only the parent
            // parser configuration, while all SQL still uses the savepoint client.
            const db=drizzle(Object.assign(t,{options:pg.options}) as any,{schema});
            const writer=new SupabaseDualWriter(db);
            const current=await t.unsafe(`SELECT *,md5(to_jsonb(normalized_work_orders)::text) AS recovery_row_hash FROM normalized_work_orders
              WHERE shop_id=227 AND work_order_number=ANY($1::text[]) LIMIT 3${lock}`,
              [`{${r.WorkOrderNumber},${r.InvoiceNumber}}`]);
            if(current.length>1) throw new Hold("multiple invoice identities");
            const old=current[0];
            const expected=(monthly?monthlyNative:native).find(n=>n.wo===String(r.WorkOrderNumber))!;
            if(old && (!active(old) || old.work_order_number!==String(r.WorkOrderNumber) || !sourceMatch(old,r.ID)))
              throw new Hold("identity or deletion conflict");
            const previouslyApplied=old?.raw_data?.customFields?.jwtRecoverySourceDigest===digest;
            const packages=adapter.extractRawServiceJobsFromWorkOrder(r);
            if(previouslyApplied && !packages.some(p=>p._isDeferred))
              return {wo:String(r.WorkOrderNumber),state:"already-applied"};
            if(!previouslyApplied && (expected.classification==="absent_by_both_numbers" ? !!old :
              (!old || !["draft","scheduled","inspection_in_progress",...(monthly?["work_complete"]:[])].includes(old.status) || old.closed_date || (!monthly&&old.completed_date))))
              throw new Hold("record changed since approved assessment");
            const vin=String(r.ServiceItem?.VIN||r.ServiceItem?.Lookup||"").trim().toUpperCase();
            const contact=r.Contact;
            if(!contact?.ID || /^0+-0+-0+-0+-0+$/.test(contact.ID)) throw new Hold("missing contact identity");
            phase=`${r.WorkOrderNumber}:vehicle`;
            const vehicleCandidates=await t.unsafe(`SELECT * FROM normalized_vehicles
              WHERE shop_id=227 AND (vin=$1 OR id=$2) LIMIT 3${lock}`,[vin,old?.vehicle_id??""]);
            let resolved;
            try {resolved=resolveRecoveryVehicle(r,old,vehicleCandidates,{
              replaceFromInvoice:finalFour && String(r.WorkOrderNumber)==="701008306",
              unknownVehicle:(finalFour && String(r.WorkOrderNumber)==="701008340") ||
                (monthly && !old && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))});}
            catch(e) {throw new Hold((e as Error).message);}
            const vehicles=resolved.vehicle?[resolved.vehicle]:[];
            const name=[contact.Name?.FirstName,contact.Name?.LastName].filter(Boolean).join(" ")||contact.FileAs||contact.Company||"";
            phase=`${r.WorkOrderNumber}:customer-identity`;
            const customers=old?.customer_id ?
              await t.unsafe(`SELECT * FROM normalized_customers WHERE shop_id=227 AND id=$1${lock}`,[old.customer_id]) :
              await t.unsafe(`SELECT * FROM normalized_customers WHERE shop_id=227 AND
                (provenance->'sourceIds' @> $1::text::jsonb OR provenance->'sourceIds' @> $2::text::jsonb) LIMIT 11${lock}`,
              [JSON.stringify([{system:"protractor",idValue:contact.ID}]),
                JSON.stringify([{system:"protractor",idValue:r.ID}])]);
            if(!customers.length && name) {
              phase=`${r.WorkOrderNumber}:customer-name`;
              // Exact indexed candidate checks; names alone never authorize a merge.
              const names=[...new Set([name,contact.FileAs,name.toUpperCase(),name.toLowerCase()].filter(Boolean))];
              const candidates=await t.unsafe(`SELECT id FROM normalized_customers WHERE shop_id=227
                AND full_name=ANY($1::text[]) LIMIT 2`,[names]);
              if(candidates.length) throw new Hold("customer name candidate requires identity resolution");
            }
            if(customers.length>1 || customers.some(c=>!active(c) ||
              !(c.id===old?.customer_id || sourceMatch(c,contact.ID) || sourceMatch(c,r.ID))))
              throw new Hold("ambiguous customer; no automatic duplicate creation");
            const vehicleId=resolved.unlinked?null:vehicles[0]?.id??id("vehicle",vin);
            const customerId=customers[0]?.id??id("customer",contact.ID);
            const woId=old?.id??id("work_order",r.ID);
            phase=`${r.WorkOrderNumber}:children`;
            const allJobs=old ? await t.unsafe(`SELECT * FROM normalized_service_jobs
              WHERE shop_id=227 AND work_order_id=$1 LIMIT 501${lock}`,[woId]) : [];
            const allLines=old ? await t.unsafe(`SELECT * FROM normalized_line_items
              WHERE shop_id=227 AND work_order_id=$1 LIMIT 1001${lock}`,[woId]) : [];
            if(allJobs.length>500||allLines.length>1000) throw new Hold("child row cap exceeded");
            const sourceLines=packages.flatMap((p:any)=>p.ServicePackageLines.ItemCollection);
            const archiveApprovals:Record<string,{id:string;title:string;cents:number}>={
              "701008322":{id:"6a96d10b7cc6ad7f60f2b40c",title:"Brake System Evaluation",cents:2995},
              "701008327":{id:"6a96e8537cc6ad7f60f38c12",title:"Digital Vehicle Inspection",cents:0}};
            const archiveApproval=archiveApprovals[String(r.WorkOrderNumber)];
            const ownedArchive=(x:any)=>x.soft_delete?.isDeleted &&
              x.soft_delete?.recoverySourceDigest===digest &&
              x.soft_delete?.reason==="operator-approved obsolete invoice package";
            const archivedJobs=allJobs.filter(j=>ownedArchive(j));
            const toArchiveJobs=finalFour && archiveApproval ?
              allJobs.filter(j=>j.id===archiveApproval.id && active(j)):[];
            if(toArchiveJobs.length) {
              const j=toArchiveJobs[0];
              assert.equal(j.title,archiveApproval.title);assert.equal(j.status,"completed");
              assert.equal(cents(j.total),archiveApproval.cents);
              assert.ok(!packages.some(p=>sourceMatch(j,p.ID)));
            }
            const toArchiveLines=allLines.filter(l=>toArchiveJobs.some(j=>j.id===l.service_job_id));
            for(const l of toArchiveLines) {
              assert.ok(active(l));
              assert.ok(!sourceLines.some((s:any)=>sourceMatch(l,s.ID)));
            }
            const jobs=allJobs.filter(j=>!archivedJobs.includes(j)&&!toArchiveJobs.includes(j));
            const lines=allLines.filter(l=>!toArchiveLines.includes(l)&&
              !(ownedArchive(l)&&archivedJobs.some(j=>j.id===l.service_job_id)));
            for(const [existing,raw] of [[jobs,packages],[lines,sourceLines]] as any)
              for(const row of existing) if(!active(row)||raw.filter((v:any)=>sourceMatch(row,v.ID)).length!==1)
                throw new Hold("existing service detail not represented by fresh source");
            const mapped=adapter.mapWorkOrder(227,r,enterpriseId);
            const work=doc(mapped,r,old,"work_order",enterpriseId);
            if(work.startedDate) work.startedDate=new Date(work.startedDate);
            work.vehicleId=vehicleId;work.customerId=customerId;
            if(resolved.unlinked) {
              work.vehicle={...work.vehicle,vin:null};
              work.customFields.recoveryVehicleIdentity="unknown; source side-by-side; no verified vehicle link";
            }
            work.customFields.jwtRecoverySourceDigest=digest;
            const jobsToWrite:any[]=[],linesToWrite:any[]=[];
            for(const p of packages) {
              const matches=jobs.filter(j=>sourceMatch(j,p.ID));
              if(matches.length>1) throw new Hold("duplicate service identity");
              const job=doc(adapter.mapServiceJob(227,woId,p),p,matches[0],"job",enterpriseId);
              jobsToWrite.push(job);
              for(const l of p.ServicePackageLines.ItemCollection) {
                const matches=lines.filter(x=>sourceMatch(x,l.ID));
                if(matches.length>1 || matches.some(x=>x.service_job_id!==job._id)) throw new Hold("line ownership conflict");
                linesToWrite.push(doc(adapter.mapLineItem(227,woId,job._id,l),l,matches[0],"line",enterpriseId));
              }
            }
            const missingJobs=jobsToWrite.filter(j=>!jobs.some(x=>x.id===j._id));
            const missingLines=linesToWrite.filter(l=>!lines.some(x=>x.id===l._id));
            if(previouslyApplied) {
              if(!missingJobs.length && !missingLines.length)
                return {wo:String(r.WorkOrderNumber),state:"already-applied"};
              if(missingJobs.some(j=>j.status!=="deferred") ||
                missingLines.some(l=>!missingJobs.some(j=>j._id===l.serviceJobId)))
                throw new Hold("already-applied invoice needs non-deferred detail review");
            }
            if(apply) {
              phase=`${r.WorkOrderNumber}:write`;
              // Plain inserts for new entities: never conflict-update a concurrently
              // created customer/vehicle or silently repoint the work-order identity.
              if(!vehicles.length && !resolved.unlinked) {
                const v=adapter.mapVehicle(227,r,enterpriseId);
                await db.insert(schema.normalizedVehicles).values({id:vehicleId!,shopId:227,enterpriseId,
                  vin,year:v.year,make:v.make,model:v.model,
                  provenance:{sourceSystem:"protractor",sourceIds:[
                    {system:"protractor",idType:"service_item_id",idValue:r.ServiceItem.ID}]},
                  rawData:{rawPayload:r.ServiceItem}});
              }
              if(!customers.length) await db.insert(schema.normalizedCustomers).values({
                id:customerId,shopId:227,enterpriseId,fullName:name,
                firstName:contact.Name?.FirstName??null,lastName:contact.Name?.LastName??null,
                companyName:contact.Company||null,
                provenance:{sourceSystem:"protractor",sourceIds:[...adapter.getSourceIds(r),{system:"protractor",idType:"contact_id",idValue:contact.ID}]},
                rawData:{rawPayload:contact}});
              if(!old) await db.insert(schema.normalizedWorkOrders).values({
                id:woId,shopId:227,workOrderNumber:String(r.WorkOrderNumber),provenance:work.provenance});
              for(const [table,rows] of [["normalized_service_jobs",toArchiveJobs],["normalized_line_items",toArchiveLines]] as const) {
                for(const row of rows) {
                  const before=await t.unsafe(`SELECT md5((to_jsonb(x)-'soft_delete')::text) AS hash FROM ${table} x WHERE id=$1`,[row.id]);
                  await t.unsafe(`UPDATE ${table} SET soft_delete=$1::text::jsonb WHERE shop_id=227 AND work_order_id=$2 AND id=$3`,
                    [JSON.stringify({...row.soft_delete,isDeleted:true,deletedAt:new Date().toISOString(),
                      reason:"operator-approved obsolete invoice package",recoverySourceDigest:digest}),woId,row.id]);
                  const after=await t.unsafe(`SELECT md5((to_jsonb(x)-'soft_delete')::text) AS hash FROM ${table} x WHERE id=$1`,[row.id]);
                  assert.equal(after[0].hash,before[0].hash);
                }
              }
              if(!previouslyApplied) await writer.upsertWorkOrder(work);
              for(const j of previouslyApplied?missingJobs:jobsToWrite) {
                if(!jobs.some(x=>x.id===j._id)) await db.insert(schema.normalizedServiceJobs).values({
                  id:j._id,shopId:227,workOrderId:woId,title:j.title,provenance:j.provenance});
                await writer.upsertServiceJob(j);
              }
              for(const l of previouslyApplied?missingLines:linesToWrite) {
                if(!lines.some(x=>x.id===l._id)) await db.insert(schema.normalizedLineItems).values({
                  id:l._id,shopId:227,workOrderId:woId,serviceJobId:l.serviceJobId,lineType:l.lineType,
                  lineNumber:l.lineNumber??0,partDescription:l.partDescription??"Unknown Item",provenance:l.provenance});
                await writer.upsertLineItem(l);
              }
              const check=await t.unsafe(`SELECT status,labor_total,grand_total,
                (closed_date AT TIME ZONE 'UTC')::date::text AS business_date
                FROM normalized_work_orders WHERE id=$1 AND shop_id=227`,[woId]);
              assert.equal(check[0]?.status,"closed");
              assert.equal(check[0].business_date,bundle.date);
              assert.equal(cents(check[0].labor_total),cents(r.Summary.LaborTotal));
              assert.equal(cents(check[0].grand_total),cents(r.Summary.GrandTotal));
              const totals=await t.unsafe(`SELECT count(*)::int AS n FROM normalized_line_items WHERE shop_id=227 AND work_order_id=$1
                AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false)`,[woId]);
              assert.equal(totals[0].n,sourceLines.length);
              const jobCount=await t.unsafe(`SELECT count(*)::int AS n FROM normalized_service_jobs
                WHERE shop_id=227 AND work_order_id=$1 AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false)`,[woId]);
              assert.equal(jobCount[0].n,packages.length);
              if(previouslyApplied) {
                const unchanged=await t.unsafe(`SELECT md5(to_jsonb(w)::text) AS hash FROM normalized_work_orders w WHERE id=$1`,[woId]);
                assert.equal(unchanged[0].hash,old.recovery_row_hash);
              }
            }
            return {wo:String(r.WorkOrderNumber),state:apply?"applied":"ready",
              action:previouslyApplied?"complete-deferred":old?"refresh":"insert",newVehicle:!vehicles.length&&!resolved.unlinked,newCustomer:!customers.length,
              unlinkedVehicle:!!resolved.unlinked,archivedJobs:toArchiveJobs.length,archivedLines:toArchiveLines.length,
              packages:jobsToWrite.length,lines:linesToWrite.length};
          });
          outcomes.push(outcome);
        } catch(e) {
          if(e instanceof Hold) outcomes.push({wo:String(r.WorkOrderNumber),state:"held",reason:e.message});
          else throw e; // Any unexpected error rolls back the WHOLE cohort.
        }
      }
      // Protect the excluded invoice and every pre-existing related entity.
      const excludedAfter=await tx.unsafe(`SELECT md5(to_jsonb(w)::text) AS hash FROM normalized_work_orders w
        WHERE shop_id=227 AND work_order_number='701008320'`);
      assert.equal(excludedAfter[0]?.hash,excluded[0].hash);
      for(const [table,before] of Object.entries(parents)) {
        const after=await tx.unsafe(`SELECT id,md5(to_jsonb(p)::text) AS hash FROM ${table} p WHERE shop_id=227 AND id=ANY($1::text[])`,
          [before.map(r=>r.id)]);
        assert.equal(after.length,before.length);
        for(const row of before) assert.equal(after.find(r=>r.id===row.id)?.hash,row.hash);
      }
      console.error("Protected-record checks passed: excluded invoice and existing customers/vehicles unchanged.");
      if(rehearse) throw new Rehearsal(outcomes);
      return outcomes;
    }).catch(e=>{if(e instanceof Rehearsal)return e.outcomes;throw e;});
    return {apply:apply&&!rehearse,rehearsalRolledBack:rehearse,sourceDigest:digest,outcomes:result};
  } finally {await pg.end({timeout:5});}
}
if(process.argv[1]?.endsWith("/recover-jwt-approved-invoices.ts")) recoverJwtSource(readFileSync(process.argv[2],"utf8"),{
  apply:process.argv.includes("--apply-approved"),rehearse:process.argv.includes("--rehearse-approved"),
  finalFour:process.argv.includes("--approved-final-four"),
}).then(result=>console.log(JSON.stringify(result,null,2))).catch(e=>{console.error("Recovery failed. Reconcile commit state read-only before retrying writes.",{phase,name:e?.name,code:e?.code,
  location:typeof e?.stack==="string"?e.stack.split("\n").slice(1,3).map((s:string)=>s.trim()):[]});
  process.exitCode=1;
}).finally(async()=>{await(await getMongoClient()).close();});
