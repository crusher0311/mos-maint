/**
 * Credential-free local PG/Mongo adapter. Intentionally NOT an implementation
 * of the atomic RepairTransaction interface. A durable fence and per-store
 * receipts expose partial outcomes instead of pretending to roll them back.
 */
import assert from "node:assert/strict";
import postgres from "postgres";
import { MongoClient } from "mongodb";
import { userInfo } from "node:os";
import { evidenceDigest as digest } from "./invoice-metadata-repair-plan";
import { patched, verifyCase, validateAuthorization, finalizeOfflinePlan,
  type FinalPlan, type Approval, type CurrentCase, type Proposal, type Readiness,
  type OriginalProposal, type OfflineRepairStore } from "./invoice-metadata-executor";

export const DUAL_SCHEMA = `
CREATE TABLE dual_context(id text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE dual_owners(key text PRIMARY KEY, identity text NOT NULL, owner jsonb NOT NULL);
CREATE TABLE dual_journal(id text PRIMARY KEY, binding text NOT NULL, phase text NOT NULL);
CREATE TABLE dual_fence(id int PRIMARY KEY CHECK(id=1), operation text);
INSERT INTO dual_fence VALUES(1,null);
CREATE TABLE dual_audit(id bigserial PRIMARY KEY, operation text NOT NULL, phase text NOT NULL);
`;
export const dualIdentity = (p:Proposal) => `${p.shopId}:${p.provider}:${p.sourceId.toLowerCase()}`;
const same = (a:unknown,b:unknown) => {
  if(a===undefined||b===undefined)assert.equal(a,b,"Bound state changed");
  else assert.equal(digest(a),digest(b),"Bound state changed");
};
export class LocalDualMetadataStore {
  readonly sql;
  readonly mongo: MongoClient;
  readonly db;
  /** Failure injection is local-only; durable state is retained across reopen. */
  fault: "canonical" | "shadow" | "finished" | null = null;
  faultIndex = 0;
  constructor(socket:string,mongoPort:number,readonly marker:string) {
    assert.match(socket,/^\/tmp\/invoice-dual\.[A-Za-z0-9]+$/);
    assert.ok(Number.isInteger(mongoPort)&&mongoPort>1024&&mongoPort<65536);
    assert.match(marker,/^[a-f0-9]{32}$/);
    this.sql=postgres({host:socket,port:5432,database:"postgres",username:userInfo().username,
      max:2,connect_timeout:3,idle_timeout:2,onnotice:()=>{}});
    this.mongo=new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`,
      {serverSelectionTimeoutMS:3000,socketTimeoutMS:4000,maxPoolSize:2});
    this.db=this.mongo.db("invoice_dual_disposable");
  }
  async guard(tx:any) {
    const [row]=await tx`SELECT current_setting('invoice_preview.disposable',true) marker,inet_server_addr() address`;
    assert.equal(row.marker,this.marker);assert.equal(row.address,null);
    assert.ok(await this.db.collection("marker").findOne({_id:this.marker as any}));
    await tx.unsafe("SET LOCAL statement_timeout='3s'");
    await tx.unsafe("SET LOCAL lock_timeout='1s'");
    await tx.unsafe("SET LOCAL idle_in_transaction_session_timeout='10s'");
    await tx.unsafe("SELECT pg_advisory_xact_lock(19470222,1)");
  }
  private async read(tx:any,p:Proposal):Promise<CurrentCase>{
    const identity=dualIdentity(p);
    const [context]=await tx`SELECT value FROM dual_context WHERE id=${identity}`;
    assert.ok(context,"Missing complete evidence/holds");
    const matches=(owner:any)=>owner.row?.shop_id===p.shopId &&
      owner.row?.provenance?.sourceIds?.some((s:any)=>s.system===p.provider &&
        ["invoice_id","work_order_id"].includes(s.idType)&&String(s.idValue).toLowerCase()===p.sourceId.toLowerCase());
    // Bounded fixture inventory, including owners filed under another identity.
    const canonical=await tx`SELECT owner FROM dual_owners LIMIT 202`;
    const shadow=await this.db.collection("owners").find({}).limit(202).toArray();
    assert.ok(canonical.length<=200&&shadow.length<=200,"Fixture inventory cap");
    return {...context.value,canonical:canonical.map((r:any)=>r.owner).filter(matches),
      shadow:shadow.map(r=>r.owner).filter(matches)};
  }
  async finalize(original:OriginalProposal,readiness:Readiness,now=Date.now()) {
    const bridge:OfflineRepairStore={
      mode:"disposable-only",
      preflight:fn=>this.sql.begin("isolation level repeatable read read only",async tx=>{
        await this.guard(tx);
        assert.equal((await tx.unsafe("SELECT operation FROM dual_fence WHERE id=1"))[0].operation,null);
        return fn({read:(p:Proposal)=>this.read(tx,p)} as any);
      }) as any,
      transaction:async()=>{throw Error("Distributed stores cannot use the atomic executor");},
      auditFailure:async()=>{throw Error("Use distributed receipts");},
    };
    return finalizeOfflinePlan(bridge,original,digest(original),readiness,now,"disposable-pg-mongo");
  }
  private auth(plan:FinalPlan,approval:Approval) {
    validateAuthorization(plan,approval,Date.now(),"disposable-pg-mongo");
  }
  /** All fixture reads/writes must pass the coordinator. No TTL auto-unfencing. */
  async guarded<T>(work:(tx:any)=>Promise<T>):Promise<T> {
    return this.sql.begin(async tx=>{
      await this.guard(tx);
      assert.equal((await tx.unsafe("SELECT operation FROM dual_fence WHERE id=1"))[0].operation,null,
        "Unresolved repair: reads and writers blocked");
      return work(tx);
    }) as any;
  }
  async inspect(plan:FinalPlan,index:number) {
    return this.sql.begin("isolation level repeatable read read only",async tx=>{
      await this.guard(tx);
      const id=`${digest(plan)}:${index}`;
      const journal=await tx.unsafe("SELECT id,binding,phase FROM dual_journal WHERE id LIKE $1",[`${id}:%`]);
      const current=await this.read(tx,plan.proposals[index]);
      const fence=(await tx.unsafe("SELECT operation FROM dual_fence WHERE id=1"))[0].operation;
      return {journal,fenced:fence!==null,current};
    });
  }
  async execute(plan:FinalPlan,approval:Approval) {
    plan=structuredClone(plan);approval=structuredClone(approval);
    this.auth(plan,approval);
    for(let index=0;index<plan.proposals.length;index++){
      try {
      const p=plan.proposals[index],original=plan.cases[index];
      verifyCase(p,original);
      const applied=patched(original,p);
      const rollback=structuredClone(original);
      for(const side of ["canonical","shadow"] as const) rollback[side][0].revision=applied[side][0].revision+1;
      const before=approval.action==="apply"?original:applied;
      const after=approval.action==="apply"?applied:rollback;
      const id=`${digest(plan)}:${index}:${approval.action}`;
      const binding=digest({id,before,after});
      const transition=async(phase:string,work:(tx:any,current:CurrentCase)=>Promise<void>)=>{
        await this.sql.begin(async (tx:any)=>{
          await this.guard(tx);this.auth(plan,approval);
          const [fence]=await tx.unsafe("SELECT operation FROM dual_fence WHERE id=1 FOR UPDATE");
          const [j]=await tx`SELECT * FROM dual_journal WHERE id=${id}`;
          // A retry of a partially completed plan first verifies earlier
          // committed receipts before reaching the entry that owns the fence.
          const earlierCompleted = phase==="prepare" && j?.phase==="completed" &&
            typeof fence.operation==="string" && fence.operation.startsWith(`${digest(plan)}:`);
          assert.ok(fence.operation===null||fence.operation===id||earlierCompleted,"Another repair owns the fence");
          if(j)same(j.binding,binding);
          await work(tx,await this.read(tx,p));
          await tx`INSERT INTO dual_audit(operation,phase) VALUES(${id},${phase})`;
        });
      };
      let complete=false;
      await transition("prepare",async(tx,current)=>{
        const [j]=await tx`SELECT * FROM dual_journal WHERE id=${id}`;
        if(j?.phase==="completed"){
          same(current,after);
          const doc=await this.db.collection("owners").findOne({_id:after.shadow[0].key as any});
          same(doc?.receipt,{id,binding});
          complete=true;return;
        }
        if(j)return; // Subsequent stages revalidate their exact expected states.
        if(approval.action==="rollback"){
          const [a]=await tx`SELECT phase FROM dual_journal WHERE id=${`${digest(plan)}:${index}:apply`}`;
          assert.equal(a?.phase,"completed","Committed apply receipt required");
        }else{
          const [r]=await tx`SELECT phase FROM dual_journal WHERE id=${`${digest(plan)}:${index}:rollback`}`;
          assert.equal(r,undefined,"Rolled-back plan cannot be reapplied");
        }
        same(current,before);
        await tx`UPDATE dual_fence SET operation=${id} WHERE id=1`;
        await tx`INSERT INTO dual_journal VALUES(${id},${binding},'prepared')`;
      });
      if(complete)continue;
      await transition("canonical",async(tx,current)=>{
        const [j]=await tx`SELECT * FROM dual_journal WHERE id=${id}`;
        const expected=structuredClone(before);
        if(j.phase==="canonical")expected.canonical=after.canonical;
        if(j.phase==="canonical"&&digest(current)===digest(after)){
          const doc=await this.db.collection("owners").findOne({_id:after.shadow[0].key as any});
          same(doc?.receipt,{id,binding});
          return;
        }
        same(current,expected);
        if(j.phase==="canonical")return;
        assert.equal(j.phase,"prepared");
        const old=before.canonical[0],next=after.canonical[0];
        const exists=Object.hasOwn(next.row.custom_fields,"invoiceHours");
        const value=next.row.custom_fields.invoiceHours??null;
        const rows=await tx`UPDATE dual_owners SET owner=
          jsonb_set(CASE WHEN ${exists} THEN
            jsonb_set(jsonb_set(owner,'{row,custom_fields,invoiceHours}',coalesce(${tx.json(value)}::jsonb,'null'::jsonb)),
              '{snapshot,custom_fields,invoiceHours}',coalesce(${tx.json(value)}::jsonb,'null'::jsonb))
            ELSE owner #- '{row,custom_fields,invoiceHours}' #- '{snapshot,custom_fields,invoiceHours}' END,
            '{revision}',${tx.json(next.revision)}::jsonb)
          WHERE key=${old.key} AND owner=${tx.json(old)}::jsonb RETURNING key`;
        assert.equal(rows.length,1,"Canonical CAS lost");
        await tx`UPDATE dual_journal SET phase='canonical' WHERE id=${id}`;
      });
      if(this.fault==="canonical"&&index===this.faultIndex)throw Error("Injected lost canonical response");
      await transition("shadow",async(tx,current)=>{
        const expected=structuredClone(before);expected.canonical=after.canonical;
        const doc=await this.db.collection("owners").findOne({_id:before.shadow[0].key as any});
        const receipt={id,binding};
        if(doc?.receipt?.id===id){same(doc.receipt,receipt);same(current,after);return;}
        same(current,expected);
        const next=after.shadow[0],exists=Object.hasOwn(next.row.custom_fields,"invoiceHours");
        const update:any={$set:{"owner.revision":next.revision,receipt}};
        const fields=["owner.row.custom_fields.invoiceHours","owner.snapshot.custom_fields.invoiceHours"];
        if(exists)for(const f of fields)update.$set[f]=next.row.custom_fields.invoiceHours;
        else update.$unset=Object.fromEntries(fields.map(f=>[f,""]));
        this.auth(plan,approval);
        const result=await this.db.collection("owners").updateOne(
          {_id:before.shadow[0].key as any,owner:before.shadow[0]},update,{writeConcern:{w:"majority"}});
        assert.equal(result.modifiedCount,1,"Shadow CAS lost");
        same(await this.read(tx,p),after);
      });
      if(this.fault==="shadow"&&index===this.faultIndex)throw Error("Injected lost shadow response");
      await transition("completed",async(tx,current)=>{
        same(current,after);
        const doc=await this.db.collection("owners").findOne({_id:after.shadow[0].key as any});
        same(doc?.receipt,{id,binding});
        await tx`UPDATE dual_journal SET phase='completed' WHERE id=${id}`;
        await tx`UPDATE dual_fence SET operation=null WHERE id=1 AND operation=${id}`;
      });
      if(this.fault==="finished"&&index===this.faultIndex)throw Error("Injected lost completion response");
      } catch(error) {
        await this.sql.begin(async (tx:any)=>{
          await this.guard(tx);
          const operation=`${digest(plan)}:${index}:${approval.action}`;
          await tx`INSERT INTO dual_audit(operation,phase) VALUES(${operation},'rejected_or_unknown')`;
        });
        throw error;
      }
    }
  }
  async close(){await this.mongo.close();await this.sql.end({timeout:2});}
}
