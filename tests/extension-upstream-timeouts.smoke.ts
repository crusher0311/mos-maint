/**
 * Smoke test for the Heart-shop VHI slowdown mitigation:
 * every upstream Tekmetric / CARFAX call inside `/api/extension/plan`
 * and `/api/extension/ro-context` must be wrapped in `withUpstreamTimeout`
 * so a stalled upstream cannot block the extension side panel for 30s+.
 *
 * This test is intentionally static — it parses the route source and
 * asserts the wrapper appears around every known-slow call site. It
 * also exercises the helper itself with a deliberately slow promise
 * to confirm the timeout fires and the fallback flows back to the caller.
 */
import { readFileSync } from "fs";
import { withUpstreamTimeout } from "../lib/with-upstream-timeout";

let assertions = 0;
function assert(cond: any, msg: string) {
  assertions++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok  ${msg}`);
}

async function main() {
  // ---- 1. Helper behavior ----
  console.log("\n[1] withUpstreamTimeout helper behavior");

  const slowResult = await withUpstreamTimeout(
    new Promise((r) => setTimeout(() => r("never-arrives"), 200)),
    50,
    "test-slow",
    "fallback-value",
  );
  assert(
    slowResult === "fallback-value",
    "slow promise resolves to fallback after timeout",
  );

  const fastResult = await withUpstreamTimeout(
    Promise.resolve("real-value"),
    1000,
    "test-fast",
    "fallback-value",
  );
  assert(
    fastResult === "real-value",
    "fast promise returns its real value (no fallback)",
  );

  const throwingResult = await withUpstreamTimeout(
    Promise.reject(new Error("upstream boom")),
    1000,
    "test-throw",
    "fallback-value",
  );
  assert(
    throwingResult === "fallback-value",
    "rejecting promise is swallowed and returns fallback",
  );

  const start = Date.now();
  await withUpstreamTimeout(
    new Promise((r) => setTimeout(() => r("late"), 5000)),
    100,
    "test-elapsed",
    null,
  );
  const elapsed = Date.now() - start;
  assert(
    elapsed < 500,
    `timeout fires promptly (took ${elapsed}ms, expected < 500ms)`,
  );

  // ---- 2. /api/extension/plan wraps every slow upstream call ----
  console.log("\n[2] /api/extension/plan upstream timeouts");
  const planSrc = readFileSync("app/api/extension/plan/route.ts", "utf8");

  assert(
    planSrc.includes('from "@/lib/with-upstream-timeout"'),
    "plan route imports withUpstreamTimeout",
  );

  // fetchTekmetricRoCached wraps the /repair-orders call
  const fetchHelperBlock = planSrc.match(
    /async function fetchTekmetricRoCached[\s\S]*?\n\}/,
  );
  assert(fetchHelperBlock, "fetchTekmetricRoCached helper found");
  assert(
    fetchHelperBlock![0].includes("withUpstreamTimeout") &&
      fetchHelperBlock![0].includes("tekmetricRequest(`/repair-orders/"),
    "fetchTekmetricRoCached wraps tekmetricRequest in withUpstreamTimeout",
  );

  // /vehicles/{id} fallback call wrapped
  assert(
    /withUpstreamTimeout\(\s*tekmetricRequest\(`\/vehicles\//.test(planSrc),
    "tekmetric /vehicles/{id} call wrapped in withUpstreamTimeout",
  );

  // /customers/{id} fallback call wrapped
  assert(
    /withUpstreamTimeout\(\s*tekmetricRequest\(`\/customers\//.test(planSrc),
    "tekmetric /customers/{id} call wrapped in withUpstreamTimeout",
  );

  // CARFAX mileage estimation wrapped
  assert(
    /withUpstreamTimeout\(\s*estimateMileageFromCarfax\(/.test(planSrc),
    "estimateMileageFromCarfax call wrapped in withUpstreamTimeout",
  );

  // No bare unwrapped tekmetricRequest calls remain in plan/route.ts
  const bareTekRequests = planSrc.match(
    /\bawait\s+tekmetricRequest\(/g,
  );
  assert(
    bareTekRequests === null,
    `no bare \`await tekmetricRequest(\` calls remain in plan/route.ts (found ${bareTekRequests?.length ?? 0})`,
  );

  // ---- 3. /api/extension/ro-context wraps every slow upstream call ----
  console.log("\n[3] /api/extension/ro-context upstream timeouts");
  const roSrc = readFileSync("app/api/extension/ro-context/route.ts", "utf8");

  assert(
    roSrc.includes('from "@/lib/with-upstream-timeout"'),
    "ro-context route imports withUpstreamTimeout",
  );
  assert(
    /withUpstreamTimeout\(\s*getRepairOrder\(/.test(roSrc),
    "ro-context getRepairOrder wrapped in withUpstreamTimeout",
  );
  assert(
    /withUpstreamTimeout\(\s*getVehicle\(/.test(roSrc),
    "ro-context getVehicle wrapped in withUpstreamTimeout",
  );
  assert(
    /withUpstreamTimeout\(\s*getCustomer\(/.test(roSrc),
    "ro-context getCustomer wrapped in withUpstreamTimeout",
  );

  // No bare `await getRepairOrder/getVehicle/getCustomer(` calls left
  // inside the Tekmetric branch. Scoped to the tekmetric block only —
  // the Shop-Ware branch imports a different `getRepairOrder` from
  // @/lib/integrations/shopware/client and is not the slow path here.
  const tekBlockMatch = roSrc.match(
    /if \(resolvedProvider === "tekmetric"\)[\s\S]*?\n    \} else if/,
  );
  assert(tekBlockMatch, "tekmetric branch in ro-context/route.ts found");
  const tekBlock = tekBlockMatch![0];
  for (const fn of ["getRepairOrder", "getVehicle", "getCustomer"]) {
    const bare = new RegExp(`\\bawait\\s+${fn}\\(`).test(tekBlock);
    assert(
      !bare,
      `no bare \`await ${fn}(\` calls remain in ro-context tekmetric branch`,
    );
  }

  // ---- 4. /api/extension/canned-jobs wraps the paginated upstream loop ----
  console.log("\n[4] /api/extension/canned-jobs upstream timeouts");
  const cjSrc = readFileSync("app/api/extension/canned-jobs/route.ts", "utf8");
  assert(
    cjSrc.includes('from "@/lib/with-upstream-timeout"'),
    "canned-jobs route imports withUpstreamTimeout",
  );
  assert(
    /withUpstreamTimeout\(\s*getCannedJobs\(/.test(cjSrc),
    "canned-jobs paginated getCannedJobs call wrapped in withUpstreamTimeout",
  );
  assert(
    !/\bawait\s+getCannedJobs\(/.test(cjSrc),
    "no bare `await getCannedJobs(` calls remain in canned-jobs/route.ts",
  );

  console.log(`\nAll ${assertions} assertions passed.`);
}

main().catch((e) => {
  console.error("Test crashed:", e);
  process.exit(1);
});
