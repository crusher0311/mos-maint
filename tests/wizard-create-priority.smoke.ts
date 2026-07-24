/**
 * Smoke test: New Work Order wizard create calls are interactive-safe (Task #936).
 *
 * Run: `npx tsx tests/wizard-create-priority.smoke.ts`
 *
 * Background: the wizard's write calls (createContact / createProtractorWorkOrder)
 * ran on the shared BACKGROUND lane with up to 6 exponential-backoff retries and
 * no deadline — backfill traffic could starve them for minutes and the Create
 * Customer button spun forever. The fix routes them onto the priority pool with
 * capped retries, pins client-generated IDs for duplicate-safe retries, and
 * bounds the route with an upstream deadline. This test pins those behaviors
 * using the real client code paths via __protractorClientTestHooks.
 */

import {
  __protractorClientTestHooks,
  createContact,
  createProtractorWorkOrder,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";
import { withUpstreamTimeout } from "../lib/with-upstream-timeout";
import {
  type CreateRequestIds,
  getOrCreateRequestId,
  clearRequestId,
  resetRequestIds,
} from "../lib/create-request-ids";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const config: ProtractorConfig = {
  connectionId: "test-conn",
  apiKey: "test-key",
  authentication: "test-auth",
  configured: true,
};

// Stub Mongo-backed collaborators; the concurrency pool, retry loop, and the
// wizard opts plumbing under test are the REAL production code paths.
__protractorClientTestHooks.resolveProtractorConfig = async () => config;
__protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
  acquired: true,
  waitedMs: 0,
});
__protractorClientTestHooks.trackApiRequest = async () => {};
__protractorClientTestHooks.retryBaseDelayMs = 5;

async function main() {
  console.log("Scenario 1: createContact with interactive opts uses priority lane + capped retries");
  {
    let calls = 0;
    let seenOpts: { priority?: boolean; maxRetries?: number } | undefined;
    let seenEndpoint = "";
    __protractorClientTestHooks.onFetchStart = (endpoint, opts) => {
      seenEndpoint = endpoint;
      seenOpts = opts;
    };
    __protractorClientTestHooks.httpsRequest = async () => {
      calls += 1;
      return { statusCode: 500, body: "upstream sad" };
    };

    const pinnedId = "11111111-2222-4333-8444-555555555555";
    const result = await createContact(
      1,
      { firstName: "Jane", lastName: "Doe" },
      { priority: true, maxRetries: 1, contactId: pinnedId },
    );

    ok("returns ok:false instead of hanging", result.ok === false);
    ok("ran on the priority lane", seenOpts?.priority === true, JSON.stringify(seenOpts));
    ok("retries capped at 1 (2 attempts total)", calls === 2, `calls=${calls}`);
    ok(
      "client-pinned contact UUID reused (idempotent retry key)",
      seenEndpoint === `/Contact/${pinnedId}`,
      seenEndpoint,
    );
  }

  console.log("Scenario 2: retry after failure re-POSTs the SAME pinned contact ID (no dupes)");
  {
    const endpoints: string[] = [];
    let attempt = 0;
    __protractorClientTestHooks.onFetchStart = (endpoint) => endpoints.push(endpoint);
    __protractorClientTestHooks.httpsRequest = async () => {
      attempt += 1;
      if (attempt <= 2) return { statusCode: 500, body: "still sad" };
      return { statusCode: 200, body: JSON.stringify({ ID: "11111111-2222-4333-8444-555555555555" }) };
    };

    const pinnedId = "11111111-2222-4333-8444-555555555555";
    const first = await createContact(1, { firstName: "J", lastName: "D" }, { priority: true, maxRetries: 1, contactId: pinnedId });
    const second = await createContact(1, { firstName: "J", lastName: "D" }, { priority: true, maxRetries: 1, contactId: pinnedId });

    ok("first attempt failed, second (user retry) succeeded", first.ok === false && second.ok === true);
    ok(
      "both attempts targeted the same /Contact/{id} (upsert-by-ID, no duplicate)",
      endpoints.length === 2 && endpoints[0] === endpoints[1] && endpoints[0] === `/Contact/${pinnedId}`,
      JSON.stringify(endpoints),
    );
    ok("returned the pinned contactId", second.contactId === pinnedId, String(second.contactId));
  }

  console.log("Scenario 3: invalid client-supplied ID falls back to a fresh server UUID");
  {
    let seenEndpoint = "";
    __protractorClientTestHooks.onFetchStart = (endpoint) => (seenEndpoint = endpoint);
    __protractorClientTestHooks.httpsRequest = async () => ({
      statusCode: 200,
      body: JSON.stringify({}),
    });

    await createContact(1, { firstName: "A", lastName: "B" }, { priority: true, maxRetries: 1, contactId: "'; DROP TABLE--" });
    const idPart = seenEndpoint.replace("/Contact/", "");
    ok(
      "malformed clientRequestId was NOT used as the contact ID",
      /^[0-9a-f-]{36}$/i.test(idPart) && idPart !== "'; DROP TABLE--",
      seenEndpoint,
    );
  }

  console.log("Scenario 4: createProtractorWorkOrder interactive opts hit the priority lane w/ capped retries");
  {
    let calls = 0;
    let seenOpts: { priority?: boolean; maxRetries?: number } | undefined;
    let seenEndpoint = "";
    __protractorClientTestHooks.onFetchStart = (endpoint, opts) => {
      if (!seenEndpoint) {
        seenEndpoint = endpoint;
        seenOpts = opts;
      }
    };
    __protractorClientTestHooks.httpsRequest = async () => {
      calls += 1;
      return { statusCode: 500, body: "wo create sad" };
    };

    const pinnedId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const result = await createProtractorWorkOrder(
      1,
      { contactId: "c-1", vehicleId: "v-1" },
      { interactive: true, workOrderId: pinnedId },
    );

    ok("returns ok:false instead of hanging", result.ok === false);
    ok("WO create ran on the priority lane", seenOpts?.priority === true, JSON.stringify(seenOpts));
    ok("WO create retries capped at 1 (2 attempts total)", calls === 2, `calls=${calls}`);
    ok("client-pinned WO UUID used", seenEndpoint === `/WorkOrder/${pinnedId}`, seenEndpoint);
  }

  console.log("Scenario 5: route deadline pattern — a stalled upstream returns a timeout fallback, not a hang");
  {
    __protractorClientTestHooks.onFetchStart = null;
    // Upstream that never answers within the deadline.
    __protractorClientTestHooks.httpsRequest = () =>
      new Promise(() => {
        /* hang forever */
      });

    const t0 = Date.now();
    const result = await withUpstreamTimeout(
      createContact(1, { firstName: "Stall", lastName: "Case" }, { priority: true, maxRetries: 1 }),
      250,
      "wizard-create-contact test",
      { ok: false, error: "Protractor is responding slowly — please try again.", timedOut: true } as any,
    );
    const elapsed = Date.now() - t0;

    ok("stalled upstream resolved via deadline fallback", result.ok === false && (result as any).timedOut === true);
    ok("resolved promptly (bounded, not hanging)", elapsed < 5_000, `elapsed=${elapsed}ms`);
    ok("carries the retryable user-facing message", /responding slowly/.test(result.error || ""));
  }

  console.log("Scenario 6: background callers keep the generous defaults (no behavior change)");
  {
    let calls = 0;
    let seenOpts: { priority?: boolean; maxRetries?: number } | undefined | null = null;
    __protractorClientTestHooks.onFetchStart = (_e, opts) => (seenOpts = opts);
    __protractorClientTestHooks.httpsRequest = async () => {
      calls += 1;
      return { statusCode: 500, body: "bg sad" };
    };

    const result = await createContact(1, { firstName: "Bg", lastName: "Lane" });
    ok("background call got no interactive opts", seenOpts === undefined, JSON.stringify(seenOpts));
    ok("background POST kept default 6 retries (7 attempts)", calls === 7, `calls=${calls}`);
    ok("still returns ok:false", result.ok === false);
  }

  console.log("Scenario 7: idempotency keys are session-scoped (modal close/reopen gets a FRESH UUID)");
  {
    const ids: CreateRequestIds = {};

    // First submit generates a key; a retry after a timeout reuses it.
    const first = getOrCreateRequestId(ids, "contact");
    const retry = getOrCreateRequestId(ids, "contact");
    ok("retry within a session reuses the same key", first === retry && /^[0-9a-f-]{36}$/i.test(first), `${first} vs ${retry}`);

    // Success clears just that step's key.
    clearRequestId(ids, "contact");
    const afterSuccess = getOrCreateRequestId(ids, "contact");
    ok("post-success create gets a fresh key", afterSuccess !== first, afterSuccess);

    // Modal close/reset clears ALL keys — a stale key surviving reopen would
    // upsert (overwrite) the previous session's Protractor record.
    getOrCreateRequestId(ids, "vehicle");
    getOrCreateRequestId(ids, "workOrder");
    const staleContact = ids.contact;
    resetRequestIds(ids);
    ok("reset clears every step's key", !ids.contact && !ids.vehicle && !ids.workOrder);
    const reopened = getOrCreateRequestId(ids, "contact");
    ok("reopened session generates a NEW contact key", reopened !== staleContact, `${staleContact} vs ${reopened}`);
  }
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
    console.log("\nAll wizard-create priority/deadline checks passed");
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(overall);
    console.error(`\n✗ ${err?.message || err}`);
    process.exit(1);
  });
