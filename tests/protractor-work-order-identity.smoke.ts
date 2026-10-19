import assert from "node:assert/strict";
import {getTableColumns} from "drizzle-orm";
import {drizzle} from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {userInfo} from "node:os";
import {normalizedWorkOrders} from "../lib/db/schema/normalized";
import {SupabaseDualWriter} from "../lib/supabase-dual-writer";
import {assertSameProtractorWorkOrder,protractorWorkOrderIdentity,protractorMongoIdentityFilter} from "../lib/protractor-work-order-identity";
const a="11111111-1111-1111-1111-111111111111",b="22222222-2222-2222-2222-222222222222";
const prov=(id:string)=>({sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"invoice_id",idValue:id,isPrimary:true}]});
async function main(){
  assertSameProtractorWorkOrder(prov(a),prov(a.toUpperCase()));
  for(const p of [prov(b),{...prov(a),sourceIds:[...prov(a).sourceIds,...prov(b).sourceIds]},{sourceIds:[]}]){
    assert.throws(()=>assertSameProtractorWorkOrder(p,prov(a)));
  }
  assert.throws(()=>protractorWorkOrderIdentity(prov("bad")));
  assert.throws(()=>protractorWorkOrderIdentity(null),/identity conflict/);
  assert.throws(()=>protractorWorkOrderIdentity({sourceIds:{}}),/identity conflict/);
  const filter=protractorMongoIdentityFilter({...prov(a),lastSeenAt:new Date()},prov(a));
  assert.equal("provenance" in filter,false,"Do not CAS full PG/Mongo provenance date representations");
  assert.deepEqual(filter["provenance.sourceIds"].$elemMatch.idValue.$in,[a]);
  assert.deepEqual(filter.$nor[0]["provenance.sourceIds"].$elemMatch.idValue.$nin,[a]);
  assert.throws(()=>protractorMongoIdentityFilter(prov(b),prov(a)));
  const port=Number(process.argv[2]);assert.ok(port>1024);
  const pg=postgres({host:"127.0.0.1",port,username:userInfo().username,database:"postgres",max:3});
  try{
    assert.equal((await pg`select current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
    // Real PG execution of the actual writer, including ON CONFLICT predicates.
    const columns=Object.values(getTableColumns(normalizedWorkOrders)).map(c=>{
      const type=c.getSQLType();
      const known=/^(varchar|text|integer|boolean|jsonb|timestamp|numeric|decimal|double precision|real)/.test(type);
      return `"${c.name}" ${known?type:"text"}${c.name==="id"?" PRIMARY KEY":""}`;
    });
    await pg.unsafe(`CREATE TABLE normalized_work_orders (${columns.join(",")}, UNIQUE(shop_id,work_order_number))`);
    const writer=new SupabaseDualWriter(drizzle(pg) as any);
    const doc=(id:string,p:any,num="100")=>({_id:id,shopId:1,workOrderNumber:num,provenance:p,grandTotal:10});
    await writer.upsertWorkOrder(doc("old",prov(a)));
    await assert.rejects(()=>writer.findWorkOrderByNaturalKey(1,prov(b).sourceIds[0],"100"));
    await assert.rejects(()=>writer.upsertWorkOrder(doc("new",prov(b))));
    await assert.rejects(()=>writer.upsertWorkOrder(doc("old",prov(b))));
    await writer.upsertWorkOrder({...doc("old",prov(a)),grandTotal:20});
    assert.equal(Number((await pg`select grand_total from normalized_work_orders where id='old'`)[0].grand_total),20);
    await pg`update normalized_work_orders set provenance=${JSON.stringify({...prov(a),sourceIds:[...prov(a).sourceIds,...prov(b).sourceIds]})}::text::jsonb where id='old'`;
    await assert.rejects(()=>writer.findWorkOrderByNaturalKey(1,prov(a).sourceIds[0],"100"));
    await assert.rejects(()=>writer.findWorkOrderByNaturalKey(1,prov(a).sourceIds[0],null));
    await assert.rejects(()=>writer.upsertWorkOrder(doc("old",prov(a))));
    const results=await Promise.allSettled([
      writer.upsertWorkOrder(doc("race-a",prov(a),"200")),
      writer.upsertWorkOrder(doc("race-b",prov(b),"200")),
    ]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    assert.equal((await pg`select count(*)::int n from normalized_work_orders where work_order_number='200'`)[0].n,1);
    await Promise.all([writer.upsertWorkOrder(doc("same",prov(a),"300")),writer.upsertWorkOrder(doc("same",prov(a),"300"))]);
    console.log("PASS identity-safe lookup, atomic PK veto, number collisions, mixed identities and concurrent retries");
  }finally{await pg.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
