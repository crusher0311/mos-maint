const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const script = path.resolve("scripts/preview-jwt-invoices-on-runner.ts");
const loader = pathToFileURL(require.resolve("tsx")).href;
function run({ mode = "relay", allowed = true, callbackOnly = false, requireTimedTrial = false, result, shopId = 227 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jwt-preview-test-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const modules = path.join(root, "lib/integrations/protractor");
    fs.mkdirSync(modules, { recursive: true });
    fs.writeFileSync(path.join(modules, "relay-transport.ts"), "export {};");
    fs.writeFileSync(path.join(modules, "relay-config.ts"),
      `export const readProtractorRelayConfig = () => ({mode:${JSON.stringify(mode)}});`);
    fs.writeFileSync(path.join(modules, "client.ts"), `
      export const getProtractorOutboundPolicy = () => (${JSON.stringify({allowed,callbackOnly,requireTimedTrial,reason:"fixture-policy"})});
      export const resolveProtractorConfig = async () => ({configured:true,shopId:${shopId}});
      export const protractorFetch = async (url,config,options,retry,shop,opts) => {
        if(url!=="/Invoice/?startDate=2026-09-01&endDate=2026-09-02&take=25&skip=0" ||
          options.method!=="GET" || retry!==0 || shop!==227 || opts.maxRetries!==0 ||
          opts.priority!==false) throw new Error("Unexpected request");
        console.log("FIXTURE_REQUEST");
        return ${JSON.stringify(result ?? {ok:true,data:{ItemCollection:[{
          WorkOrderNumber:701000001,InvoiceNumber:701000002,
          InvoiceTime:"2026-09-01T12:00:00-04:00",Type:"Invoice",
          Contact:{Email:"private@example.test"}
        }]}})};
      };`);
    const child = spawnSync(process.execPath, ["--import", loader, script], {
      cwd:root, encoding:"utf8",timeout:15000,
    });
    return {status:child.status,output:child.stdout+child.stderr};
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
for(const config of [{mode:"direct"},{allowed:false},{callbackOnly:true},{requireTimedTrial:true},{shopId:999}]) {
  const r=run(config);
  assert.ok(!r.output.includes("FIXTURE_REQUEST"),r.output);
  assert.ok(r.output.includes('"outcome":"blocked"'),r.output);
}
assert.match(run({callbackOnly:true}).output, /"reason":"callback_only_policy"/);
assert.match(run({requireTimedTrial:true}).output, /"reason":"timed_trial_policy"/);
const success=run();
assert.equal(success.status,0,success.output);
assert.equal(success.output.split("FIXTURE_REQUEST").length-1,1);
assert.match(success.output,/"workOrderNumber":"701000001"/);
assert.ok(!success.output.includes("private@example.test"));
const failure=run({result:{ok:false,error:"private provider response"}});
assert.match(failure.output,/"outcome":"not_read"/);
assert.ok(!failure.output.includes("private provider response"));
const oversized=run({result:{ok:true,data:{ItemCollection:Array(26).fill({})}}});
assert.match(oversized.output,/"outcome":"blocked"/);
console.log("JWT provider preview smoke: ALL PASS (synthetic fixtures only)");
