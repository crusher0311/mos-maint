import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import type {Db} from "mongodb";

export async function retainedArchives(db:Db,shop:number,cutoff:Date){
  const copies=new Map<string,any[]>();
  let pages=0,invoices=0;
  for(const campaign of ["protractor-weekend-2026-10-17","invoice-evidence-recovery-2026-10-17"]){
    const prefix=`${campaign}:${shop}:`;
    const cursor=db.collection<any>("operator_history_import_pages").find(
      {_id:{$gte:prefix,$lt:`${campaign}:${shop};`},capturedAt:{$lte:cutoff}},
      {projection:{shopId:1,invoices:1,digest:1},maxTimeMS:5000})
      .sort({_id:1}).limit(2001).batchSize(5);
    let campaignPages=0;
    for await(const page of cursor){
      assert.ok(++campaignPages<=2000,"Archive page cap reached");
      assert.equal(page.shopId,shop);
      assert.ok(Array.isArray(page.invoices)&&page.invoices.length<=100);
      assert.equal(createHash("sha256").update(JSON.stringify(page.invoices)).digest("hex"),page.digest);
      pages++;invoices+=page.invoices.length;
      for(const raw of page.invoices){
        const id=String(raw.ID??"").toLowerCase();
        copies.set(id,[...(copies.get(id)??[]),raw]);
      }
      await new Promise(r=>setTimeout(r,25));
    }
  }
  console.log(JSON.stringify({event:"retained_archive_scope",shop,pages,invoices,cutoff:cutoff.toISOString()}));
  return copies;
}

export async function captureFleet(sql:any,local:any,shops:number[]){
  let total=0;
  for(const shop of shops){
    const ids=await sql`select id from normalized_work_orders where shop_id=${shop} limit 100001`;
    assert.ok(ids.length<=100000,"Fleet per-shop cap reached");
    total+=ids.length;assert.ok(total<=500000,"Fleet total cap reached");
    for(let offset=0;offset<ids.length;offset+=250){
      const rows=await sql`select id,shop_id,status,soft_delete,provenance,custom_fields
        from normalized_work_orders where shop_id=${shop} and id=any(${sql.array(ids.slice(offset,offset+250).map((r:any)=>r.id))})`;
      await local`insert into fleet_work_orders ${local(rows.map((r:any)=>({...r,id:createHash("sha256").update(`${shop}:${r.id}`).digest("hex")})),
        "id","shop_id","status","soft_delete","provenance","custom_fields")}`;
      await new Promise(r=>setTimeout(r,50));
    }
    console.log(JSON.stringify({event:"fleet_snapshot_shop",shop,rows:ids.length}));
  }
  await local`insert into fleet_proposed_work_orders select * from fleet_work_orders`;
  return total;
}
