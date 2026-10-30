import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

test("real disposable PG adapter atomically preserves DOTs and permits explicit clears", {timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),"dot-pg-"));
 const env={PATH:process.env.PATH,HOME:directory,NODE_ENV:"test" as const};
 let started=false;
 let client:ReturnType<typeof postgres>|undefined;
 try{
  execFileSync("initdb",["-D",`${directory}/data`,"-U","fixture_admin","-A","trust","--no-locale"],{env,stdio:"ignore"});
  execFileSync("pg_ctl",["-D",`${directory}/data`,"-l",`${directory}/server.log`,"-o",`-p 55439 -h "" -k ${directory}`,"start"],{env,stdio:"ignore"});started=true;
  client=postgres({host:directory,port:55439,user:"fixture_admin",database:"postgres",max:4});
  await client.unsafe(`create table tekmetric_work_orders(
   shop_id integer not null, work_order_id text not null,repair_order_number integer,
   status text,vin text,customer_id text,vehicle_id text,completed_date timestamptz,
   posted_date timestamptz,updated_date timestamptz,payload jsonb not null,
   fetched_at timestamptz not null default now(),primary key(shop_id,work_order_id))`);
  const bundle=await build({entryPoints:["lib/data/repositories/pg/tekmetric-cache.ts"],bundle:true,write:false,platform:"node",format:"cjs",packages:"external",
   plugins:[{name:"fixture-db",setup(b){b.onResolve({filter:/^@\/lib\/db\/drizzle$/},a=>({path:a.path,namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"export const getDb=()=>globalThis.fixtureDb;"}));}}]});
  const mod={exports:{} as any};
  runInNewContext(bundle.outputFiles[0].text,{module:mod,exports:mod.exports,require:createRequire(import.meta.url),fixtureDb:drizzle(client),console});
  const raw=(dots?:string[])=>({id:91,shopId:471,jobs:[{id:10,parts:[{id:20,quantity:2,...(dots===undefined?{}:{dotNumbers:dots})}]}]});
  await mod.exports.upsertWorkOrderSnapshot(37,"91",{data:raw(["001","001"]),status:"Posted"});
  await Promise.all(Array.from({length:8},()=>mod.exports.upsertWorkOrderSnapshot(37,"91",{data:raw()})));
  let [row]=await client`select payload from tekmetric_work_orders where shop_id=37 and work_order_id='91'`;
  assert.deepEqual(row.payload.data.jobs[0].parts[0].dotNumbers,["001","001"]);
  assert.equal(row.payload.data.jobs[0].parts[0]._mosDotInherited,true);
  assert.equal(row.payload.status,"Posted");
  await mod.exports.upsertWorkOrderSnapshot(37,"91",{data:raw([])});
  [row]=await client`select payload from tekmetric_work_orders where shop_id=37 and work_order_id='91'`;
  assert.deepEqual(row.payload.data.jobs[0].parts[0].dotNumbers,[]);
  assert.equal(row.payload.data.jobs[0].parts[0]._mosDotInherited,undefined);
  await mod.exports.upsertWorkOrderSnapshot(38,"91",{data:raw()});
  [row]=await client`select payload from tekmetric_work_orders where shop_id=38 and work_order_id='91'`;
  assert.equal(row.payload.data.jobs[0].parts[0].dotNumbers,undefined);
 }finally{
  await client?.end();
  if(started)execFileSync("pg_ctl",["-D",`${directory}/data`,"-m","immediate","stop"],{env,stdio:"ignore"});
  await rm(directory,{recursive:true,force:true});
 }
});
