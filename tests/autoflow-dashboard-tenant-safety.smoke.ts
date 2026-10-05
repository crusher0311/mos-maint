/**
 * Task #1287 tenant-safety guard for the AutoFlow dashboard aggregation.
 *
 * DVI lookup results are merged into AutoFlow rows by RO number.  RO numbers
 * are only unique inside a shop, so each lookup must also constrain its
 * collection to the dashboard shop.  This is intentionally a source-level
 * check: the shared offline fake Mongo runner does not implement $lookup and
 * cannot prove cross-tenant behavior.
 *
 * This test should stay red until the aggregation binds the current shop id
 * in both DVI lookups.  It is included as a review finding rather than a
 * production-data test.
 */
import fs from "node:fs";
import path from "node:path";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function lookupBlock(source: string, collection: string): string {
  const start = source.indexOf(`from: "${collection}"`);
  if (start < 0) return "";
  return source.slice(Math.max(0, source.lastIndexOf("$lookup", start)), source.indexOf("as:", start) + 3);
}

const source = fs.readFileSync(
  path.join(process.cwd(), "app/api/dashboard/data/route.ts"),
  "utf8",
);
const resultsLookup = lookupBlock(source, "dvi_results");
const alternateLookup = lookupBlock(source, "dvi");

ok(
  "primary DVI lookup binds the current shop",
  /\$\$shopId|shopIdNum|shopIdStr/.test(resultsLookup),
  "dvi_results lookup has RO-only matching",
);
ok(
  "alternate DVI lookup binds the current shop",
  /\$\$shopId|shopIdNum|shopIdStr/.test(alternateLookup),
  "dvi lookup has RO-only matching",
);

if (failed > 0) {
  console.error(
    "\nTenant-safety checks failed. Do not ship AutoFlow DVI rows until both lookups include shopId equality.",
  );
  process.exitCode = 1;
}