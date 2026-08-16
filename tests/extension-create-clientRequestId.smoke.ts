/**
 * Smoke test: extension create-contact/vehicle/work-order never-hang +
 * duplicate-safe retry wiring (Task #937).
 *
 * Run: `npx tsx tests/extension-create-clientRequestId.smoke.ts`
 *
 * Two layers:
 *  1. Source-level pinning of the wiring in the three extension API routes
 *     (withUpstreamTimeout + interactive opts + clientRequestId pass-through)
 *     and in the extension sidepanel (generates a UUID before the first
 *     request, sends it as clientRequestId, reuses it across retries, clears
 *     it only on success/reset). The sidepanel is plain browser JS that can't
 *     be imported under tsx, so its contract is pinned at the source level.
 *  2. Behavioral: repeated payloads carrying the same clientRequestId hit the
 *     SAME upstream /Contact/{id} (upsert-by-ID → same resource, no dupes),
 *     via the real Protractor client code paths.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { deriveIdempotentUpstreamId, resolveClientRequestId } from "../lib/idempotent-create-id";
import {
  __protractorClientTestHooks,
  createContact,
  createProtractorWorkOrder,
  deterministicProtractorId,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

console.log("Layer 1a: extension API routes are deadline-bounded with interactive opts");
{
  const contact = read("app/api/extension/protractor/create-contact/route.ts");
  ok("create-contact wraps in withUpstreamTimeout", contact.includes("withUpstreamTimeout("));
  ok("create-contact uses priority lane + capped retries", /priority:\s*true/.test(contact) && /maxRetries:\s*1/.test(contact));
  ok("create-contact derives the contact ID server-side from clientRequestId", /resolveClientRequestId\(\s*\n?\s*"contact"/.test(contact) && /contactId:\s*pinnedContactId/.test(contact));
  ok("create-contact answers 504 on timeout", contact.includes("timedOut ? 504 : 500"));

  const vehicle = read("app/api/extension/protractor/create-vehicle/route.ts");
  ok("create-vehicle wraps in withUpstreamTimeout", vehicle.includes("withUpstreamTimeout("));
  ok("create-vehicle caps the SOAP socket below the route deadline", /soapTimeoutMs:\s*SOAP_TIMEOUT_MS/.test(vehicle) && /SOAP_TIMEOUT_MS\s*=\s*30_000/.test(vehicle));
  ok("create-vehicle derives the vehicle ID server-side from clientRequestId", /resolveClientRequestId\(\s*\n?\s*"vehicle"/.test(vehicle) && /vehicleId:\s*pinnedVehicleId/.test(vehicle));
  ok("create-vehicle answers 504 on timeout", vehicle.includes("timedOut ? 504 : 500"));

  const wo = read("app/api/extension/protractor/create-work-order/route.ts");
  ok("create-work-order wraps in withUpstreamTimeout", wo.includes("withUpstreamTimeout("));
  ok("create-work-order uses the interactive lane", /interactive:\s*true/.test(wo));
  ok("create-work-order derives the WO ID server-side from clientRequestId", /resolveClientRequestId\(\s*\n?\s*"workOrder"/.test(wo) && /workOrderId:\s*pinnedWorkOrderId/.test(wo));
  ok("create-work-order answers 504 on timeout", wo.includes("timedOut ? 504 : 500"));
}

console.log("Layer 1b: extension sidepanel pins clientRequestId per pending create");
{
  const sp = read("mos-tools-extension/sidepanel.js");

  // Generated before the first request, reused on retry (only regenerated
  // when null — i.e. after success or reset).
  ok(
    "contact key generated only when absent (reused across retries)",
    /if \(!createRoState\.contactRequestId\)\s*\{\s*createRoState\.contactRequestId = crypto\.randomUUID\(\);/.test(sp),
  );
  ok(
    "vehicle key generated only when absent (reused across retries)",
    /if \(!createRoState\.vehicleRequestId\)\s*\{\s*createRoState\.vehicleRequestId = crypto\.randomUUID\(\);/.test(sp),
  );
  ok(
    "WO key generated only when absent (reused across retries)",
    /if \(!createRoState\.woRequestId\)\s*\{\s*createRoState\.woRequestId = crypto\.randomUUID\(\);/.test(sp),
  );

  // Sent as clientRequestId in each create body.
  ok("contact body carries clientRequestId", /clientRequestId:\s*createRoState\.contactRequestId/.test(sp));
  ok("vehicle body carries clientRequestId", /clientRequestId:\s*createRoState\.vehicleRequestId/.test(sp));
  ok("WO body carries clientRequestId", /clientRequestId:\s*createRoState\.woRequestId/.test(sp));

  // Cleared ONLY after a definitive success…
  const successClears = [
    /if \(!result\?\.success\) throw new Error\(result\?\.error \|\| 'Create failed'\);\s*createRoState\.contactRequestId = null;/,
    /if \(!result\?\.success\) throw new Error\(result\?\.error \|\| 'Create failed'\);\s*createRoState\.vehicleRequestId = null;/,
    /if \(!result\?\.ok && !result\?\.success\) throw new Error\(result\?\.error \|\| 'Create failed'\);\s*createRoState\.woRequestId = null;/,
  ];
  ok("all three keys cleared only after success", successClears.every((re) => re.test(sp)));

  // …or when the intended entity changes / the flow resets.
  const resetFn = sp.slice(sp.indexOf("function resetCroState()"), sp.indexOf("function resetCroState()") + 3000);
  ok(
    "resetCroState clears every pinned key",
    resetFn.includes("createRoState.contactRequestId = null") &&
      resetFn.includes("createRoState.vehicleRequestId = null") &&
      resetFn.includes("createRoState.woRequestId = null"),
  );
  const selCust = sp.slice(sp.indexOf("function selectCroCustomer("), sp.indexOf("function selectCroCustomer(") + 1200);
  ok(
    "changing customer drops vehicle+WO keys",
    selCust.includes("createRoState.vehicleRequestId = null") && selCust.includes("createRoState.woRequestId = null"),
  );
  const selVeh = sp.slice(sp.indexOf("function selectCroVehicle("), sp.indexOf("function selectCroVehicle(") + 1200);
  ok("changing vehicle drops the WO key", selVeh.includes("createRoState.woRequestId = null"));
}

console.log("Layer 1c: server-owned idempotency derivation — clientRequestId can NOT target existing records");
{
  const existingUpstreamUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; // attacker-known real record ID
  const derived = resolveClientRequestId("contact", 42, "user-1", existingUpstreamUuid);
  ok(
    "a supplied existing-record UUID is never used verbatim as the upstream ID",
    !!derived && derived.toLowerCase() !== existingUpstreamUuid.toLowerCase(),
    String(derived),
  );
  ok(
    "same user+shop+key derives the SAME ID (retry stays idempotent)",
    derived === resolveClientRequestId("contact", 42, "user-1", existingUpstreamUuid),
  );
  ok(
    "key is scoped: different shop, user, or kind derive DIFFERENT IDs",
    derived !== resolveClientRequestId("contact", 43, "user-1", existingUpstreamUuid) &&
      derived !== resolveClientRequestId("contact", 42, "user-2", existingUpstreamUuid) &&
      derived !== resolveClientRequestId("vehicle", 42, "user-1", existingUpstreamUuid),
  );
  ok(
    "derived ID is a valid v4-shaped UUID (accepted by the client's isUuid pin check)",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(derived)),
    String(derived),
  );
  ok(
    "missing/oversized clientRequestId yields undefined (server generates a fresh UUID)",
    resolveClientRequestId("contact", 42, "user-1", undefined) === undefined &&
      resolveClientRequestId("contact", 42, "user-1", "") === undefined &&
      resolveClientRequestId("contact", 42, "user-1", "x".repeat(200)) === undefined,
  );
  ok(
    "deriveIdempotentUpstreamId is deterministic",
    deriveIdempotentUpstreamId("workOrder", 1, "u", "k") === deriveIdempotentUpstreamId("workOrder", 1, "u", "k"),
  );
}

console.log("Layer 2: repeated payloads with the same clientRequestId target the SAME upstream resource");

const config: ProtractorConfig = {
  connectionId: "test-conn",
  apiKey: "test-key",
  authentication: "test-auth",
  configured: true,
};
__protractorClientTestHooks.resolveProtractorConfig = async () => config;
__protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({ acquired: true, waitedMs: 0 });
__protractorClientTestHooks.trackApiRequest = async () => {};
__protractorClientTestHooks.retryBaseDelayMs = 5;

async function main() {
  const endpoints: string[] = [];
  let attempt = 0;
  __protractorClientTestHooks.onFetchStart = (endpoint) => endpoints.push(endpoint);
  __protractorClientTestHooks.httpsRequest = async () => {
    attempt += 1;
    // First route call times out server-side (500 twice with maxRetries:1),
    // the extension retry then succeeds.
    if (attempt <= 2) return { statusCode: 500, body: "saturated" };
    return { statusCode: 200, body: JSON.stringify({ ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) };
  };

  // The extension reuses the same pinned UUID on retry — simulate two route
  // invocations with the identical clientRequestId (what sidepanel.js sends).
  const pinned = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const first = await createContact(9, { firstName: "Ext", lastName: "Retry" }, { priority: true, maxRetries: 1, contactId: pinned });
  const second = await createContact(9, { firstName: "Ext", lastName: "Retry" }, { priority: true, maxRetries: 1, contactId: pinned });

  ok("first attempt failed, extension retry succeeded", first.ok === false && second.ok === true);
  ok(
    "every attempt hit the SAME /Contact/{id} (upsert-by-ID → one record)",
    endpoints.length === 2 && endpoints.every((e) => e === `/Contact/${pinned}`),
    JSON.stringify(endpoints),
  );
  ok("returned the pinned contactId", second.contactId === pinned, String(second.contactId));

  await workOrderRetryScenarios();
}

/**
 * Layer 3: WO create retry idempotency BEYOND the root ID (reviewer case).
 * The route deadline does not cancel a still-running create; a retry with the
 * same pinned WO UUID must not duplicate service packages/lines. We simulate
 * a fake Protractor that persists state across calls: the first create fully
 * applies the package (as a timed-out-but-still-running attempt would), then
 * the retry runs with the identical clientRequestId.
 */
async function workOrderRetryScenarios() {
  console.log("Layer 3: WO retry with same clientRequestId does not duplicate packages/lines");

  // Fake Protractor store with upsert-by-ID semantics.
  const woStore: Record<string, any> = {};
  const updatePostBodies: any[] = [];
  __protractorClientTestHooks.onFetchStart = null;
  __protractorClientTestHooks.httpsRequest = async (url: string, methodArg: string, _headers: any, bodyStr?: string) => {
    const m = String(url).match(/\/WorkOrder\/([0-9a-f-]{36})/i);
    if (!m) return { statusCode: 404, body: "not found" };
    const id = m[1];
    const method = (methodArg || "GET").toUpperCase();
    if (method === "GET") {
      return woStore[id]
        ? { statusCode: 200, body: JSON.stringify(woStore[id]) }
        : { statusCode: 404, body: "no wo" };
    }
    // POST: upsert by ID; merge ServicePackages by package ID (Protractor
    // upserts nested entities by ID rather than blindly appending).
    const payload = JSON.parse(bodyStr || "{}");
    const incoming = Array.isArray(payload.ServicePackages)
      ? payload.ServicePackages
      : payload.ServicePackages?.ItemCollection || [];
    const existing = woStore[id]?.ServicePackages?.ItemCollection || [];
    const merged = [...existing];
    for (const pkg of incoming) {
      const at = merged.findIndex((p: any) => String(p.ID).toLowerCase() === String(pkg.ID).toLowerCase());
      if (at >= 0) merged[at] = pkg;
      else merged.push(pkg);
    }
    woStore[id] = {
      ...(woStore[id] || {}),
      ...payload,
      ID: id,
      WorkOrderNumber: woStore[id]?.WorkOrderNumber || 4242,
      ServicePackages: { ItemCollection: merged },
    };
    // Count only POSTs that carry the job package (the initial create POST
    // carries just concern packages, so it never trips this).
    if (incoming.some((p: any) => p.Chapter !== "Concern")) {
      updatePostBodies.push(payload);
    }
    return { statusCode: 200, body: JSON.stringify(woStore[id]) };
  };

  // Stub the Mongo-backed collaborators of the package-append loop.
  __protractorClientTestHooks.getDb = (async () => ({
    collection: (_name: string) => ({
      findOne: async () => ({ cachedLaborRate: 100 }),
    }),
  })) as any;
  __protractorClientTestHooks.getShopPartCostRatio = (async () => null) as any;

  const pinnedWo = "12121212-3434-4565-8787-909090909090";
  const createParams = {
    contactId: "c-1",
    vehicleId: "v-1",
    concerns: ["brakes squeal"],
    servicePackages: [
      {
        title: "Front Brake Job",
        source: "canned",
        code: "FBJ",
        lines: [{ lineType: "labor", description: "Brake labor", quantity: 2, unitPrice: 100 }],
      },
    ] as any,
  };

  // Attempt 1: completes fully (this is the "kept running past the route
  // deadline" attempt — its work is already on the WO when the user retries).
  const first = await createProtractorWorkOrder(7, createParams as any, { interactive: true, workOrderId: pinnedWo });
  ok("first create succeeded", first.ok === true && first.workOrderId === pinnedWo, JSON.stringify(first));
  const pkgsAfterFirst = woStore[pinnedWo].ServicePackages.ItemCollection;
  const jobPkgsAfterFirst = pkgsAfterFirst.filter((p: any) => p.Chapter !== "Concern");
  ok("first create applied the package once", jobPkgsAfterFirst.length === 1, `count=${jobPkgsAfterFirst.length}`);

  // Attempt 2: extension retry with the SAME clientRequestId.
  const second = await createProtractorWorkOrder(7, createParams as any, { interactive: true, workOrderId: pinnedWo });
  ok("retry create succeeded against the same WO", second.ok === true && second.workOrderId === pinnedWo);

  const pkgs = woStore[pinnedWo].ServicePackages.ItemCollection;
  const jobPkgs = pkgs.filter((p: any) => p.Chapter !== "Concern");
  const concernPkgs = pkgs.filter((p: any) => p.Chapter === "Concern");
  ok("exactly ONE copy of the service package after retry", jobPkgs.length === 1, `count=${jobPkgs.length}`);
  ok("exactly ONE copy of the concern after retry", concernPkgs.length === 1, `count=${concernPkgs.length}`);
  const lines = jobPkgs[0]?.ServicePackageLines?.ItemCollection || jobPkgs[0]?.ServicePackageLines || [];
  ok("exactly the requested line(s), exactly once", lines.length === 1, `lines=${lines.length}`);
  ok(
    "retry skipped the duplicate append (no second package-update POST)",
    updatePostBodies.length === 1,
    `updatePosts=${updatePostBodies.length}`,
  );
  ok(
    "package ID is deterministic from the pinned WO ID",
    jobPkgs[0].ID === deterministicProtractorId(pinnedWo, "pkg", 0, "Front Brake Job", "FBJ"),
    jobPkgs[0].ID,
  );

  // Determinism helper sanity: stable + v4-shaped + distinct per input.
  const a = deterministicProtractorId("x", 1);
  ok(
    "deterministicProtractorId is stable and v4-shaped",
    a === deterministicProtractorId("x", 1) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a) &&
      a !== deterministicProtractorId("x", 2),
    a,
  );
}

const overall = setTimeout(() => {
  console.error("✗ OVERALL HANG: test did not finish within 60s");
  process.exit(1);
}, 60_000);

main()
  .then(() => {
    clearTimeout(overall);
    if (failed > 0) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll extension create clientRequestId checks passed");
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(overall);
    console.error(`\n✗ ${err?.message || err}`);
    process.exit(1);
  });
