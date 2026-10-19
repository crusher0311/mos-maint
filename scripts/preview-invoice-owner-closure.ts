/** Read-only owner graph; hashes only on disk. No provider API or apply mode. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import postgres from "postgres";
import {MongoClient} from "mongodb";
const hash=(v:unknown)=>createHash("sha256").update(String(v)).digest("hex");
const list=(v:any):any[]=>Array.isArray(v)?v:Array.isArray(v?.ItemCollection)?v.ItemCollection:[];
const refs=(p:any)=>(p?.sourceIds??[]).filter((s:any)=>s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType))
  .map((s:any)=>String(s.idValue).toLowerCase());
async function main(){
  const previous=readFileSync("/tmp/invoice-identity-repair-preview.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
  assert.equal(previous.at(-1)?.event,"identity_trace_complete");
  const seeds=previous.filter(r=>r.event==="repair_preview");
  assert.equal(seeds.length,10);
  const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
    connection:{default_transaction_read_only:true,statement_timeout:5000,lock_timeout:1000},onnotice:()=>{}});
  const mongo=new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,{serverSelectionTimeoutMS:10000});
  const nodes:any[]=[],children:any[]=[],issues:string[]=[];
  try{
    await mongo.connect();const db=mongo.db("mos-maintenance-mvp");
    for(const shop of [227,229,230]){
      const rows=await pg.unsafe("SELECT id FROM normalized_work_orders WHERE shop_id=$1 LIMIT 100001",[shop]);
      assert.ok(rows.length<=100000);
      const selected=rows.filter(r=>seeds.some(s=>s.shop===shop&&s.record===hash(`${shop}:${r.id}`)));
      assert.equal(selected.length,seeds.filter(s=>s.shop===shop).length);
      const queue=selected.map(r=>r.id),seen=new Set<string>(),jobIds=new Set<string>();
      while(queue.length){
        const id=queue.shift()!;if(seen.has(id))continue;seen.add(id);
        assert.ok(nodes.length<60,"Owner graph cap reached; do not simulate an incomplete graph");
        const [row]=await pg.unsafe("SELECT id,work_order_number,provenance,raw_data->'rawPayload' raw FROM normalized_work_orders WHERE shop_id=$1 AND id=$2",[shop,id]);
        assert.ok(row);
        const ids=refs(row.provenance),keys=[...new Set(ids.flatMap((s:string)=>[s,s.toUpperCase()]))];
        const copies=await db.collection("normalized_work_orders").find(
          {shopId:{$in:[shop,String(shop)]},"provenance.sourceSystem":"protractor","provenance.sourceIds.idValue":{$in:keys}},
          {projection:{rawPayload:1},maxTimeMS:5000}).hint("unique_shop_source_idValue").limit(101).toArray();
        assert.ok(copies.length<101);
        const raws=[row.raw,...copies.map(c=>c.rawPayload)].filter(Boolean);
        const desired=new Map<string,Set<string>>(),evidence=new Map<string,Set<string>>();
        const bind=(kind:string,value:any,owner:string)=>{
          if(!value)return;const key=`${kind}:${String(value).toLowerCase()}`;
          evidence.set(key,new Set([...(evidence.get(key)??[]),owner]));
        };
        for(const raw of raws){
          const source=String(raw.ID??"").toLowerCase();
          if(!ids.includes(source)){issues.push("unexpected_source_identity");continue;}
          const owner=hash(`${shop}:${source}`);
          if(!raw.WorkOrderNumber){issues.push("missing_work_order_number");continue;}
          const num=String(raw.WorkOrderNumber);
          desired.set(owner,new Set([...(desired.get(owner)??[]),hash(`${shop}:${num}`)]));
          const matches=await pg.unsafe("SELECT id FROM normalized_work_orders WHERE shop_id=$1 AND work_order_number=$2 LIMIT 3",[shop,num]);
          assert.ok(matches.length<=1);
          for(const match of matches)if(!seen.has(match.id))queue.push(match.id);
          for(const job of [...list(raw.ServicePackages),...list(raw.DeferredServicePackages)]){
            bind("service_job_id",job.ID,owner);
            for(const line of list(job.ServicePackageLines))bind("line_item_id",line.ID,owner);
          }
          for(const payment of list(raw.Payments))bind("payment_id",payment.ID,owner);
        }
        const record=hash(`${shop}:${id}`);
        nodes.push({shop,record,number:hash(`${shop}:${row.work_order_number}`),
          sourceIds:ids.map((s:string)=>hash(`${shop}:${s}`)),
          desired:[...desired].map(([owner,numbers])=>({owner,numbers:[...numbers]}))});
        for(const [table,kind] of [["normalized_service_jobs","service_job_id"],["normalized_line_items","line_item_id"],["normalized_payments","payment_id"]]){
          const data=await pg.unsafe(`SELECT * FROM ${table} WHERE shop_id=$1 AND work_order_id=$2 LIMIT 5001`,[shop,id]);
          assert.ok(data.length<=5000);
          for(const child of data){
            if(table==="normalized_service_jobs")jobIds.add(child.id);
            const childRefs=(child.provenance?.sourceIds??[]).filter((s:any)=>s.system==="protractor"&&s.idType===kind);
            let missing=!childRefs.length;const candidates=new Set<string>();
            for(const ref of childRefs){
              const owners=evidence.get(`${kind}:${String(ref.idValue).toLowerCase()}`);
              if(!owners?.size)missing=true;
              for(const owner of owners??[])candidates.add(owner);
            }
            const {work_order_id,service_job_id,...immutable}=child;
            children.push({table,shop,id:hash(`${shop}:${child.id}`),parent:record,
              job:service_job_id?hash(`${shop}:${service_job_id}`):null,
              owner:!missing&&candidates.size===1?[...candidates][0]:null,
              immutableHash:hash(JSON.stringify(immutable))});
          }
        }
        console.log(JSON.stringify({event:"owner_traced",shop,record,identities:ids.length,queued:queue.length}));
      }
      if(jobIds.size){
        const external=await pg.unsafe(`SELECT id FROM normalized_line_items
          WHERE service_job_id=ANY($1::text[]) AND
          (shop_id<>$2 OR NOT(work_order_id=ANY($3::text[]))) LIMIT 1`,
          [[...jobIds],shop,[...seen]]);
        if(external.length)issues.push("job_has_line_outside_owner_closure");
      }
    }
    // Other inbound FK types are a repair prerequisite, not silently ignored.
    const fks=await pg.unsafe(`SELECT conrelid::regclass::text AS child,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE contype='f' AND confrelid='normalized_work_orders'::regclass`);
    const snapshot={nodes,children,issues:[...new Set(issues)],foreignKeys:fks,
      scope:"structural simulation only; not a production repair or financial/report validation",
      productionWrites:0,providerRequests:0};
    writeFileSync("/tmp/invoice-owner-closure.json",JSON.stringify(snapshot),{mode:0o600});
    console.log(JSON.stringify({event:"owner_closure_complete",parents:nodes.length,children:children.length,
      unresolvedChildren:children.filter(c=>!c.owner).length,issues:snapshot.issues,foreignKeys:fks,productionWrites:0,providerRequests:0}));
  }finally{await mongo.close();await pg.end();}
}
main().catch(e=>{console.error(JSON.stringify({event:"owner_closure_failed",code:e?.code??"UNCLASSIFIED"}));process.exitCode=1;});
