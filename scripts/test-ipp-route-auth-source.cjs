const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const filename = path.join(__dirname, "route-source.cjs");
const nativeRequire = createRequire(filename);
const implementation = fs.readFileSync(path.join(__dirname, "../lib/print-queue/ipp-http.ts"), "utf8");
function load(impl) {
  const context = {
    module: { exports: {} }, __dirname,
    require: name => name === "node:fs" ? {
      ...fs, readFileSync: (file, encoding) => String(file).endsWith("ipp-http.ts") ? impl : fs.readFileSync(file, encoding),
    } : nativeRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context);
  return context.module.exports.expandIppHandlers;
}
const expand = load(implementation);
for (const [handler, expression, guard] of [
  ["webDestinations", "webDestinations", "requireSession()"],
  ["webStatus", "webStatus", "requireSession()"],
  ["webTest", "webTest", "requireSession()"],
  ["extensionDestinations", "withExtensionErrorMarker((req) => extensionDestinations(req))", "guardExtensionShopRequest(req"],
  ["extensionTest", "withExtensionErrorMarker(extensionTest)", "guardExtensionShopRequest(req"],
]) {
  const source = `import { ${handler} } from "@/lib/print-queue/ipp-http";\nexport const GET = ${expression};`;
  assert(expand("route.ts", source).includes(guard), handler);
  const unused = `import { ${handler} } from "@/lib/print-queue/ipp-http";\nexport const GET = unrelated; // ${handler}`;
  assert.equal(expand("route.ts", unused), unused, "Unused imports must not supply guards");
  const unguarded = load(`export async function ${handler}(req) { return leakData(); }`);
  assert(!unguarded("route.ts", source).includes(guard), "Removed shared guard must remain absent");
  assert.throws(() => load("")("route.ts", source), /Missing IPP handler/);
}
const original = 'import { webTest } from "untrusted-module"; export const POST = webTest;';
assert.equal(expand("route.ts", original), original);
console.log("PASS shared IPP route auth expansion, unused-import rejection, and removed-guard detection");
