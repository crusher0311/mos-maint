import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {previewStoredEvidence} from "../scripts/invoice-evidence-local-preview";
const id="11111111-1111-4111-8111-111111111111";
const raw={ID:id,Type:"Invoice",WorkflowStage:"Invoice",InvoiceNumber:1,
  InvoiceTime:"2026-10-16T12:00:00Z",ServicePackages:[],DeferredServicePackages:[]};
const record={shopId:227,sourceIds:[id],copies:[{shopId:227,raw}]};
const complete=previewStoredEvidence(record);
assert.equal(complete.category,"complete_candidate");
assert.equal(complete.repairAuthorized,false);
assert.equal(complete.evidence?.sold,0);
assert.equal(previewStoredEvidence({...record,copies:[{shopId:227,raw:{...raw,ServicePackages:null}}]}).category,"identity_date_only");
assert.equal(previewStoredEvidence({...record,copies:[{shopId:228,raw}]}).reason,"shop_scope_mismatch");
assert.equal(previewStoredEvidence({...record,sourceIds:[]}).category,"held");
assert.equal(previewStoredEvidence({...record,sourceIds:[id,"22222222-2222-4222-8222-222222222222"]}).category,"held");
assert.equal(previewStoredEvidence({...record,copies:[]}).reason,"no_matched_payload");
assert.equal(previewStoredEvidence({...record,copies:[{shopId:227,raw:{...raw,ID:undefined}}]}).category,"held");
assert.equal(previewStoredEvidence({...record,copies:[...record.copies,{shopId:227,raw:{...raw,InvoiceTime:"2026-10-15T12:00:00Z"}}]}).category,"held");
assert.equal(previewStoredEvidence({...record,copies:[{shopId:227,raw:{...raw,InvoiceNumber:0}}]}).category,"held");
assert.equal(previewStoredEvidence({...record,existingEvidence:complete.evidence}).category,"already_present");
assert.equal(previewStoredEvidence({...record,existingEvidence:{...complete.evidence!,sold:2}}).category,"held");
const dir=mkdtempSync(join(tmpdir(),"invoice-preview-"));
try {
  const file=join(dir,"cases.json");
  const run=()=>spawnSync(process.execPath,["--import","tsx","scripts/preview-invoice-evidence-local.ts",file],
    {encoding:"utf8",env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:"test",
      NODE_OPTIONS:"--require ./tests/helpers/deny-network-egress.cjs"}});
  writeFileSync(file,JSON.stringify([record]),{mode:0o600});
  const valid=run();
  assert.equal(valid.status,0,valid.stderr);
  assert.equal(JSON.parse(valid.stdout).counts.complete_candidate,1);
  assert.ok(!valid.stdout.includes(id),"Summary must not disclose invoice identities");
  writeFileSync(file,JSON.stringify([record,record]));
  assert.equal(run().status,1,"Duplicate identities must not inflate preview totals");
  writeFileSync(file,"{}");
  assert.equal(run().status,1);
} finally {rmSync(dir,{recursive:true,force:true});}
console.log("PASS offline preview: complete, identity/date-only, existing and held categories; no repair authorization");
