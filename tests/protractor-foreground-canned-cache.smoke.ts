/**
 * Offline regression coverage for the staged timed-trial canned-jobs cache
 * path. Interactive callers may read a cache and fetch a bounded list miss,
 * but must never start detached detail enrichment or write a partial list.
 *
 * Run: `npx tsx tests/protractor-foreground-canned-cache.smoke.ts`
 */

import assert from "node:assert/strict";
import https from "node:https";

// This standalone test must never fall through to real provider transport,
// including detached work that outlives an assertion or fixture cleanup.
https.request = (() => {
  throw new Error("Network access forbidden in foreground canned-cache smoke");
}) as typeof https.request;

const Module = require("module");
const originalModuleLoad = Module._load;

const SHOP_ID = 481;
const config = {
  shopId: SHOP_ID,
  connectionId: "foreground-cache-connection",
  apiKey: "foreground-cache-key",
  authentication: "foreground-cache-auth",
  configured: true,
};

type CacheState = {
  cached: any | null;
  writes: Array<{ collection: string; update: any }>;
};

const state: CacheState = {
  cached: null,
  writes: [],
};

const endpoints: string[] = [];
let listShouldFail = false;
let emptyListShouldSucceed = false;

const fakeDb = {
  collection(name: string) {
    return {
      findOne: async () => {
        if (name === "protractor_canned_jobs") return state.cached;
        if (name === "shops") {
          return {
            shopId: SHOP_ID,
            integrationProvider: "protractor",
            protractor: {
              connectionId: config.connectionId,
              apiKey: config.apiKey,
            },
          };
        }
        return null;
      },
      updateOne: async (_filter: any, update: any) => {
        state.writes.push({ collection: name, update });
        if (name !== "protractor_canned_jobs") return;
        state.cached = {
          ...(state.cached || { shopId: SHOP_ID }),
          ...(update.$set || {}),
        };
      },
    };
  },
};

// The client imports getDb directly, and fetchCannedJobs directly resolves
// shop credentials instead of going through the test hook. Mock the real
// module before requiring the client so neither path can touch ambient
// Mongo. This is the same loader-boundary technique used by the route runtime
// smoke test.
const moduleMocks = new Map<string, any>([
  ["@/lib/mongo", { getDb: async () => fakeDb }],
]);
Module._load = function (request: string, parent: any, ...rest: any[]) {
  if (moduleMocks.has(request)) return moduleMocks.get(request);
  return originalModuleLoad.call(this, request, parent, ...rest);
};

const {
  __protractorClientTestHooks,
  fetchCannedJobsWithCache,
  runWithProtractorInteractiveTransport,
} = require("../lib/integrations/protractor/client") as typeof import("../lib/integrations/protractor/client");

const original = {
  envTrial: process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED,
  httpsRequest: __protractorClientTestHooks.httpsRequest,
  getDb: __protractorClientTestHooks.getDb,
  resolveProtractorConfig: __protractorClientTestHooks.resolveProtractorConfig,
  acquireOutboundGate: __protractorClientTestHooks.acquireOutboundGate,
  acquireDistributedRateLimitSlot:
    __protractorClientTestHooks.acquireDistributedRateLimitSlot,
  trackApiRequest: __protractorClientTestHooks.trackApiRequest,
  recordResponse: __protractorClientTestHooks.recordResponse,
  getOperatorStop: __protractorClientTestHooks.getOperatorStop,
  onFetchStart: __protractorClientTestHooks.onFetchStart,
};

function resetCache(cached: any | null): void {
  state.cached = cached;
  state.writes.length = 0;
  endpoints.length = 0;
}

function configureTimedTrial(): void {
  process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED = "true";
  const now = Date.now();
  __protractorClientTestHooks.getOperatorStop = async () => ({
    active: false,
    canary: {
      mode: "timed_trial",
      generation: "foreground-cache-generation",
      startedAt: new Date(now - 1_000),
      expiresAt: new Date(now + 60_000),
      endedAt: null,
      endedBy: null,
      maxAdmissions: null,
      remainingAdmissions: null,
      scope: "callbacks_and_interactive",
      requiresCallback: false,
    },
  } as any);
}

function configureTransport(): void {
  __protractorClientTestHooks.getDb = async () => fakeDb as any;
  __protractorClientTestHooks.resolveProtractorConfig = async () => config;
  __protractorClientTestHooks.acquireOutboundGate = async () => ({
    allowed: true,
    probe: false,
  });
  __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
    acquired: true,
    waitedMs: 0,
    currentCount: 1,
  });
  __protractorClientTestHooks.trackApiRequest = async () => {};
  __protractorClientTestHooks.recordResponse = async () => {};
  __protractorClientTestHooks.onFetchStart = (endpoint) => {
    endpoints.push(endpoint);
  };
  __protractorClientTestHooks.httpsRequest = async (url) => {
    endpoints.push(`transport:${url}`);
    if (listShouldFail) {
      return { statusCode: 400, body: "offline canned-jobs list failure" };
    }

    if (
      emptyListShouldSucceed &&
      (url.includes("/CannedJob/?") || url.includes("/ServicePackageTemplate"))
    ) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ItemCollection: [] }),
      };
    }

    if (url.includes("/CannedJob/?")) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ItemCollection: [{
            ID: "job-1",
            Code: "OIL",
            Title: "Oil Service",
          }],
        }),
      };
    }

    if (url.includes("/ServicePackage/CannedJob/")) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ID: "job-1",
          ServicePackageHeader: { Title: "Detailed Oil Service" },
          ServicePackageLines: { ItemCollection: [{ ID: "line-1", Type: "Labor" }] },
        }),
      };
    }

    return { statusCode: 400, body: "unexpected endpoint in foreground cache test" };
  };
}

function linelessEnrichedCache(): any {
  return {
    shopId: SHOP_ID,
    source: "enriched",
    items: Array.from({ length: 10 }, (_, index) => ({
      id: `cached-${index}`,
      title: `Cached job ${index}`,
      lineCount: 0,
      lines: [],
    })),
  };
}

async function main(): Promise<void> {
  configureTransport();
  configureTimedTrial();

  try {
    resetCache(linelessEnrichedCache());
    const hit = await runWithProtractorInteractiveTransport(SHOP_ID, () =>
      fetchCannedJobsWithCache(SHOP_ID),
    );
    assert.equal(hit.ok, true);
    assert.equal(hit.cannedJobs?.length, 10);
    assert.equal(hit.cannedJobs?.[0]?.title, "Cached job 0");
    assert.equal(endpoints.length, 0, "lineless cache hit must not launch detail/list transport");
    assert.equal(state.writes.length, 0, "lineless cache hit must not stamp or rewrite cache");

    resetCache({
      shopId: SHOP_ID,
      source: "enriched",
      items: Array.from({ length: 10 }, (_, index) => ({
        id: `poison-${index}`,
        title: "",
        lines: [],
        lineCount: 0,
      })),
    });
    listShouldFail = false;
    emptyListShouldSucceed = false;
    const poison = await runWithProtractorInteractiveTransport(SHOP_ID, () =>
      fetchCannedJobsWithCache(SHOP_ID),
    );
    assert.equal(poison.ok, true);
    assert.equal(poison.source, "api");
    assert.equal(poison.cannedJobs?.[0]?.title, "Oil Service");
    assert.ok(
      endpoints.some((endpoint) => endpoint.includes("/CannedJob/?")),
      "blank poisoned cache must be replaced by a foreground list read",
    );
    assert.ok(
      !endpoints.some((endpoint) => endpoint.includes("/ServicePackage/CannedJob/")),
      "blank poisoned cache must not launch detail enrichment",
    );
    assert.equal(state.writes.length, 0, "blank poisoned cache must not be overwritten during trial");

    resetCache({
      shopId: SHOP_ID,
      source: "enriched",
      items: [{ id: "cached-1", title: "Cached title", lines: [{ id: "line-1" }] }],
    });
    const forced = await runWithProtractorInteractiveTransport(SHOP_ID, () =>
      fetchCannedJobsWithCache(SHOP_ID, undefined, { forceRefresh: true }),
    );
    assert.equal(forced.ok, false);
    assert.equal(
      forced.error,
      "PROTRACTOR_CANNED_JOBS_FORCE_REFRESH_UNAVAILABLE_DURING_TIMED_TRIAL",
    );
    assert.equal(endpoints.length, 0, "force refresh rejection must not start list/detail transport");
    assert.equal(state.writes.length, 0, "force refresh rejection must not write cache");

    resetCache(null);
    listShouldFail = false;
    const miss = await runWithProtractorInteractiveTransport(SHOP_ID, () =>
      fetchCannedJobsWithCache(SHOP_ID),
    );
    assert.equal(miss.ok, true);
    assert.equal(miss.source, "api");
    assert.equal(miss.cannedJobs?.[0]?.title, "Oil Service");
    assert.ok(
      endpoints.some((endpoint) => endpoint.includes("/CannedJob/?")),
      "true timed-trial miss may fetch the list endpoint",
    );
    assert.ok(
      !endpoints.some((endpoint) => endpoint.includes("/ServicePackage/CannedJob/")),
      "true timed-trial miss must not fetch detail endpoints",
    );
    assert.equal(state.writes.length, 0, "true timed-trial miss must not write partial list");

    resetCache(null);
    listShouldFail = false;
    emptyListShouldSucceed = true;
    const empty = await runWithProtractorInteractiveTransport(SHOP_ID, () =>
      fetchCannedJobsWithCache(SHOP_ID),
    );
    assert.equal(empty.ok, true);
    assert.equal(empty.source, "api");
    assert.deepEqual(empty.cannedJobs, []);
    assert.equal(state.writes.length, 0, "successful empty timed-trial list must not write cache");
    assert.ok(
      !endpoints.some((endpoint) => endpoint.includes("/ServicePackage/CannedJob/")),
      "successful empty timed-trial list must not attempt detail enrichment",
    );

    resetCache(null);
    listShouldFail = true;
    emptyListShouldSucceed = false;
    const failed = await runWithProtractorInteractiveTransport(SHOP_ID, () =>
      fetchCannedJobsWithCache(SHOP_ID),
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error || "", /Could not fetch canned jobs|failure/i);
    assert.equal(state.writes.length, 0, "failed timed-trial list must not write cache");
    assert.ok(
      !endpoints.some((endpoint) => endpoint.includes("/ServicePackage/CannedJob/")),
      "failed timed-trial list must not attempt detail enrichment",
    );

    // Outside the timed interactive scope, retain the legacy cache behavior:
    // a true miss writes the basic list and schedules deep enrichment.
    delete process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED;
    listShouldFail = false;
    emptyListShouldSucceed = false;
    resetCache(null);
    const nontrial = await fetchCannedJobsWithCache(SHOP_ID);
    assert.equal(nontrial.ok, true);
    assert.equal(nontrial.source, "api");
    assert.ok(state.writes.length >= 1, "nontrial miss still writes the basic cache list");
    const waitUntilDetail = Date.now() + 3_000;
    while (
      !state.writes.some((entry) => entry.update?.$set?.source === "enriched") &&
      Date.now() < waitUntilDetail
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      endpoints.some((endpoint) => endpoint.includes("/ServicePackage/CannedJob/")),
      "nontrial miss retains detached detail enrichment",
    );
    assert.ok(
      state.writes.some((entry) => entry.update?.$set?.source === "enriched"),
      "wait for detached enrichment to finish before fixture cleanup",
    );
  } finally {
    if (original.envTrial === undefined) delete process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED;
    else process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED = original.envTrial;
    // Keep dependency mocks installed until this standalone process exits.
    // Restoring live implementations here can release detached work into real
    // DB/provider calls, especially when an earlier assertion throws.
  }

  console.log("protractor foreground canned-cache smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});