import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";
import { changeStickerSupply, readStickerSupply, recordStickerActivity, supplyConfiguration, validatePrintIntent, stickerActivityDeps } from "../lib/sticker-activity";
import { stickerOutreach } from "../lib/sticker-outreach";
import { resolveFeatureEntitlementsSnapshot, buildFeatures } from "../lib/featureResolver";
import * as queue from "../lib/print-queue/repository";
import { stickerSupplyDeps } from "../lib/sticker-supply-deps";
import { stickerGenerateDeps } from "../lib/sticker-generate-deps";
import { NextRequest } from "next/server";
import { GET as supplyGET, POST as supplyPOST } from "../app/api/sticker/supply/route";
import { POST as generatePOST } from "../app/api/sticker/generate/route";

// Never import environment database configuration into the fixture connection.
const port = 27864;
let client: MongoClient, daemon: ChildProcess, directory: string;
let sequence = 0;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "sticker-activity-"));
  daemon = spawn("mongod", ["--dbpath", directory, "--bind_ip", "127.0.0.1", "--port", String(port),
    "--replSet", "sticker_test", "--oplogSize", "32", "--quiet"], { stdio: "ignore" });
  let started = false;
  for (let n = 0; n < 100; n++) {
    const bootstrap = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 200 });
    try {
      await bootstrap.connect();
      await bootstrap.db("admin").command({ replSetInitiate: { _id: "sticker_test", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
      started = true;
    } catch { await new Promise(r => setTimeout(r, 100)); }
    finally { await bootstrap.close(); }
    if (started) break;
  }
  assert.ok(started, "isolated replica set starts");
  client = new MongoClient(`mongodb://127.0.0.1:${port}/?replicaSet=sticker_test&directConnection=true`, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  stickerActivityDeps.startSession = async () => client.startSession();
  for (let n = 0; n < 100; n++) {
    if ((await client.db("admin").command({ hello: 1 })).isWritablePrimary) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Isolated replica set did not elect a primary");
});
after(async () => {
  await client?.close();
  if (daemon && daemon.exitCode === null) {
    const ended = new Promise(r => daemon.once("exit", r));
    daemon.kill("SIGTERM"); await ended;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const db = client.db(`stickers_${++sequence}`);
  await db.createCollection("sticker_generations");
  await db.createCollection("sticker_supply");
  return db;
}

test("normal/fallback/retry concurrency counts once, deliberate reprint separately; legacy intact", async () => {
  const db = await fixture();
  await db.collection("sticker_generations").insertOne({ shopId: "1", generatedAt: new Date(0) });
  await changeStickerSupply(db, 1, { operation: "configure", revision: null, enabled: true, capacity: 200 });
  const action = randomUUID();
  await Promise.all(Array.from({ length: 20 }, () => recordStickerActivity(db, 1, action, "handoff")));
  assert.equal(await db.collection("sticker_generations").countDocuments(), 2);
  assert.equal((await readStickerSupply(db, 1))?.used, 1);
  await recordStickerActivity(db, 1, randomUUID(), "handoff");
  await recordStickerActivity(db, 1, undefined, "legacy-generation");
  assert.equal((await readStickerSupply(db, 1))?.used, 2);
  assert.equal(await db.collection("sticker_generations").countDocuments(), 4);
  await recordStickerActivity(db, 2, action, "handoff");
  assert.equal(await db.collection("sticker_generations").countDocuments({ shopId: 2 }), 1);
});

test("capacity default is 95 percent; explicit initialization, reset CAS, warning re-arms", async () => {
  const db = await fixture();
  await recordStickerActivity(db, 1, randomUUID(), "handoff");
  await changeStickerSupply(db, 1, { operation: "configure", revision: null, enabled: true, capacity: 2, threshold: 1 });
  assert.equal((await readStickerSupply(db, 1))?.used, 0);
  const action = randomUUID();
  await recordStickerActivity(db, 1, action, "handoff");
  let supply = (await readStickerSupply(db, 1))!;
  assert.equal(supply.low, true);
  const resets = await Promise.all([1, 2].map(() => changeStickerSupply(db, 1, { operation: "reset", revision: supply.revision })));
  assert.deepEqual(resets.sort(), [false, true]);
  await recordStickerActivity(db, 1, action, "handoff");
  supply = (await readStickerSupply(db, 1))!;
  assert.equal(supply.used, 0);
  assert.equal(supply.low, false);
  await recordStickerActivity(db, 1, randomUUID(), "handoff");
  assert.equal((await readStickerSupply(db, 1))?.low, true);
  assert.equal(await changeStickerSupply(db, 2, { operation: "reset", revision: supply.revision }), false);
  assert.equal(supplyConfiguration({ enabled: true, capacity: 200 }).threshold, 190);
  for (const capacity of [0, -1, 2.5, "200", 100001, NaN]) assert.throws(() => supplyConfiguration({ enabled: true, capacity }));
  for (const threshold of [0, 201, 1.1, "95"]) assert.throws(() => supplyConfiguration({ enabled: true, capacity: 200, threshold }));
});

test("increment/reset serialize, configuration edits do not erase consumption", async () => {
  const db = await fixture();
  await changeStickerSupply(db, 1, { operation: "configure", revision: null, enabled: true, capacity: 200 });
  const revision = (await readStickerSupply(db, 1))!.revision;
  await Promise.all([
    changeStickerSupply(db, 1, { operation: "reset", revision }),
    ...Array.from({ length: 12 }, () => recordStickerActivity(db, 1, randomUUID(), "handoff")),
  ]);
  const supply = (await readStickerSupply(db, 1))!;
  assert.ok(supply.used >= 0 && supply.used <= 12);
  assert.equal(await db.collection("sticker_generations").countDocuments(), 12);
  await changeStickerSupply(db, 1, { operation: "configure", revision: supply.revision, enabled: true, capacity: 500 });
  assert.equal((await readStickerSupply(db, 1))?.used, supply.used);
});

test("queue enqueue retries and duplicate terminal ACK consume one label; failures and foreign ACK do not", async () => {
  const db = await fixture();
  queue.__deps.getDb = async () => db;
  await changeStickerSupply(db, 1, { operation: "configure", revision: null, enabled: true, capacity: 200 });
  const input = { shopId: 1, imageBase64: "offline", kind: "sticker" as const, printActionId: randomUUID() };
  const ids = await Promise.all(Array.from({ length: 5 }, () => queue.enqueuePrintJob(input)));
  assert.equal(new Set(ids).size, 1);
  assert.equal((await readStickerSupply(db, 1))?.used, 0);
  assert.equal(await queue.ackJob(2, ids[0], "success"), "not_found");
  await Promise.all(Array.from({ length: 6 }, () => queue.ackJob(1, ids[0], "success")));
  assert.equal((await readStickerSupply(db, 1))?.used, 1);
  const failed = await queue.enqueuePrintJob({ ...input, printActionId: randomUUID() });
  await queue.ackJob(1, failed, "failure");
  await queue.ackJob(1, failed, "success");
  assert.equal((await readStickerSupply(db, 1))?.used, 1);
  await assert.rejects(queue.enqueuePrintJob({ ...input, printActionId: "bad" }));
});

test("outreach exact elapsed boundaries, missing evidence, cancellation and eligibility", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const week = 7 * 86400000;
  const shop = { createdAt: new Date(now - week), enabledFeatures: { oil_sticker: true } };
  assert.equal(stickerOutreach(shop, null, true, now, true).inactive, true);
  assert.equal(stickerOutreach(shop, null, true, now - 1, true).inactive, false);
  assert.equal(stickerOutreach(shop, null, true, now).state, "never-recorded");
  assert.equal(stickerOutreach({}, null, true, now).state, "unknown");
  assert.equal(stickerOutreach(shop, { count: 1 }, true, now, true).inactive, false);
  assert.equal(stickerOutreach(shop, null, false, now, true).inactive, false);
  assert.equal(stickerOutreach({ ...shop, billing: { status: "canceled" } }, null, true, now, true).inactive, false);
  assert.equal(stickerOutreach({ ...shop, enabledFeatures: {} }, null, true, now).inactive, false);
  assert.equal(stickerOutreach(shop, { lastAt: new Date(now) }, true, now, true).inactive, false);
  assert.equal(stickerOutreach(shop, { lastAt: new Date(now - week) }, true, now).evidence, "legacy-generation");
});

test("outreach uses the same plan, enterprise, paid-addon and billing authority as printing", () => {
  const base: any = { shopId: 1, createdAt: new Date(0), billing: { plan: "professional", status: "active" } };
  const plan = buildFeatures(["oil_sticker"]);
  const inactive = (shop: any, enterprise = {}, features = plan, metadata: any = null) =>
    stickerOutreach(shop, null, true, Date.now(),
      resolveFeatureEntitlementsSnapshot(shop, enterprise, features, metadata).canUseFeature("oil_sticker")).inactive;
  assert.equal(inactive(base), true, "inherited plan grant without shop override");
  assert.equal(inactive({ ...base, billing: { ...base.billing, paymentType: "invoice" } },
    { oil_sticker: true }, buildFeatures([])), true, "enterprise invoice contract");
  assert.equal(inactive({ ...base, enabledFeatures: { oil_sticker: true }, billing: { ...base.billing, status: "suspended" } }),
    false, "raw override does not defeat billing");
  assert.equal(inactive({ ...base, enabledFeatures: { oil_sticker: false } }), false);
  assert.equal(inactive({ ...base, billing: { plan: "trial", status: "suspended" } }, {}, buildFeatures([]),
    { subscriptions: [{ featureId: "oil_sticker", status: "active", stripeSubscriptionId: "fixture-sub" }] }),
    true, "paid standalone addon");
});

test("queue duplicate-key race recovers only the existing shop-scoped identity", async () => {
  const original = queue.__deps.getDb;
  let found: any = { shopId: 1 };
  const col = {
    updateOne: async () => { throw Object.assign(new Error("race"), { code: 11000 }); },
    findOne: async (filter: any) => { assert.equal(filter.shopId, 1); return found; },
  };
  queue.__deps.getDb = async () => ({ collection: () => col }) as any;
  try {
    assert.match(await queue.enqueuePrintJob({ shopId: 1, imageBase64: "fixture", kind: "sticker", printActionId: randomUUID() }), /^[0-9a-f]{24}$/);
    found = null;
    await assert.rejects(queue.enqueuePrintJob({ shopId: 1, imageBase64: "fixture", kind: "sticker", printActionId: randomUUID() }));
  } finally { queue.__deps.getDb = original; }
});

test("explicit print IDs required, preview/queue intent allowed, malformed identity rejected", () => {
  assert.equal(validatePrintIntent({ printIntent: "print" }), false);
  assert.equal(validatePrintIntent({ printIntent: "print", printActionId: randomUUID() }), true);
  assert.equal(validatePrintIntent({ printIntent: "sample" }), true);
  assert.equal(validatePrintIntent({ printIntent: "queue" }), true);
  assert.equal(validatePrintIntent({}), true);
  assert.equal(validatePrintIntent({ printActionId: "../../../bad" }), false);
});

test("supply routes enforce roles, entitlement, and session-owned shop rather than body shop", async () => {
  const db = await fixture();
  const originals = { ...stickerSupplyDeps };
  let session: any = null;
  stickerSupplyDeps.getSession = async () => session;
  stickerSupplyDeps.getDb = async () => db;
  stickerSupplyDeps.checkShopFeatureGate = async () => null;
  const request = (body: any) => new NextRequest("http://fixture/api/sticker/supply", { method: "POST", body: JSON.stringify(body) });
  const input = { operation: "configure", enabled: true, capacity: 200, revision: null, shopId: 999 };
  try {
    assert.equal((await supplyGET()).status, 401);
    session = { shopId: 1, role: "technician" };
    assert.equal((await supplyPOST(request(input))).status, 403);
    session.role = "owner";
    assert.equal((await supplyPOST(request(input))).status, 200);
    assert.equal((await readStickerSupply(db, 1))?.capacity, 200);
    assert.equal(await readStickerSupply(db, 999), null);
    assert.equal((await supplyPOST(request(input))).status, 409);
    const state = (await readStickerSupply(db, 1))!;
    session = { shopId: 2, role: "admin" };
    assert.equal((await supplyPOST(request({ operation: "reset", revision: state.revision, shopId: 1 }))).status, 409);
    stickerSupplyDeps.checkShopFeatureGate = async () => new Response("Forbidden", { status: 403 }) as any;
    assert.equal((await supplyPOST(request(input))).status, 403);
  } finally {
    Object.assign(stickerSupplyDeps, originals);
  }
});

test("actual rendering route excludes samples, failed PNG/PDF and queue preparation; fallback retries dedupe", async () => {
  const db = await fixture();
  await db.collection("shops").insertOne({ shopId: 1, stickerConfig: {} });
  const original = { ...stickerGenerateDeps };
  stickerGenerateDeps.getSession = async () => ({ token: "fixture", shopId: 1, email: "fixture@example.invalid", role: "owner" });
  stickerGenerateDeps.getDb = async () => db;
  stickerGenerateDeps.renderStickerStandard = async () => Buffer.from("fixture-png");
  stickerGenerateDeps.pngBufferToSizedPdfBuffer = async () => Buffer.from("fixture-pdf");
  const action = randomUUID();
  const request = (extra: any) => new NextRequest("http://fixture/api/sticker/generate", {
    method: "POST", body: JSON.stringify({ currentMileage: 1000, nextServiceMileage: 6000, includeQR: false, printActionId: action, ...extra }),
  });
  try {
    for (const printIntent of ["sample", "queue"]) {
      assert.equal((await generatePOST(request({ printIntent }))).status, 200);
    }
    assert.equal(await db.collection("sticker_generations").countDocuments(), 0);
    stickerGenerateDeps.renderStickerStandard = async () => { throw new Error("fixture render failure"); };
    assert.equal((await generatePOST(request({ printIntent: "print" }))).status, 500);
    stickerGenerateDeps.renderStickerStandard = async () => Buffer.from("fixture-png");
    stickerGenerateDeps.pngBufferToSizedPdfBuffer = async () => { throw new Error("fixture PDF failure"); };
    assert.equal((await generatePOST(request({ printIntent: "print", format: "pdf" }))).status, 500);
    assert.equal(await db.collection("sticker_generations").countDocuments(), 0);
    stickerGenerateDeps.pngBufferToSizedPdfBuffer = async () => Buffer.from("fixture-pdf");
    assert.equal((await generatePOST(request({ printIntent: "print" }))).status, 200);
    assert.equal((await generatePOST(request({ printIntent: "print", format: "pdf" }))).status, 200);
    assert.equal(await db.collection("sticker_generations").countDocuments(), 1);
    assert.equal((await generatePOST(request({ printIntent: "print", printActionId: randomUUID() }))).status, 200);
    assert.equal(await db.collection("sticker_generations").countDocuments(), 2);
  } finally {
    Object.assign(stickerGenerateDeps, original);
  }
});
