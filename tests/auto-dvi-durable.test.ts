import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Module from "node:module";
import { MongoClient, type Db } from "mongodb";
import { MongoDviStore, DURABLE_COLLECTION } from "../lib/data/repositories/auto-dvi-durable";
import { Repository, type Store, type Transaction } from "../lib/auto-dvi/durable/repository";
import { DurablePushService } from "../lib/auto-dvi/durable/service";
import { canonical, classify, digest, DurableError, parseRequest, type Operation } from "../lib/auto-dvi/durable/model";
import { body, scope, target, guid, resetProvider, FixtureProvider, fixtureService } from "./helpers/dvi-durable-fixture";

// Actual isolated replica set; no application Mongo module or environment URI is
// imported. All network outside loopback is denied by the runner preload.
const port = 27791;
let client: MongoClient, daemon: ChildProcess, directory: string;
let sequence = 0;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "dvi-durable-"));
  daemon = spawn("mongod", ["--dbpath", directory, "--bind_ip", "127.0.0.1", "--port", String(port),
    "--replSet", "dvi_test", "--oplogSize", "32", "--quiet"], {stdio: "ignore"});
  let started = false;
  for (let n = 0; n < 80; n++) {
    try {
      const bootstrap = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {serverSelectionTimeoutMS: 200});
      try {
        await bootstrap.connect();
        await bootstrap.db("admin").command({replSetInitiate: {_id: "dvi_test", members: [{_id: 0, host: `127.0.0.1:${port}`}]}});
        started = true;
      } finally { await bootstrap.close(); }
      if (started) break;
    } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(started, "isolated replica set must start");
  client = new MongoClient(`mongodb://127.0.0.1:${port}/?replicaSet=dvi_test&directConnection=true`, {serverSelectionTimeoutMS: 10000});
  await client.connect();
  for (let n = 0; n < 100; n++) {
    if ((await client.db("admin").command({hello: 1})).isWritablePrimary) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error("fixture replica set not writable");
});
after(async () => {
  await client?.close();
  if (daemon && daemon.exitCode === null) {
    const ended = new Promise(r => daemon.once("exit", r));
    daemon.kill("SIGTERM"); await ended;
  }
  if (directory) await rm(directory, {recursive: true, force: true});
});
async function fixture() {
  const db = client.db(`dvi_test_${++sequence}`);
  await db.createCollection(DURABLE_COLLECTION);
  await db.createCollection("auto_dvi_applications");
  await resetProvider(db);
  const store = new MongoDviStore(client, db);
  await store.ready();
  return {db, store, repo: new Repository(store), service: fixtureService(store, db)};
}
const calls = async (db: Db) => (await db.collection("fixture_provider").findOne({_id: "wo"} as any))!.writes;
const storedOp = async (db: Db) => (await db.collection(DURABLE_COLLECTION).findOne({_id: /^operation:/} as any))!.value as Operation;
const mode = (db: Db, value: string) => db.collection("fixture_provider").updateOne({_id: "wo"} as any, {$set: {mode: value}});
test("target discovery after a lost reply is read-only, actor/shop scoped and survives admission rollback", async () => {
  const f = await fixture();
  const {request} = parseRequest(body);
  assert.equal(await f.service.discover(scope, request), null);
  await mode(f.db, "absent-packages");
  await f.service.push(scope, body); // caller loses this response
  const writesBefore = await calls(f.db);
  const rolledBack = new DurablePushService({
    repository: f.repo, provider: new FixtureProvider(f.db), admissions: false, price: async () => {throw Error("must not price");},
  });
  const discovered = await rolledBack.discover(scope, request);
  assert.equal(discovered?.body.operationId, (await storedOp(f.db)).id);
  assert.equal(discovered?.body.outcome, "uncertain");
  await assert.rejects(rolledBack.discover({...scope, actor: "other@example.invalid"}, request), /TARGET_UNRESOLVED/);
  await assert.rejects(rolledBack.discover({...scope, shopId: 2}, request), /TARGET_CHANGED/);
  await assert.rejects(rolledBack.discover(scope, {...request, vin: "1HGCM82633A004353"}), /TARGET_CHANGED/);
  assert.deepEqual(await calls(f.db), writesBefore);
});
function child(db: Db, mode: string) {
  return new Promise<number | null>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "tests/helpers/dvi-durable-child.ts", String(port), db.databaseName, mode],
      {stdio: "ignore"});
    proc.once("error", reject); proc.once("exit", resolve);
  });
}
class FaultStore implements Store {
  armed = true;
  constructor(private store: Store, private match: (key: string, value: any) => boolean, private afterCommit: boolean) {}
  read<T>(key: string) { return this.store.read<T>(key); }
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    let trip = false;
    const result = await this.store.transaction(tx => fn({
      get: tx.get,
      put: async (key, value) => {
        if (this.armed && this.match(key, value)) {
          this.armed = false; trip = true;
          if (!this.afterCommit) throw Error("fixture commit failed");
        }
        await tx.put(key, value);
      },
    }));
    if (trip) throw Error("fixture commit reply lost");
    return result;
  }
}
function serviceFor(store: Store, db: Db) {
  return new DurablePushService({repository: new Repository(store), provider: new FixtureProvider(db), admissions: true,
    price: async () => [{title: "Service", hours: 1, rate: 100}, {title: "Service", hours: 2, rate: 150}]});
}
test("canonical request validates every field and preserves repeated selections and text", () => {
  assert.equal(canonical({b: 1, a: [2, 1]}), '{"a":[2,1],"b":1}');
  for (const change of [{items: [{name: "Battery", rating: "bad"}]}, {recover: true},
    {items: [{name: "Battery", dueAtMiles: Infinity}]}, {items: [{name: "Battery"}, {}]},
    {recommendedItems: new Array(101).fill({name: "Service"})}]) {
    assert.throws(() => parseRequest({...body, ...change}), DurableError);
  }
  assert.equal(parseRequest(body).request.recommendedItems.length, 2);
  assert.notEqual(digest(parseRequest(body).request), digest(parseRequest({...body, items: [{name: "Battery", notes: " Test"}]}).request));
});
test("network egress outside the isolated replica set is denied", async () => {
  await assert.rejects(fetch("https://example.invalid"), /Network egress denied/);
});
test("simultaneous distinct request keys cannot reserve the same target", async () => {
  const f = await fixture(); await mode(f.db, "absent-packages");
  const results = await Promise.allSettled([
    f.service.push(scope, body),
    serviceFor(f.store, f.db).push({...scope, actor: "other"}, {...body, clientRequestId: "other-key-123"}),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "TARGET_UNRESOLVED");
  assert.equal(await f.db.collection(DURABLE_COLLECTION).countDocuments({_id: /^operation:/} as any), 1);
});
test("unavailable reads, closed targets and corrupted frozen plans never authorize writes", async () => {
  for (const field of ["open", "complete"]) {
    const f = await fixture();
    await f.db.collection("fixture_provider").updateOne({_id: "wo"} as any, {$set: {[field]: false}});
    await assert.rejects(f.service.push(scope, body), /UNVERIFIED_TARGET/);
    assert.deepEqual(await calls(f.db), []);
  }
  const f = await fixture(); await mode(f.db, "absent-packages");
  await f.service.push(scope, body);
  const op = await storedOp(f.db);
  await mode(f.db, "read-fails");
  assert.equal((await f.service.reconcile(scope, op.id)).status, 202);
  await f.db.collection(DURABLE_COLLECTION).updateOne({_id: `operation:${op.id}`} as any,
    {$set: {"value.plan.lineCount": 99}});
  await assert.rejects(f.service.reconcile(scope, op.id), /PLAN_VERSION_OR_INTEGRITY/);
  assert.deepEqual(await calls(f.db), []);
});
test("two OS processes share one durable plan, admission, receipt and outbox", async () => {
  const f = await fixture();
  assert.deepEqual(await Promise.all([child(f.db, "race"), child(f.db, "race")]), [0, 0]);
  assert.deepEqual(await calls(f.db), ["packages", "findings"]);
  assert.equal(await f.db.collection(DURABLE_COLLECTION).countDocuments({_id: /^operation:/} as any), 1);
  const op = await storedOp(f.db);
  assert.equal(op.planDigest, digest(op.plan));
  assert.equal(op.planBytes, canonical(op.plan));
  const packages = op.plan.payloads.packages!.ServicePackages.ItemCollection;
  const ids = packages.flatMap((p: any) => [p.ID, ...p.ServicePackageLines.ItemCollection.map((l: any) => l.ID)]);
  assert.equal(new Set(ids).size, ids.length, "repeated recommended titles retain distinct persisted IDs");
  assert.equal(await f.db.collection("auto_dvi_applications").countDocuments(), 1);
});
test("failed or lost plan commits never permit speculative mutation", async () => {
  for (const afterCommit of [false, true]) {
    const f = await fixture();
    const store = new FaultStore(f.store, (key) => key.startsWith("request:"), afterCommit);
    await serviceFor(store, f.db).push(scope, body).catch(() => {});
    assert.deepEqual(await calls(f.db), []);
    if (afterCommit) {
      const response = await f.service.push(scope, body);
      assert.equal(response.status, 202);
      assert.deepEqual(await calls(f.db), []);
    } else assert.equal(await f.db.collection(DURABLE_COLLECTION).countDocuments(), 0);
  }
});
test("lost admission acknowledgment leaves a durable block and zero mutation", async () => {
  const f = await fixture();
  const store = new FaultStore(f.store, (key, value) => key.startsWith("operation:") && value.stages.packages.state === "admitted", true);
  await assert.rejects(serviceFor(store, f.db).push(scope, body));
  assert.deepEqual(await calls(f.db), []);
  const op = await storedOp(f.db);
  assert.equal(op.stages.packages.state, "admitted");
  const result = await f.service.reconcile(scope, op.id);
  assert.equal(result.status, 202);
  assert.equal((await storedOp(f.db)).stages.packages.state, "uncertain");
  await assert.rejects(f.service.push(scope, {...body, clientRequestId: "replacement-1"}), /TARGET_UNRESOLVED/);
  assert.deepEqual(await calls(f.db), []);
});
test("hard process death after package or findings acceptance survives fresh client and service", async () => {
  for (const stage of ["packages", "findings"]) {
    const f = await fixture();
    assert.equal(await child(f.db, stage), 73);
    const op = await storedOp(f.db);
    assert.equal(op.stages[stage as "packages" | "findings"].state, "admitted");
    // Expire only the worker lease, NEVER the target ownership.
    await f.db.collection(DURABLE_COLLECTION).updateOne({_id: `operation:${op.id}`} as any,
      {$set: {"value.claim.until": 0}});
    const reconnect = new MongoClient(`mongodb://127.0.0.1:${port}/?replicaSet=dvi_test&directConnection=true`);
    await reconnect.connect();
    try {
      const service = fixtureService(new MongoDviStore(reconnect, reconnect.db(f.db.databaseName)), reconnect.db(f.db.databaseName));
      const result = await service.reconcile(scope, op.id);
      assert.equal(result.status, stage === "findings" ? 200 : 202);
      const restored = await storedOp(f.db);
      assert.equal(restored.stages.packages.state, "verified");
      if (stage === "packages") assert.equal(restored.stages.findings.state, "prepared");
      assert.deepEqual(await calls(f.db), stage === "packages" ? ["packages"] : ["packages", "findings"]);
    } finally { await reconnect.close(); }
  }
});
test("lost provider acknowledgments use exact-ID readback, never SOAP or another POST", async () => {
  for (const stage of ["packages", "findings"]) {
    const f = await fixture(); await mode(f.db, `lost-${stage}`);
    assert.equal((await f.service.push(scope, body)).status, 200);
    assert.deepEqual(await calls(f.db), ["packages", "findings"]);
  }
});
test("new key after success returns same receipt; keyed edits never reprice", async () => {
  const f = await fixture();
  const first = await f.service.push(scope, body);
  const service = new DurablePushService({repository: f.repo, provider: new FixtureProvider(f.db), admissions: false,
    price: async () => { throw Error("must not reprice"); }});
  assert.deepEqual(await service.push(scope, body), first);
  assert.deepEqual(await service.push(scope, {...body, clientRequestId: "new-key-123"}), first);
  for (const edit of [{items: [{name: "Battery", notes: "edited"}]}, {recommendedItems: []},
    {workOrderGuid: "22222222-2222-4222-8222-222222222222"}]) {
    await assert.rejects(service.push(scope, {...body, ...edit}), /REQUEST_CONFLICT/);
  }
  await assert.rejects(service.push(scope, {...body, clientRequestId: "new-key-123", recommendedItems: []}), /REQUEST_CONFLICT/);
  assert.deepEqual(await calls(f.db), ["packages", "findings"]);
});
test("edited or missing extra packages conflict; omitted collections are unknown", async () => {
  for (const change of ["price", "missing", "duplicate", "moved", "omitted", "rename"]) {
    const f = await fixture(); await mode(f.db, "absent-findings");
    await f.service.push(scope, body);
    const op = await storedOp(f.db);
    const row = (await f.db.collection("fixture_provider").findOne({_id: "wo"} as any))!;
    const list = row.body.ServicePackages.ItemCollection;
    if (change === "price") list[2].ServicePackageLines.ItemCollection[0].Price = "0.01";
    if (change === "missing") list.pop();
    if (change === "duplicate") list.push(structuredClone(list[1]));
    if (change === "moved") list[0].ServicePackageLines.ItemCollection.push(list[1].ServicePackageLines.ItemCollection.pop());
    if (change === "omitted") delete row.body.ServicePackages;
    if (change === "rename") list[1].ServicePackageHeader.Title = "Advisor edit";
    await f.db.collection("fixture_provider").updateOne({_id: "wo"} as any, {$set: {body: row.body}});
    const result = await f.service.reconcile(scope, op.id);
    assert.equal(result.status, change === "omitted" ? 202 : 409);
    assert.deepEqual(await calls(f.db), ["packages"]);
  }
});
test("receipt/outbox commit and activity acknowledgment losses repair locally exactly once", async () => {
  for (const prefix of ["receipt:", "activity:"]) {
    const f = await fixture();
    const store = new FaultStore(f.store, key => key.startsWith(prefix), true);
    await serviceFor(store, f.db).push(scope, body).catch(() => {});
    const op = await storedOp(f.db);
    assert.equal(op.state, "complete");
    const result = await f.service.reconcile(scope, op.id);
    assert.equal(result.status, 200);
    await f.service.reconcile(scope, op.id);
    assert.equal(await f.db.collection("auto_dvi_applications").countDocuments(), 1);
    assert.equal(await f.db.collection(DURABLE_COLLECTION).countDocuments({_id: /^receipt:/} as any), 1);
    assert.deepEqual(await calls(f.db), ["packages", "findings"]);
  }
});
test("provider verification before receipt commit survives rollback and local retry", async () => {
  const f = await fixture();
  const store = new FaultStore(f.store, key => key.startsWith("receipt:"), false);
  await assert.rejects(serviceFor(store, f.db).push(scope, body));
  const op = await storedOp(f.db);
  assert.equal(op.state, "provider_verified");
  assert.equal((await f.service.reconcile(scope, op.id)).status, 200);
  assert.deepEqual(await calls(f.db), ["packages", "findings"]);
});
test("stale fencing tokens cannot advance an operation, and a late write never enables replay", async () => {
  const f = await fixture(); await mode(f.db, "absent-packages");
  await f.service.push(scope, body);
  const op = await storedOp(f.db);
  const old = await f.repo.claim(op.id, scope);
  await f.db.collection(DURABLE_COLLECTION).updateOne({_id: `operation:${op.id}`} as any, {$set: {"value.claim.until": 0}});
  const fresh = await f.repo.claim(op.id, scope);
  assert.notEqual(old, fresh);
  await assert.rejects(f.repo.observe(op.id, old!, "packages", "desired", "fake", "1"), /STALE_WORKER/);
  await assert.rejects(f.repo.admit(op.id, fresh!, "packages", "new-attempt"), /STAGE_ALREADY_ADMITTED/);
  await f.repo.releaseClaim(op.id, fresh!);
  const row = (await f.db.collection("fixture_provider").findOne({_id: "wo"} as any))!;
  await f.db.collection("fixture_provider").updateOne({_id: "wo"} as any,
    {$set: {body: op.plan.payloads.packages, revision: row.revision + 1}});
  assert.equal((await f.service.reconcile(scope, op.id)).status, 202);
  assert.deepEqual(await calls(f.db), []);
});
test("conditional rejection, unavailable capability, wrong actor/shop and changed connection deny writes", async () => {
  const f = await fixture(); await mode(f.db, "edited-before-packages");
  assert.equal((await f.service.push(scope, body)).status, 202);
  assert.deepEqual(await calls(f.db), []);
  const op = await storedOp(f.db);
  await assert.rejects(f.service.status({...scope, actor: "other"}, op.id), /OPERATION_FORBIDDEN/);
  await assert.rejects(f.service.reconcile({...scope, shopId: 2}, op.id), /OPERATION_FORBIDDEN/);
  await f.db.collection("fixture_provider").updateOne({_id: "wo"} as any, {$set: {"target.connectionVersion": "2"}});
  await assert.rejects(f.service.reconcile(scope, op.id), /CONNECTION_CHANGED/);
  const other = await fixture();
  const provider = new FixtureProvider(other.db); provider.concurrencyVerified = false;
  const service = new DurablePushService({repository: other.repo, provider, admissions: true, price: async () => []});
  await assert.rejects(service.push(scope, body), /PROVIDER_CAPABILITY_UNVERIFIED/);
  assert.deepEqual(await calls(other.db), []);
});
test("real dashboard and extension handlers share request and target ownership across routes", async () => {
  const f = await fixture(); await mode(f.db, "absent-packages");
  const loader = Module as unknown as {_load: (id: string, ...args: any[]) => any};
  const original = loader._load;
  let actor = scope.actor, denied = false;
  loader._load = function(id, ...args) {
    if (id === "next/server") return {NextResponse: class extends Response {
      static json(value: any, init?: ResponseInit) { return Response.json(value, init); }
    }};
    if (id === "@/lib/auth") return {getSession: async () => ({shopId: 1, email: actor})};
    if (id === "@/lib/extension-route-wrapper") return {withExtensionErrorMarker: (fn: any) => fn};
    if (id === "@/lib/extension-route-guard") return {
      checkShopFeatureGate: async () => denied ? Response.json({}, {status: 403}) : null,
      guardExtensionShopRequest: async () => denied ? {ok: false, response: Response.json({}, {status: 403})} :
        {ok: true, mosShopId: 1, provider: "protractor", user: {email: actor}},
    };
    if (id === "@/lib/shop-feature-access") return {AUTO_DVI_REQUIRED_FEATURES: []};
    if (id === "@/lib/data/repositories/auto-dvi") return {isProtractorShop: async () => true};
    if (id === "@/lib/auto-dvi/recommended-work") return {buildRecommendedWorkPackages: () => {throw Error("legacy pricing forbidden");}};
    if (id === "@/lib/auto-dvi/protractor-push") return {pushInspectionPackageToProtractor: () => {throw Error("legacy write forbidden");}};
    if (id === "@/lib/extension-analytics") return {};
    if (id === "@/lib/integrations/protractor/interactive-context") return {runWithProtractorInteractiveTransport: (_: any, fn: any) => fn()};
    if (id === "@/lib/auto-dvi/durable/runtime") return {
      tryDurablePush: async (s: any, raw: any, channel: string) => {
        const request = {...raw};
        if (channel === "extension") {delete request.shopId; delete request.provider;}
        try { return await serviceFor(f.store, f.db).push(s, request); }
        catch (error) {return {status: error instanceof DurableError ? error.status : 503, body: {error: (error as Error).message}};}
      },
    };
    return original.call(this, id, ...args);
  };
  try {
    const dashboard = require("../app/api/auto-dvi/push/route");
    const extension = require("../app/api/extension/auto-dvi/push/route");
    const request = (b: any) => new Request("http://fixture.invalid/api", {method: "POST", body: JSON.stringify(b)});
    const first = await dashboard.POST(request(body));
    const duplicate = await extension.POST(request({...body, shopId: "provider-shop-not-mos", provider: "protractor"}));
    assert.equal(first.status, 202); assert.equal(duplicate.status, 202);
    assert.equal((await first.json()).operationId, (await duplicate.json()).operationId);
    const conflict = await extension.POST(request({...body, shopId: "provider-shop-not-mos", items: [{name: "Edited"}]}));
    assert.equal(conflict.status, 409);
    actor = "other@example.invalid";
    const blocked = await extension.POST(request({...body, shopId: "provider-shop-not-mos", clientRequestId: "second-device"}));
    assert.equal(blocked.status, 409);
    denied = true;
    assert.equal((await dashboard.POST(request(body))).status, 403);
    assert.equal((await extension.POST(request({...body, shopId: "external"}))).status, 403);
    assert.deepEqual(await calls(f.db), []);
    assert.equal(await f.db.collection(DURABLE_COLLECTION).countDocuments({_id: /^operation:/} as any), 1);
  } finally { loader._load = original; }
});
