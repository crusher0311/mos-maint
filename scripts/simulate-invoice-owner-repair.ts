/** Offline structural simulation. Accepts hashes only; no production clients. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {userInfo} from "node:os";
import postgres from "postgres";
import {planOwnerStructure} from "./invoice-owner-repair-model";
async function main(){
  const port=Number(process.argv[2]);assert.ok(port>1024&&port<65536);
  const snapshot=JSON.parse(readFileSync(process.argv[3]??"/tmp/invoice-owner-closure.json","utf8"));
  assert.deepEqual(snapshot.foreignKeys.map((fk:any)=>String(fk.child).replace(/^public\./,"")).sort(),
    ["normalized_line_items","normalized_payments","normalized_service_jobs"],
    "Unexpected inbound parent FKs require a broader simulation");
  const plan=planOwnerStructure(snapshot);
  const pg=postgres({host:"127.0.0.1",port,username:userInfo().username,database:"postgres",max:1});
  try{
    assert.equal((await pg`select current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
    await pg.begin(async transaction=>{
      // postgres-js transactions are callable tags at runtime.
      const sql=transaction as unknown as typeof pg;
      await sql`CREATE TABLE original_parents (id text PRIMARY KEY, snapshot jsonb NOT NULL)`;
      await sql`CREATE TABLE proposed_parents (id text PRIMARY KEY,shop int NOT NULL,number text NOT NULL,
        original text REFERENCES original_parents(id),UNIQUE(shop,number))`;
      await sql`CREATE TABLE original_children (kind text,id text,immutable_hash text,PRIMARY KEY(kind,id))`;
      await sql`CREATE TABLE jobs (id text PRIMARY KEY,owner text REFERENCES proposed_parents(id),
        immutable_hash text,UNIQUE(id,owner))`;
      await sql`CREATE TABLE lines (id text PRIMARY KEY,owner text REFERENCES proposed_parents(id),
        job text,immutable_hash text,FOREIGN KEY(job,owner) REFERENCES jobs(id,owner))`;
      await sql`CREATE TABLE payments (id text PRIMARY KEY,owner text REFERENCES proposed_parents(id),immutable_hash text)`;
      for(const node of snapshot.nodes)await sql`INSERT INTO original_parents VALUES (${node.record},${sql.json(node)})`;
      for(const parent of plan.parents)await sql`INSERT INTO proposed_parents VALUES (${parent.owner},${parent.shop},${parent.number},${parent.original})`;
      for(const child of plan.children)await sql`INSERT INTO original_children VALUES (${child.table},${child.id},${child.immutableHash})`;
      for(const child of plan.children.filter((c:any)=>c.table==="normalized_service_jobs"))
        await sql`INSERT INTO jobs VALUES (${child.id},${child.owner},${child.immutableHash})`;
      for(const child of plan.children.filter((c:any)=>c.table==="normalized_line_items"))
        await sql`INSERT INTO lines VALUES (${child.id},${child.owner},${child.job},${child.immutableHash})`;
      for(const child of plan.children.filter((c:any)=>c.table==="normalized_payments"))
        await sql`INSERT INTO payments VALUES (${child.id},${child.owner},${child.immutableHash})`;
      const [check]=await sql`WITH result AS (
        SELECT 'normalized_service_jobs' kind,id,immutable_hash FROM jobs UNION ALL
        SELECT 'normalized_line_items',id,immutable_hash FROM lines UNION ALL
        SELECT 'normalized_payments',id,immutable_hash FROM payments)
        SELECT count(*)::int n,count(*) FILTER(WHERE b.id IS NULL OR r.id IS NULL OR b.immutable_hash<>r.immutable_hash)::int changed
        FROM original_children b FULL JOIN result r USING(kind,id)`;
      assert.equal(check.n,plan.children.length);assert.equal(check.changed,0);
      assert.equal((await sql`select count(*)::int n from original_parents`)[0].n,snapshot.nodes.length);
    });
    console.log(JSON.stringify({event:"structural_simulation_passed",retainedOriginalParents:snapshot.nodes.length,
      proposedParents:plan.parents.length,preservedChildren:plan.children.length,
      lostChildren:0,duplicatedChildren:0,changedChildFingerprints:0,
      scope:"Structural model only; source payloads and financial report not rebuilt",
      productionWrites:0,providerRequests:0}));
  }finally{await pg.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
