import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// These executables cannot open a non-disposable PG endpoint. They are not
// deployed ingestion/reporting entry points. Do not add live tools here.
const local = new Set([
  "scripts/invoice-metadata-dual-store.ts", "scripts/invoice-metadata-disposable-store.ts",
  "scripts/simulate-invoice-owner-repair.ts", "scripts/inspect-local-invoice-remainder.ts",
  "scripts/replay-invoice-local.ts", "scripts/plan-invoice-source-recovery.ts",
]);
const findings: string[] = [];
function scan(root: string) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", ".next"].includes(entry.name)) continue;
    const file = join(root, entry.name);
    if (entry.isDirectory()) { scan(file); continue; }
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!/(normalized_work_orders|normalizedWorkOrders|NORMALIZED_COLLECTIONS|NormalizedIngestionService|SupabaseDualWriter|NativeInvoiceStore)/.test(text)) continue;
    if (file === "lib/invoice-repair/production-store.ts") {
      // Dedicated maintenance clients cannot use ordinary admission guards:
      // they operate under the repair engine's exclusion and exact binding.
      assert.match(text, /assert\.equal\(config\?\.enabled, true/);
      assert.match(text, /rows\[0\]\.installation_key, config\.installationKey/);
      assert.match(text, /binding\?\.installationKey, config\.installationKey/);
      assert.match(text, /new NativeInvoiceStore\(sql, db, guard\)/);
      continue;
    }
    if (local.has(file)) {
      assert.match(text, /invoice_preview\.disposable|\/tmp\/invoice-|127\.0\.0\.1/,
        `Disposable endpoint restriction missing: ${file}`);
      continue;
    }
    const rawPg = /import\s+(?!type\b)postgres\s+from\s+["']postgres["']|require\(["']postgres["']\)/.test(text);
    const rawMongoConstructor = /new MongoClient\s*\(/.test(text) &&
      /from\s+["']mongodb["']|require\(["']mongodb["']\)/.test(text);
    if (rawPg || rawMongoConstructor) findings.push(file);
  }
}
for (const dir of ["lib", "app", "scripts"]) scan(dir);
assert.deepEqual(findings, [], "Invoice reader/writer imports an unfenced native driver");
assert.match(readFileSync("lib/db/drizzle.ts", "utf8"), /invoice-repair\/postgres-client/);
assert.match(readFileSync("lib/mongo.ts", "utf8"), /invoice-repair\/mongo-client/);
assert.match(readFileSync("lib/integrations/core/normalized-ingestion.ts", "utf8"), /repairFence\.run/);
const legacyDiagnostic = readFileSync("scripts/diagnose-backfill-443-pt2.mjs", "utf8");
assert.match(legacyDiagnostic, /from "\.\.\/lib\/invoice-repair\/mongo-client\.ts"/);
assert.match(legacyDiagnostic, /from "\.\.\/lib\/invoice-repair\/postgres-client\.ts"/);
// Exercise the diagnostic's actual ESM imports, without running its live queries.
// ESM default-import interop differs from the TS test files' CommonJS loading.
const imports = legacyDiagnostic.split("\n").filter(line => line.startsWith("import ") &&
  line.includes("/invoice-repair/")).join("\n").replaceAll('"../lib/', '"./lib/');
const esm = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
  `${imports}\nimport assert from "node:assert/strict";
  assert.equal(typeof postgres, "function"); assert.equal(typeof MongoClient, "function");`], {
  encoding: "utf8",
  env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME,
    NODE_OPTIONS: "--require ./tests/helpers/deny-network-egress.cjs" },
});
assert.equal(esm.status, 0, esm.stderr);
console.log("Invoice direct-driver source inventory passed");
