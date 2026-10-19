import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { NormalizedIngestionService } from "../lib/integrations/core/normalized-ingestion";
import { preserveInvoiceIdentity } from "../lib/invoice-evidence-preservation";

const id = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
const evidence = { version: 1, id, date: "2026-10-16T12:00:00.000Z", sold: 4, presented: 5 };
const sourceIds = [{system:"protractor",idType:"invoice_id",idValue:id}];
const previous = { _id:"stored", shopId:25, version:1, createdAt:new Date(),
  customFields:{invoiceHours:evidence}, provenance:{sourceIds,contentHash:"old"}, softDelete:{} };
const partial = {ID:id,Type:"WorkOrder",WorkflowStage:"Invoice",InvoiceNumber:0,InvoiceTime:evidence.date};
async function ingest(existing: any, next: any, raw: any = partial, expectConflict=false) {
  const writes: any[] = [];
  const db: any = {collection:()=>({findOne:async()=>existing,
    insertOne:async(d:any)=>writes.push(d),updateOne:async()=>({matchedCount:1})})};
  const adapter: any = {sourceSystem:"protractor",getSourceIds:()=>sourceIds,
    extractVehicleFromWorkOrder:()=>null,extractCustomerFromWorkOrder:()=>null,
    extractServiceJobsFromWorkOrder:()=>[],
    mapWorkOrder:()=>({workOrderNumber:"123",status:"closed",grandTotal:10,
      customFields:{invoiceHours:next,other:"keep"}})};
  const service = new NormalizedIngestionService(db,"protractor",25,undefined,{
    dualWriteToSupabase:false,createAuditLog:false,dualWriteToJobIndex:false,
    dualWriteToRepairPatterns:false,syncRunId:"offline-test",
  },adapter);
  (service as any).supabaseDualWriter = {
    findWorkOrderByNaturalKey:async()=>existing,
    upsertWorkOrder:async(d:any)=>writes.push(d),
  };
  const result = await service.ingestWorkOrder(raw);
  if(expectConflict){
    assert.equal(result.success,false);
    assert.equal(result.action,"error");
    assert.equal(writes.length,0,"Identity conflicts must stop before parent writes");
    return null;
  }
  assert.equal(result.success,true,result.message);
  assert.ok(writes.length);
  for (const doc of writes) {
    assert.equal(doc.grandTotal,10);
    assert.deepEqual(doc.rawPayload,JSON.parse(JSON.stringify(raw.rawPayload || raw)),
      "Create and update must send the sanitized native payload to PostgreSQL");
    assert.notEqual(doc.rawPayload,raw.rawPayload || raw,"Retained payload must be a detached snapshot");
  }
  return writes[0];
}
async function main() {
  const other={system:"protractor",idType:"invoice_id",idValue:"11111111-1111-4111-8111-111111111111"};
  await ingest({...previous,provenance:{...previous.provenance,sourceIds:[other]}},evidence,partial,true);
  await ingest({...previous,provenance:{...previous.provenance,sourceIds:[...sourceIds,other]}},evidence,partial,true);
  assert.deepEqual((await ingest(null,evidence)).customFields,{invoiceHours:evidence,other:"keep"});
  const updated = await ingest(previous,null);
  assert.deepEqual(updated.customFields.invoiceHours,{...evidence,sold:null,presented:null});
  assert.deepEqual((await ingest(previous,evidence)).customFields.invoiceHours,evidence);
  await ingest(previous,evidence,{...partial,rawPayload:{...partial,ServicePackages:[],
    omitted:undefined,Header:{LastModifiedTime:new Date("2026-10-16T13:00:00Z")}}});
  for(const [old,raw] of [
    [{...previous,shopId:26},partial],
    [previous,{...partial,ID:"11111111-1111-4111-8111-111111111111"}],
    [previous,{...partial,InvoiceTime:"2026-10-15T12:00:00Z"}],
    [previous,{...partial,WorkflowStage:"Estimate"}],
    [{...previous,provenance:{sourceIds:[]}},partial],
  ]) assert.equal(preserveInvoiceIdentity(25,raw,old,{invoiceHours:null}).invoiceHours,null);
  console.log("PASS: actual create/update paths retain invoice metadata without stale hours or cross-identity carryover");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
