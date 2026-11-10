import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { userInfo } from "node:os";
import {
  normalizedWorkOrders, normalizedServiceJobs, normalizedLineItems, normalizedPayments,
} from "../lib/db/schema/normalized";
import { SupabaseDualWriter } from "../lib/supabase-dual-writer";
import { NormalizedIngestionService } from "../lib/integrations/core/normalized-ingestion";
import { getAdapter } from "../lib/integrations/core/normalized-adapter";

const provenance = (id = "provider-1", system = "tekmetric") => ({
  sourceSystem: system,
  sourceIds: [{ system, idType: "repair_order_id", idValue: id, isPrimary: true }],
});
const doc = (id: string, number: string, owner = provenance(), shopId = 97) => ({
  _id: id, workOrderNumber: number, shopId, provenance: owner, grandTotal: 10,
});

async function main() {
  const socket = process.argv[2];
  assert.match(socket, /^\/tmp\/parent-identity\.[^/]+$/);
  const pg = postgres({ host: socket, username: userInfo().username, database: "postgres", max: 4 });
  try {
    assert.equal((await pg`select current_setting('parent_identity.disposable',true) marker`)[0].marker, "yes");
    const enums = new Set<string>();
    for (const [name, table, constraints] of [
      ["normalized_work_orders", normalizedWorkOrders, "UNIQUE(shop_id,work_order_number)"],
      ["normalized_service_jobs", normalizedServiceJobs, "FOREIGN KEY(work_order_id) REFERENCES normalized_work_orders(id)"],
      ["normalized_line_items", normalizedLineItems, "FOREIGN KEY(work_order_id) REFERENCES normalized_work_orders(id), FOREIGN KEY(service_job_id) REFERENCES normalized_service_jobs(id)"],
      ["normalized_payments", normalizedPayments, "FOREIGN KEY(work_order_id) REFERENCES normalized_work_orders(id)"],
    ] as const) {
      for (const column of Object.values(getTableColumns(table))) {
        if (column.enumValues?.length && !enums.has(column.getSQLType())) {
          const type = column.getSQLType();
          await pg.unsafe(`CREATE TYPE ${type} AS ENUM (${column.enumValues.map((v: string) => `'${v}'`).join(",")})`);
          enums.add(type);
        }
      }
      const columns = Object.values(getTableColumns(table)).map(c =>
        `"${c.name}" ${c.getSQLType()}${c.name === "id" ? " PRIMARY KEY" : ""}`);
      await pg.unsafe(`CREATE TABLE ${name} (${columns.join(",")}, ${constraints})`);
    }
    const writer = new SupabaseDualWriter(drizzle(pg) as any);
    await writer.upsertWorkOrder(doc("parent", "fixture-ro"));
    await writer.upsertServiceJob({_id:"job",shopId:97,workOrderId:"parent",title:"fixture",provenance:provenance("job-1")});
    const adapter = getAdapter("tekmetric")!;
    const lines = adapter.extractLineItemsFromServiceJob({parts:[{id:12345,quantity:1,retail:1000,name:"Fixture part"}]});
    const shadows = new Map<string, any>();
    const mongo = {collection:()=>({findOne:async()=>null,insertOne:async()=>({acknowledged:true}),updateOne:async(filter:any, update:any)=>{
      const value=update.$setOnInsert;
      if(value){assert.equal(value._id,filter._id);if(!shadows.has(filter._id))shadows.set(filter._id,value);}
      return {matchedCount:1};
    }})};
    const svc = () => {
      const result = new NormalizedIngestionService(mongo as any,"tekmetric",97,undefined,{
        dualWriteToSupabase:false,createAuditLog:false,dualWriteToJobIndex:false,dualWriteToRepairPatterns:false,
      },adapter);
      (result as any).supabaseDualWriter=writer;
      return result;
    };
    // Synchronize the two ACTUAL DB reads before either caller can insert.
    const read = writer.findLineItemByNaturalKey.bind(writer);
    let reached=0;
    let release!:()=>void;
    const bothRead=new Promise<void>(resolve=>{release=resolve});
    writer.findLineItemByNaturalKey=async(...args)=>{
      const row=await read(...args);
      assert.equal(row,null);
      if(++reached===2)release();
      await bothRead;
      return row;
    };
    const raced=await Promise.all([svc().ingestLineItem("parent","job",lines[0]),svc().ingestLineItem("parent","job",lines[0])]);
    assert.ok(raced.every(r=>r.success),JSON.stringify(raced));
    assert.equal(raced[0].entityId,raced[1].entityId);
    assert.deepEqual(raced.map(r=>r.action).sort(),["created","updated"]);
    assert.equal(shadows.size,1);assert.ok(shadows.has(raced[0].entityId!));
    const duplicates=await pg`select id,service_job_id,provenance,extended_price from normalized_line_items`;
    assert.equal(duplicates.length,1);
    assert.ok(duplicates.every(row=>row.service_job_id==="job"&&row.provenance.sourceIds[0].idValue==="part-12345"));
    console.log("PASS concurrent creates reuse one canonical line");
    writer.findLineItemByNaturalKey=read;
    const repeat=await svc().ingestLineItem("parent","job",lines[0]);
    assert.equal(repeat.action,"skipped");
    assert.equal((await pg`select count(*)::int n from normalized_line_items`)[0].n,1);
    console.log("PASS repeat skips the single persisted line");
    const sequential=adapter.extractLineItemsFromServiceJob({parts:[{id:54321,quantity:1,retail:2000,name:"Sequential part"}]})[0];
    assert.equal((await svc().ingestLineItem("parent","job",sequential)).action,"created");
    assert.equal((await svc().ingestLineItem("parent","job",sequential)).action,"skipped");
    console.log("CONTROL: sequential same-part ingestion creates only one row");
    const otherType=adapter.extractLineItemsFromServiceJob({labor:[{id:54321,name:"Separate labor",hours:1,rate:5000}]})[0];
    assert.notEqual(otherType._sourceId,sequential._sourceId);
    assert.equal(otherType.id,sequential.id);
    assert.equal((await svc().ingestLineItem("parent","job",otherType)).action,"created");
    const overwritten=await pg`select line_type from normalized_line_items where provenance->'sourceIds' @> '[{"idValue":"part-54321"}]'::jsonb OR provenance->'sourceIds' @> '[{"idValue":"labor-54321"}]'::jsonb`;
    assert.equal(overwritten.length,2);assert.deepEqual(overwritten.map(r=>r.line_type).sort(),["labor","part"]);
    console.log("PASS equal numeric labor/part IDs remain separate");
    const legacy={_id:"legacy-line",shopId:97,workOrderId:"parent",serviceJobId:"job",lineType:"part",partDescription:"Legacy",quantity:1,unitPrice:10,extendedPrice:10,
      provenance:{sourceSystem:"tekmetric",sourceIds:[{system:"tekmetric",idType:"line_item_id",idValue:"77",isPrimary:true}]}};
    await writer.upsertLineItem(legacy);
    const legacySource=adapter.extractLineItemsFromServiceJob({parts:[{id:77,name:"Legacy updated",retail:1500,quantity:1}]})[0];
    const updated=await svc().ingestLineItem("parent","job",legacySource);
    assert.equal(updated.entityId,"legacy-line");assert.equal(updated.action,"updated");
    assert.equal((await svc().ingestLineItem("parent","job",legacySource)).action,"skipped");
    console.log("PASS legacy numeric identity retains original ID and updated hash");
    await pg`INSERT INTO normalized_line_items (id,shop_id,work_order_id,service_job_id,line_type,provenance) VALUES ('ambiguous',97,'parent','job','part',${JSON.stringify(legacy.provenance)}::jsonb)`;
    const blocked=await svc().ingestLineItem("parent","job",legacySource);
    assert.equal(blocked.success,false);assert.match(blocked.message!,/Ambiguous/);
    await assert.rejects(()=>writer.upsertLineItem({...legacy,_id:"new-ambiguous"}),/Ambiguous/);
    assert.equal((await pg`select count(*)::int n from normalized_line_items where id in ('legacy-line','ambiguous')`)[0].n,2);
    console.log("PASS pre-existing duplicates fail closed without cleanup or another insert");
    await assert.rejects(()=>writer.upsertLineItem({...legacy,_id:"cross-shop",shopId:98}),/parent scope/);
    await assert.rejects(()=>writer.upsertLineItem({...legacy,_id:"cross-parent",workOrderId:"wrong"}),/parent scope/);
    await assert.rejects(()=>writer.upsertLineItem({...legacy,_id:raced[0].entityId,provenance:{...legacy.provenance,sourceIds:[{system:"tekmetric",idType:"line_item_id",idValue:"different"}]}}),/ID ownership/);
    console.log("PASS shop, parent and local ID scope conflicts rejected");
    const locked={...legacy,_id:"lock-test",provenance:{...legacy.provenance,sourceIds:[{system:"tekmetric",idType:"line_item_id",idValue:"99"}]}};
    await pg.begin(async hold=>{
      const key=JSON.stringify(['tekmetric-line',97,'job','part','99']);
      await hold.unsafe("select pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      await assert.rejects(()=>writer.upsertLineItem(locked));
    });
    assert.equal((await pg`select count(*)::int n from normalized_line_items where id='lock-test'`)[0].n,0);
    assert.equal(await writer.upsertLineItem(locked),'lock-test');
    console.log("PASS contended lock times out without partial write and later retry succeeds");
  } finally { await pg.end(); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
