import assert from "node:assert/strict";
import {build} from "esbuild";
import {createRequire} from "node:module";
import {userInfo} from "node:os";
import {evidenceDigest as digest} from "../scripts/invoice-metadata-repair-plan";

/** Bundles the actual entry and engine. Only the session provider is substituted;
 * database operations use the runner's actual isolated PG/Mongo replica set. */
export async function testProductionEntry(sql: any, db: any, original: any, holdReviews: Record<number,string>) {
  const root=process.env.INVOICE_DUAL_SOCKET!;
  const outfile=`${root}/production-entry.cjs`;
  await build({stdin:{contents:`
    export {executeProductionInvoiceRepair} from "./lib/invoice-repair/production-entry";
    export {setSession} from "fixture-session";
  `,resolveDir:process.cwd(),loader:"ts"},outfile,bundle:true,platform:"node",format:"cjs",
    packages:"external",plugins:[{name:"fixture-auth",setup(b){
      b.onResolve({filter:/^(@\/lib\/auth|fixture-session)$/},()=>({path:"auth",namespace:"fixture"}));
      b.onResolve({filter:/^server-only$/},()=>({path:"noop",namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},args=>({loader:"js",contents:args.path==="auth"
        ? "let session=null;export function setSession(s){session=s} export async function getSession(){return session}"
        : ""}));
    }}]});
  // Resolve external dependencies from the workspace, not the temporary folder.
  const req=createRequire(`${process.cwd()}/package.json`);
  const Module=req("node:module");
  const compiled=new Module(outfile);
  compiled.filename=outfile;compiled.paths=Module._nodeModulePaths(process.cwd());
  compiled._compile(req("node:fs").readFileSync(outfile,"utf8"),outfile);
  const {executeProductionInvoiceRepair:run,setSession}=compiled.exports;
  const [previous]=await sql.unsafe("SELECT installation_key FROM invoice_repair_installation WHERE id=1");
  const key=digest("fixture-production-installation");
  const config={
    enabled:true,
    postgresUrl:{host:root,port:5432,database:"postgres",username:userInfo().username},
    mongoUri:`mongodb://${process.env.INVOICE_DUAL_PORTS!.split(",").map(p=>`127.0.0.1:${p}`).join(",")}/?replicaSet=invoice_disposable`,
    mongoDatabase:db.databaseName,expectedPostgresDatabase:"postgres",
    expectedPostgresRole:userInfo().username,installationKey:key,
  };
  const prepare={kind:"prepare",original,expectedDigest:digest(original),holdReviews};
  try {
    await assert.rejects(run({...config,enabled:false},prepare),/disabled/);
    for(const session of [null,{email:"fixture@example.invalid",isPlatformAdmin:false},
      {email:"fixture@example.invalid",isPlatformAdmin:true,isImpersonation:true},
      {email:"fixture@example.invalid",isPlatformAdmin:true,isTestAuth:true},
      {email:"fixture@example.invalid",isPlatformAdmin:true,mustChangePassword:true}]){
      setSession(session);
      await assert.rejects(run(config,prepare),/administrator/);
    }
    setSession({email:"fixture@example.invalid",isPlatformAdmin:true});
    await assert.rejects(run({...config,mongoUri:"invalid-uri-fixture"},prepare),
      error => error instanceof Error && error.message === "Invalid invoice repair connection configuration");
    await assert.rejects(run(config,prepare),/installation verification failed/);
    await sql.unsafe("UPDATE invoice_repair_installation SET installation_key=$1 WHERE id=1",[key]);
    await db.collection("invoice_repair_installation").updateOne({_id:"coordinator"},{$set:{installationKey:key}});
    await assert.rejects(run({...config,expectedPostgresRole:"wrong-role"},prepare),/verification failed/);
    await assert.rejects(run({...config,expectedPostgresDatabase:"wrong-db"},prepare),/verification failed/);
    const plan=await run(config,prepare);
    await assert.rejects(run(config,{kind:"execute",plan,action:"apply",approvalId:"missing"}),/approval/);
    const approved=await run(config,{kind:"approve",plan,action:"apply"});
    setSession({email:"different@example.invalid",isPlatformAdmin:true});
    await assert.rejects(run(config,{kind:"execute",plan,action:"apply",...approved}),/approval/);
    setSession({email:"fixture@example.invalid",isPlatformAdmin:true});
    const applied=await run(config,{kind:"execute",plan,action:"apply",...approved});
    assert.equal(applied.fenced,false);
    assert.ok(applied.results.every((r:any)=>r.matchesApplied));
    const rollback=await run(config,{kind:"approve",plan,action:"rollback"});
    const restored=await run(config,{kind:"execute",plan,action:"rollback",...rollback});
    assert.ok(restored.results.every((r:any)=>r.matchesRolledBack));
    await assert.rejects(run(config,{kind:"approve",plan:{...plan,expiresAt:0},action:"apply"}));
    const inspected=await run(config,{kind:"inspect",plan:{...plan,expiresAt:0}});
    assert.equal(inspected.fenced,false);
    console.log("PASS production entry: disabled/auth/target/install guards, fresh grants, real native apply and rollback, expired inspection");
  } finally {
    await sql.unsafe("UPDATE invoice_repair_installation SET installation_key=$1 WHERE id=1",[previous.installation_key]);
    await db.collection("invoice_repair_installation").updateOne({_id:"coordinator"},{$set:{installationKey:previous.installation_key}});
  }
}
