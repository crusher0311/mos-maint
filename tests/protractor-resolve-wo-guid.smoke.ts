/**
 * Smoke test: resolveWorkOrderGuid cached-GUID fast path (Task #903).
 *
 * Run: `npx tsx tests/protractor-resolve-wo-guid.smoke.ts`
 *
 * Manual RO-number adds must prefer the cached work-order GUID (one
 * upstream fetch-by-ID) and only fall back to the active-work-order scan
 * on a cache miss, a failed fetch, or an RO-number mismatch on the fetched
 * work order. Open Protractor WOs are unreliable via OData number lookup
 * (memory: protractor-add-job-open-wo), so the GUID-first ordering is both
 * the fast AND the reliable path. This test pins:
 *   1. cache hit + matching RO# → resolved with ZERO active-scan calls
 *   2. cache hit but fetched WO has a different RO# → falls back to scan
 *   3. cache miss → falls back to scan
 *   4. cached GUID 404s upstream → falls back to scan
 *   5. current snapshot shape (workOrderGuid/workOrderId) and legacy
 *      shape (data.ID) both yield the GUID
 */

import {
  __protractorClientTestHooks,
  resolveWorkOrderGuid,
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

const SHOP_ID = 42;
const GUID = "11111111-2222-3333-4444-555555555555";
const SCAN_GUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const RO = 9876;

const config: ProtractorConfig = {
  connectionId: "test-conn",
  apiKey: "test-key",
  authentication: "test-auth",
  configured: true,
};

// Stub Mongo-backed collaborators. protractorFetch, the retry loop and the
// resolveWorkOrderGuid ordering under test are the REAL production paths.
__protractorClientTestHooks.resolveProtractorConfig = async () => config;
__protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
  acquired: true,
  waitedMs: 0,
});
__protractorClientTestHooks.trackApiRequest = async () => {};
__protractorClientTestHooks.retryBaseDelayMs = 1;

type Calls = { byId: number; scan: number };

function stubUpstream(opts: {
  byIdStatus?: number;
  byIdWorkOrderNumber?: number;
}): Calls {
  const calls: Calls = { byId: 0, scan: 0 };
  __protractorClientTestHooks.httpsRequest = async (url: string) => {
    if (url.includes("/WorkOrder/?")) {
      // Active work-order scan (list endpoint)
      calls.scan += 1;
      return {
        statusCode: 200,
        body: JSON.stringify({
          ItemCollection: [
            { ID: SCAN_GUID, WorkOrderNumber: RO, Type: "WorkOrder" },
          ],
        }),
      };
    }
    // Fetch-by-ID
    calls.byId += 1;
    const status = opts.byIdStatus ?? 200;
    if (status !== 200) return { statusCode: status, body: "Not Found" };
    return {
      statusCode: 200,
      body: JSON.stringify({
        ID: GUID,
        WorkOrderNumber: opts.byIdWorkOrderNumber ?? RO,
        Type: "WorkOrder",
      }),
    };
  };
  return calls;
}

async function main() {
  console.log("Scenario 1: cache hit (current shape) resolves in ONE upstream call, no scan");
  {
    const calls = stubUpstream({});
    __protractorClientTestHooks.findCachedWorkOrderByRoNumber = async () =>
      ({ shopId: SHOP_ID, workOrderId: GUID, workOrderGuid: GUID, workOrderNumber: RO } as any);
    const res = await resolveWorkOrderGuid(SHOP_ID, String(RO));
    ok("resolved ok", res.ok === true, res.error);
    ok("returns cached GUID", res.workOrderGuid === GUID);
    ok("exactly one fetch-by-ID", calls.byId === 1, `byId=${calls.byId}`);
    ok("NO active-WO scan", calls.scan === 0, `scan=${calls.scan}`);
  }

  console.log("Scenario 2: legacy cache shape (data.ID only) also hits the fast path");
  {
    const calls = stubUpstream({});
    __protractorClientTestHooks.findCachedWorkOrderByRoNumber = async () =>
      ({ shopId: SHOP_ID, data: { ID: GUID, WorkOrderNumber: RO } } as any);
    const res = await resolveWorkOrderGuid(SHOP_ID, String(RO));
    ok("resolved ok", res.ok === true, res.error);
    ok("returns cached GUID", res.workOrderGuid === GUID);
    ok("NO active-WO scan", calls.scan === 0, `scan=${calls.scan}`);
  }

  console.log("Scenario 3: cached GUID resolves to DIFFERENT RO# → falls back to scan");
  {
    const calls = stubUpstream({ byIdWorkOrderNumber: RO + 1 });
    __protractorClientTestHooks.findCachedWorkOrderByRoNumber = async () =>
      ({ shopId: SHOP_ID, workOrderGuid: GUID } as any);
    const res = await resolveWorkOrderGuid(SHOP_ID, String(RO));
    ok("resolved ok via scan", res.ok === true, res.error);
    ok("returns scan GUID, not stale cached GUID", res.workOrderGuid === SCAN_GUID, res.workOrderGuid);
    ok("scan performed", calls.scan >= 1, `scan=${calls.scan}`);
  }

  console.log("Scenario 4: cache miss → falls back to scan");
  {
    const calls = stubUpstream({});
    __protractorClientTestHooks.findCachedWorkOrderByRoNumber = async () => null;
    const res = await resolveWorkOrderGuid(SHOP_ID, String(RO));
    ok("resolved ok via scan", res.ok === true, res.error);
    ok("returns scan GUID", res.workOrderGuid === SCAN_GUID, res.workOrderGuid);
    ok("no fetch-by-ID attempted", calls.byId === 0, `byId=${calls.byId}`);
  }

  console.log("Scenario 5: cached GUID 404s upstream → falls back to scan");
  {
    const calls = stubUpstream({ byIdStatus: 404 });
    __protractorClientTestHooks.findCachedWorkOrderByRoNumber = async () =>
      ({ shopId: SHOP_ID, workOrderGuid: GUID } as any);
    const res = await resolveWorkOrderGuid(SHOP_ID, String(RO));
    ok("resolved ok via scan", res.ok === true, res.error);
    ok("returns scan GUID", res.workOrderGuid === SCAN_GUID, res.workOrderGuid);
    ok("scan performed", calls.scan >= 1, `scan=${calls.scan}`);
  }

  console.log("Scenario 6: non-GUID junk in cache doc is ignored (falls back to scan)");
  {
    const calls = stubUpstream({});
    __protractorClientTestHooks.findCachedWorkOrderByRoNumber = async () =>
      ({ shopId: SHOP_ID, workOrderId: "not-a-guid" } as any);
    const res = await resolveWorkOrderGuid(SHOP_ID, String(RO));
    ok("resolved ok via scan", res.ok === true, res.error);
    ok("returns scan GUID", res.workOrderGuid === SCAN_GUID, res.workOrderGuid);
    ok("no fetch-by-ID attempted", calls.byId === 0, `byId=${calls.byId}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll resolveWorkOrderGuid fast-path assertions passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
