import assert from "node:assert/strict";
import { previewJwtInvoices, type InvoicePreviewDeps } from "../lib/jwt-invoice-preview";

async function main() {
  let reads = 0, scopes = 0;
  const deps: InvoicePreviewDeps = {
    authorize: async () => ({}),
    enterprise: async () => ({ name: "JWT", shopIds: [227] }),
    relayMode: () => "relay",
    interactive: async work => { scopes++; return work(); },
    policy: async () => ({ allowed: true, callbackOnly: true, allowInteractive: true }),
    read: async () => { reads++; return { ok: true, data: { ItemCollection: [{
      WorkOrderNumber: "701008329", InvoiceNumber: "701006622", InvoiceTime: "2026-09-01T12:00:00",
      Type: "Invoice", Customer: "PRIVATE", VIN: "PRIVATE",
    }] } }; },
  };
  assert.equal((await previewJwtInvoices({...deps, authorize: async () => { throw Error(); }})).status, 401);
  assert.equal(scopes, 0);
  assert.equal((await previewJwtInvoices({...deps, enterprise: async () => ({name:"Other",shopIds:[227]})})).status,409);
  assert.equal((await previewJwtInvoices({...deps, relayMode: () => "direct"})).status,409);
  for (const policy of [
    {allowed:false}, {allowed:true,callbackOnly:true},
    {allowed:true,requireTimedTrial:true},
  ]) assert.equal((await previewJwtInvoices({...deps,policy:async()=>policy})).status,409);
  assert.equal(reads,0);
  const success = await previewJwtInvoices(deps);
  assert.equal(success.status,200);
  assert.equal(reads,1);
  assert.match(JSON.stringify(success.body), /absent_by_both_numbers/);
  assert.ok(!JSON.stringify(success.body).includes("PRIVATE"));
  const oversized = await previewJwtInvoices({...deps,read:async()=>({ok:true,data:{ItemCollection:Array(26).fill({})}})});
  assert.equal(oversized.status,502);
  const failed = await previewJwtInvoices({...deps,read:async()=>({ok:false,error:"SECRET PROVIDER RESPONSE"})});
  assert.equal(failed.status,503);
  assert.ok(!JSON.stringify(failed.body).includes("SECRET"));
  console.log("JWT authenticated invoice preview: ALL PASS");
}
main().catch(e=>{console.error(e);process.exit(1);});
