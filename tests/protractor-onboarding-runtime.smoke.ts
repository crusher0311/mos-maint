import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { getProtractorInteractiveTransportContext } from "../lib/integrations/protractor/interactive-context";

const Module = require("module");
const originalLoad = Module._load;
let session: any = { shopId: "42" };
let shop: any = { shopId: 42 };
let cursor: any = null;
let policy: any = { allowed: true };
let stop: any = null;
let validation: any = { ok: true, locations: [] };
let context: any;
let validations = 0;
let writes = 0;
let workCalls = 0;
let throwValidation = false;
let throwProgressUpsert = false;
let throwWebhookBookkeeping = false;
const get = (obj: any, path: string) => path.split(".").reduce((v, key) => v?.[key], obj);
function set(obj: any, path: string, value: any) {
  const parts = path.split(".");
  const last = parts.pop()!;
  for (const part of parts) obj = obj[part] ??= {};
  obj[last] = value;
}
function matches(filter: any) {
  return Object.entries(filter).every(([key, value]: any) => {
    if (value && typeof value === "object" && "$exists" in value) return (get(shop, key) !== undefined) === value.$exists;
    return get(shop, key) === value;
  });
}
const db = { collection: (name: string) => {
  assert.equal(name, "shops", "no destructive cache cleanup or raw progress storage");
  return {
    findOne: async () => structuredClone(shop),
    updateOne: async (filter: any, update: any) => {
      assert.notEqual(getProtractorInteractiveTransportContext()?.active, true, "DB mutations must not inherit validation scope");
      if (!matches(filter)) return { matchedCount: 0 };
      writes++;
      for (const [key, value] of Object.entries(update.$set || {})) set(shop, key, value);
      for (const key of Object.keys(update.$unset || {})) {
        const parts = key.split(".");
        const last = parts.pop()!;
        const parent = parts.length ? get(shop, parts.join(".")) : shop;
        if (parent) delete parent[last];
      }
      return { matchedCount: 1 };
    },
  };
} };
const integration = {
  testConnection: async (_id: string, _key: string, shopId: number) => {
    validations++;
    context = getProtractorInteractiveTransportContext();
    assert.equal(context?.active, true);
    assert.equal(context?.shopId, shopId);
    assert.equal(shopId, 42);
    if (throwValidation) throw new Error("transport unavailable");
    return validation;
  },
  resolveProtractorConfig: async () => ({
    configured: shop.protractor?.configured === true,
    connectionId: shop.protractorConnectionId,
    apiKey: shop.protractorApiKey,
  }),
};
const mocks: Record<string, any> = {
  "@/lib/data/repositories/api-usage": { getProtractorOperatorStop: async () => stop },
  "@/lib/auth": { getSession: async () => session },
  "@/lib/mongo": { getDb: async () => db },
  "@/lib/integrations/protractor": integration,
  "@/lib/integrations/protractor/webhook-subscribe": {
    ensureProtractorWebhookSubscription: async () => {
      assert.notEqual(getProtractorInteractiveTransportContext()?.active, true);
      if (throwWebhookBookkeeping) throw new Error("sensitive-webhook-error-must-not-be-logged");
    },
  },
  "@/lib/data/repositories/protractor-backfill-progress": {
    findByShop: async () => cursor,
    upsertMerge: async (_shopId: number, update: any) => {
      assert.notEqual(getProtractorInteractiveTransportContext()?.active, true);
      if (throwProgressUpsert) throw new Error("sensitive-database-error-must-not-be-logged");
      cursor ??= { ...update.setOnInsert };
      Object.assign(cursor, update.set || {});
    },
  },
  "@/lib/data/repositories/protractor-service-items": { countServiceItemsByShop: async () => 7 },
};
Module._load = function(request: string, parent: any, ...rest: any[]) {
  if (mocks[request]) return mocks[request];
  if (request === "./client" && parent.filename.endsWith("/protractor/onboarding.ts")) {
    return { getEffectiveProtractorOutboundPolicy: async () => policy };
  }
  return originalLoad.call(this, request, parent, ...rest);
};
const route = require("../app/api/settings/protractor/route");
const testRoute = require("../app/api/settings/protractor/test/route");
const { runStagedInitialSync } = require("../lib/integrations/protractor/onboarding");
const { writeProtractorCheckpoint, markProtractorBackfillComplete, withInitialSyncCheckpointFence } =
  require("../lib/integrations/protractor/initial-sync-fence");
const req = (body = { connectionId: "offline-id", apiKey: "offline-key" }) =>
  new NextRequest("http://localhost/api/settings/protractor", { method: "POST", body: JSON.stringify(body) });
const result = (complete = false, error?: string) => ({ chunksProcessed: 1, totalJobsIndexed: 2, complete, error });
const work = async () => { workCalls++; return result(); };

async function run() {
  for (const handler of [route.POST, testRoute.POST]) {
    session = null;
    const prior = validations;
    assert.equal((await handler(req())).status, 401);
    assert.equal(validations, prior);
    session = { shopId: "bad" };
    assert.equal((await handler(req())).status, 403);
    assert.equal(validations, prior);
    session = { shopId: 42 };
    assert.equal((await handler(req({ connectionId: " ", apiKey: "key" }))).status, 400);
    assert.equal(validations, prior);
    validation = { ok: false, code: "PROTRACTOR_VALIDATION_UNAVAILABLE", error: "restricted" };
    const denied = await handler(req());
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).code, "PROTRACTOR_VALIDATION_UNAVAILABLE");
    assert.equal(context.active, false, "scope closes on denial");
    assert.equal(writes, 0, "validation denial cannot save credentials");
    validation = { ok: false, code: "PROTRACTOR_INVALID_CREDENTIALS" };
    assert.equal((await handler(req())).status, 400);
    assert.equal(writes, 0);
    throwValidation = true;
    assert.equal((await handler(req())).status, 503);
    assert.equal(context.active, false, "scope closes on exception");
    throwValidation = false;
  }
  validation = { ok: true, locations: [] };
  assert.equal((await testRoute.POST(req())).status, 200);
  assert.equal(writes, 0);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: any[]) => { warnings.push(args.join(" ")); };
  throwProgressUpsert = true;
  throwWebhookBookkeeping = true;
  try {
    const committed = await route.POST(req());
    assert.equal(committed.status, 200, "auxiliary queue failure cannot masquerade as committed credential-save failure");
    const body = await committed.json();
    assert.equal(body.ok, true);
    assert.equal(body.jobHistoryBackfill, "queued");
    assert.equal(body.initialSyncState, "pending");
    assert.match(body.initialSyncError, /Connection saved.*queued/);
    assert.equal(shop.protractor.configured, true);
    assert.equal(shop.protractor.initialSyncState, "pending", "durable shop remains discoverable without a cursor");
    assert.equal(cursor, null);
    assert.equal(context.active, false);
    assert.equal(workCalls, 0);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(warning => warning.length < 200 && !warning.includes("sensitive")));
    assert.equal((await (await route.GET(req())).json()).configured, true);
  } finally {
    console.warn = originalWarn;
    throwProgressUpsert = false;
    throwWebhookBookkeeping = false;
  }
  const connected = await route.POST(req());
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).initialSyncState, "pending");
  assert.equal((await (await route.GET(req())).json()).initialSyncState, "pending");
  assert.equal(context.active, false);
  assert.ok(cursor, "canonical cursor row is durable");
  assert.equal(workCalls, 0, "web Connect never launches historical work");
  const token = shop.protractorWebhookToken;
  (cursor as any).currentChunkEnd = "keep-history";
  assert.equal((await route.POST(req())).status, 200);
  assert.equal((cursor as any).currentChunkEnd, "keep-history");
  assert.equal(shop.protractorWebhookToken, token, "reconnect preserves portal token");
  assert.equal((await route.POST(req({ connectionId: "different-id", apiKey: "different-key" }))).status, 409);
  assert.equal(shop.protractorConnectionId, "offline-id");
  const binding = shop.protractor.connectionGeneration;
  shop.integrationProvider = "tekmetric";
  assert.equal((await route.POST(req())).status, 409);
  shop.integrationProvider = "protractor";

  // Effective shared scope is restrictive even if this replica's local
  // decision said allowed and omitted callbackOnly.
  for (const restricted of [
    { allowed: false },
    { allowed: true, callbackOnly: true },
    { allowed: true, allowInteractive: true, callbackNotBeforeMs: 1 },
    { allowed: true, requireTimedTrial: true },
  ]) {
    policy = restricted;
    const denied = await runStagedInitialSync(db, 42, work);
    assert.ok(denied.error);
    assert.equal(shop.protractor.initialSyncState, "pending");
    assert.equal(workCalls, 0);
  }
  policy = { allowed: true };
  stop = { active: true };
  await runStagedInitialSync(db, 42, work);
  assert.equal(workCalls, 0, "operator stop keeps queued work pending");
  stop = { active: false, canary: { mode: "bounded" } };
  await runStagedInitialSync(db, 42, work);
  assert.equal(workCalls, 0, "a canary is not bulk-worker permission");
  stop = null;
  await runStagedInitialSync(db, 42, async () => {
    assert.equal(shop.protractor.initialSyncState, "running");
    return work();
  });
  assert.equal(shop.protractor.initialSyncState, "pending", "one partial batch is not complete");
  assert.equal(shop.protractor.initialSyncVehicles, 7);
  await runStagedInitialSync(db, 42, async () => result(false, "retryable history error"));
  assert.equal(shop.protractor.initialSyncState, "failed");
  policy = { allowed: false };
  const failedReconnect = await (await route.POST(req())).json();
  assert.equal(failedReconnect.initialSyncState, "failed");
  assert.equal(failedReconnect.initialSyncError, "retryable history error");
  await runStagedInitialSync(db, 42, work);
  assert.equal(shop.protractor.initialSyncState, "failed", "policy denial is not an actual retry");
  assert.equal(shop.protractor.initialSyncError, "retryable history error");
  policy = { allowed: true };
  await runStagedInitialSync(db, 42, async () => {
    assert.equal(shop.protractor.initialSyncState, "running");
    assert.equal(shop.protractor.initialSyncError, null, "only an admitted worker retry clears prior failure");
    return result(true);
  });
  assert.equal(shop.protractor.initialSyncState, "complete");
  assert.equal(shop.protractor.initialSyncError, null);
  shop.protractor.initialSyncState = "running";
  shop.protractor.initialSyncStartedAt = new Date(0);
  assert.equal((await (await route.GET(req())).json()).initialSyncState, "pending", "abandoned worker is resumable, not falsely complete");
  await runStagedInitialSync(db, 42, async () => {
    shop.protractor.connectionGeneration = "replacement";
    shop.protractor.initialSyncState = "pending";
    return result(true);
  });
  assert.equal(shop.protractor.initialSyncState, "pending", "stale worker cannot finish another generation");
  const before = workCalls;
  await runStagedInitialSync(db, 42, work);
  assert.equal(workCalls, before, "mismatched stored credentials never run");
  shop.protractor.connectionGeneration = binding;
  assert.equal((await route.DELETE(req())).status, 200);
  await runStagedInitialSync(db, 42, work);
  assert.equal(workCalls, before, "queued work cannot restart a disconnected shop");
  assert.equal(shop.protractorConnectionId, undefined, "disconnect removes credentials");
  assert.equal(shop.protractor.connectionGeneration, binding, "disconnect preserves data binding");
  assert.equal((await route.POST(req({ connectionId: "replacement", apiKey: "key" }))).status, 409);
  assert.equal((await route.POST(req())).status, 200, "same binding can reconnect without purge");
  delete shop.protractorBackfillComplete;
  (cursor as any).completed = false;
  await runStagedInitialSync(db, 42, async () => {
    await writeProtractorCheckpoint(42, { set: { currentChunkEnd: "before-disconnect" } });
    await withInitialSyncCheckpointFence(42, async () => {
      assert.equal((await route.DELETE(req())).status, 409, "disconnect cannot overlap an in-flight canonical checkpoint write");
    });
    assert.equal(shop.protractor.checkpointWriteToken, undefined, "checkpoint mutex released");
    assert.equal((await route.DELETE(req())).status, 200);
    assert.equal((await route.POST(req())).status, 200, "same binding may reconnect while old chunk is finishing");
    const currentState = shop.protractor.initialSyncState;
    await assert.rejects(() => writeProtractorCheckpoint(42, { set: { completed: true, currentChunkEnd: "stale" } }));
    await assert.rejects(() => markProtractorBackfillComplete(db, 42));
    assert.equal(cursor.currentChunkEnd, "before-disconnect");
    assert.equal(cursor.completed, false);
    assert.equal(shop.protractorBackfillComplete, undefined);
    assert.equal(shop.protractor.initialSyncState, currentState);
    return result(true);
  });
  assert.notEqual(shop.protractor.initialSyncState, "complete", "old chunk cannot finish a disconnected/reconnected configuration");
  console.log("Protractor onboarding routes and staged worker offline coverage passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
// Keep mocks for process lifetime: never restore live dependencies while an
// assertion failure might leave an asynchronous continuation outstanding.