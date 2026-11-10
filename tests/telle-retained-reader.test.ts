import "./helpers/deny-network-egress";
import test from "node:test";
import assert from "node:assert/strict";
import {sourceRows} from "../scripts/lib/telle-retained-reader";
test("PG retained reader remains scoped, bounded and parameterized",async()=>{
  let query="",parameters:unknown[]=[];
  const pg={unsafe:async(q:string,p:unknown[])=>{query=q;parameters=p;return [];}};
  await sourceRows(pg as any,{} as any,"pg.protractor_invoice_cache","cursor-value");
  assert.match(query,/shop_id=282/);assert.match(query,/LIMIT 50/);
  assert.match(query,/payload->'invoice'/);assert.match(query,/>\$1/);
  assert.deepEqual(parameters,["cursor-value"]);assert.doesNotMatch(query,/INSERT|UPDATE|DELETE/);
});
test("Mongo retained reader preserves numeric/string shop scope and read budget",async()=>{
  let name="",pipeline:any,options:any;
  const db={collection:(n:string)=>{name=n;return {aggregate:(p:any,o:any)=>{
    pipeline=p;options=o;return {toArray:async()=>[]};
  }};}};
  await sourceRows({} as any,db as any,"mongo.protractor_invoice_cache","");
  assert.equal(name,"protractor_invoice_cache");assert.deepEqual(pipeline[0].$match.shopId,{$in:[282,"282"]});
  assert.equal(pipeline[2].$limit,50);assert.deepEqual(options,{maxTimeMS:3000,allowDiskUse:false});
  assert.equal(pipeline.some((s:any)=>s.$out||s.$merge),false);
});
