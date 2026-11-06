import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { refreshActiveRepairOrders } from "../lib/integrations/tekmetric/active-sync";
import { recoverPendingContexts } from "../lib/integrations/tekmetric/context-recovery";
import { writePolledSnapshot } from "../lib/integrations/tekmetric/snapshot-write";
import { tekmetricDashboardMatch, explainVisibility } from "../lib/integrations/tekmetric/visibility";
import Module from "node:module";
import { NextRequest } from "next/server";
import { canonicalTerminalStatus, absentReconciliationCandidates } from "../lib/integrations/tekmetric/terminal-reconciliation";

test("code-first terminal responses and bounded absent selection", () => {
  for (const status of ["POSTED", "Posted", "posted", "INVOICE", "INVOICED", "DELETED", "VOID", "CLOSED"]) {
    assert.ok(canonicalTerminalStatus(status), status);
  }
  for (const status of [null, undefined, "", "COMPLETE", "Completed", "WORK_IN_PROGRESS", "ESTIMATE"]) {
    assert.equal(canonicalTerminalStatus(status), null);
  }
  const cached = Array.from({ length: 80 }, (_, i) => ({ workOrderId: i + 1 }));
  const active = new Set(cached.slice(0, 60).map(row => String(row.workOrderId)));
  assert.deepEqual(absentReconciliationCandidates(cached, active, true), cached.slice(60));
  assert.deepEqual(absentReconciliationCandidates(cached, active, false), []);
  assert.equal(absentReconciliationCandidates(cached, new Set(), true).length, 50);
});

test("active sync and recovery with real isolated Mongo", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tek-visibility-"));
  const daemon = spawn("mongod", ["--dbpath", directory, "--bind_ip", "127.0.0.1", "--port", "27939", "--quiet"], { stdio: "ignore" });
  const client = new MongoClient("mongodb://127.0.0.1:27939/visibility", { serverSelectionTimeoutMS: 300 });
  try {
    for (let i = 0; ; i++) {
      try { await client.connect(); break; } catch (e) {
        if (i > 25) throw e;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    const db = client.db(), col = db.collection<any>("tekmetric_work_orders");
    let session: any = { shopId: 569, role: "owner", impersonatedBy: "test-admin" };
    let providerApi: any;
    const load = (Module as any)._load;
    (Module as any)._load = function(request: string, parent: any, main: boolean) {
      if (request === "@/lib/auth" || request.endsWith("/lib/auth")) return { getSession: async () => session };
      if (request === "@/lib/mongo" || request.endsWith("/lib/mongo")) return { getDb: async () => db };
      if (request === "@/lib/integrations/tekmetric") return {
        getRepairOrders: (...args: any[]) => providerApi.getRepairOrders(...args),
        getVehicle: (...args: any[]) => providerApi.getVehicle(...args),
        getCustomer: (...args: any[]) => providerApi.getCustomer(...args),
      };
      if (request.includes("featureResolver")) return { getFeatureEntitlements: async () => ({ canUseFeature: () => false, effectiveFeatures: {} }) };
      if (request.includes("dataone-local")) return { getBatchQuickSpecs: async () => ({}) };
      if (request.includes("integrations/carfax")) return { fetchCarfaxWithCache: async () => { throw Error("No paid calls"); } };
      if (request.includes("data/repositories/autoflow-workflows")) return { getAutoflowWorkflowMapping: async () => null, InvalidAutoflowWorkflowMappingError: class extends Error {} };
      if (request.includes("vhi-webhook-trigger")) return { triggerVhiOnWorkOrderCreate: async () => {}, triggerVhiOnWorkOrderClose: async () => {} };
      if (request.includes("integrations/core/normalized-ingestion")) return { NormalizedIngestionService: class {
        async ingestWorkOrderBatchWithAllEntities() { throw Error("NIS deliberately excluded from legacy-dashboard test"); }
      } };
      return load.call(this, request, parent, main);
    };
    const dashboard = require("../app/api/dashboard/data/route");
    const manual = require("../app/api/tekmetric/sync/route");
    const webhook = require("../app/api/webhooks/tekmetric/route");
    const { __deps } = require("../app/api/webhooks/tekmetric/deps");
    const deferred: (() => Promise<void>)[] = [];
    __deps.getDb = async () => db;
    __deps.defer = (work: () => Promise<void>) => deferred.push(work);
    __deps.insertWebhookLog = async () => {};
    __deps.recordDviEvidence = async () => {};
    (Module as any)._load = load;
    await db.collection("shops").insertMany([
      { shopId: 569, tekmetric: { shopId: 9637, configured: true } },
      { shopId: 570, preferences: {} },
    ]);
    const dashboardRead = async () => {
      const response = await dashboard.GET(new NextRequest("http://localhost/api/dashboard/data"));
      assert.equal(response.status, 200);
      return response.json();
    };
    const ro = (id: number) => ({ id, shopId: 9637, repairOrderNumber: id, vehicleId: 10,
      customerId: 20, milesIn: 12000, updatedDate: "2026-11-06T10:00:00Z",
      repairOrderStatus: { name: "Work-In-Progress" } });
    let vehicleCalls = 0, customerCalls = 0;
    const api = {
      getRepairOrders: async (_s: number, options: any) => {
        assert.deepEqual(options.repairOrderStatusId, [1, 2, 3, 4]);
        return { content: [ro(1), ro(2)], last: true };
      },
      getVehicle: async () => { vehicleCalls++; return { shopId: 9637, vin: "TESTVIN", year: 2020, make: "Test", model: "Car" }; },
      getCustomer: async () => { customerCalls++; return { firstName: "Test" }; },
    };
    const receivedAt = Date.now();
    providerApi = api;
    const result = await refreshActiveRepairOrders(db, 569, 9637, api);
    assert.equal(result.imported, 2); assert.equal(result.partial, false);
    assert.equal(vehicleCalls, 1); assert.equal(customerCalls, 1);
    assert.equal(await col.countDocuments(tekmetricDashboardMatch(569)), 2);
    assert.equal((await dashboardRead()).pagination.totalCount, 2);
    console.log(`sync receipt-to-visible snapshot latency: ${Date.now() - receivedAt}ms`);
    assert.equal(await col.countDocuments(tekmetricDashboardMatch(570)), 0);
    assert.equal(await col.countDocuments(tekmetricDashboardMatch(569, ["Waiting"])), 0);
    const cap = await refreshActiveRepairOrders(db, 569, 9637, {
      ...api, getRepairOrders: async () => ({ content: [], last: false }),
    }, { maxPages: 2 });
    assert.equal(cap.listingComplete, false);
    assert.equal(await col.countDocuments(tekmetricDashboardMatch(569)), 2);
    const failure = await refreshActiveRepairOrders(db, 569, 9637, {
      ...api, getRepairOrders: async () => { throw Error("offline"); },
    });
    assert.equal(failure.partial, true);
    const started = new Date(Date.now() - 1000);
    await col.updateOne({ workOrderId: "1" }, { $set: { status: "Posted", fetchedAt: new Date() } });
    assert.equal(await writePolledSnapshot(db, 569, "1", started, { status: "Estimate" }), false);
    assert.equal((await col.findOne({ workOrderId: "1" })).status, "Posted");
    // Code-first terminal detail evidence removes an active row under the
    // same guarded snapshot writer used by legacy reconciliation.
    await col.insertOne({ shopId: 569, workOrderId: "88", workOrderNumber: 88,
      vin: "TERMINALVIN", odometer: 100, status: "Estimate" });
    assert.equal(await writePolledSnapshot(db, 569, 88, new Date(), {
      status: canonicalTerminalStatus("POSTED"), closedAt: new Date(),
    }), true);
    assert.equal((await dashboardRead()).rows.some((r: any) => r.displayRo === 88), false);
    const missing = await refreshActiveRepairOrders(db, 569, 9637, {
      ...api, getRepairOrders: async () => ({ content: [{ ...ro(3), milesIn: 0 }], last: true }),
      getVehicle: async () => { throw Error("transient"); },
    });
    assert.equal(missing.incomplete, 1);
    assert.equal(explainVisibility(await col.findOne({ workOrderId: "3" })), "awaiting_recovery");
    await new Promise(r => setTimeout(r, 5));
    assert.equal(await recoverPendingContexts(db, 569, 9637, {
      ...api, getRepairOrder: async () => ro(3),
    }), 1);
    assert.equal(explainVisibility(await col.findOne({ workOrderId: "3" })), "eligible_snapshot");
    assert.equal(explainVisibility({ status: "Estimate", vin: "X" }), "missing_mileage_fallback_unknown");
    assert.equal(explainVisibility({ status: "Estimate", vin: "X" }, { showOnlyWithMileage: false }), "eligible_snapshot");
    assert.equal(explainVisibility({ status: "Posted", vin: "X", odometer: 3 }), "terminal");
    assert.equal(explainVisibility(null), "not_received");
    await new Promise(r => setTimeout(r, 5));
    await refreshActiveRepairOrders(db, 569, 9637, {
      ...api, getRepairOrders: async () => ({ content: [{ ...ro(3), milesIn: 0 }], last: true }),
      getVehicle: async () => { throw Error("transient"); },
    });
    assert.equal((await col.findOne({ workOrderId: "3" })).odometer, 12000);
    assert.equal((await col.findOne({ workOrderId: "3" })).vin, "TESTVIN");
    assert.equal((await dashboardRead()).pagination.totalCount, 2); // terminal 1 excluded
    await db.collection("shops").updateOne({ shopId: 569 }, { $set: { "preferences.tekmetricLabels": ["Waiting"] } });
    assert.equal((await dashboardRead()).pagination.totalCount, 0);
    await db.collection("shops").updateOne({ shopId: 569 }, { $unset: { "preferences.tekmetricLabels": "" } });
    session = null;
    assert.equal((await manual.POST(new NextRequest("http://localhost/api/tekmetric/sync", { method: "POST" }))).status, 401);
    session = { shopId: 570, role: "owner" };
    assert.equal((await manual.POST(new NextRequest("http://localhost/api/tekmetric/sync", { method: "POST", body: JSON.stringify({ shopId: 569 }) }))).status, 400);
    session = { shopId: 569, role: "owner", impersonatedBy: "test-admin" };
    providerApi = { ...api, getRepairOrders: async (shop: number) => {
      assert.equal(shop, 9637); throw Error("partial provider outage");
    } };
    const syncResponse = await manual.POST(new NextRequest("http://localhost/api/tekmetric/sync", { method: "POST" }));
    const feedback = await syncResponse.json();
    assert.equal(feedback.shopId, 569); assert.equal(feedback.partial, true);
    assert.equal(feedback.success, false);
    providerApi = api;
    const webhookAt = Date.now();
    const wh = await webhook.POST(new NextRequest("http://localhost/api/webhooks/tekmetric", {
      method: "POST", headers: { "x-webhook-forward": "true" },
      body: JSON.stringify({ event: "RepairOrder.Updated", data: { repairOrder: ro(5) } }),
    }));
    assert.equal(wh.status, 200);
    assert.equal((await dashboardRead()).rows.some((r: any) => r.displayRo === 5), false);
    for (const work of deferred.splice(0)) await work();
    assert.equal((await dashboardRead()).rows.some((r: any) => r.displayRo === 5), true);
    console.log(`webhook receipt-to-dashboard visibility: ${Date.now() - webhookAt}ms`);
    // A sparse poll cannot erase the detail captured by a webhook. [] is,
    // however, an authoritative removal and must not resurrect old jobs.
    await col.updateOne({ workOrderId: "5" }, { $set: {
      "data.jobs": [{ id: 80, name: "Oil service", parts: [{ id: 90, quantity: 1, dotNumbers: ["001"] }] }],
      "data.customerConcerns": ["noise"], fetchedAt: new Date(Date.now() - 5000),
      updatedAt: new Date(Date.now() - 5000),
    } });
    const sparseRefresh = await refreshActiveRepairOrders(db, 569, 9637, {
      ...api, getRepairOrders: async () => ({ content: [ro(5)], last: true }),
    });
    assert.equal(sparseRefresh.imported, 1);
    assert.equal((await col.findOne({ workOrderId: "5" })).data.jobs[0].name, "Oil service");
    assert.deepEqual((await col.findOne({ workOrderId: "5" })).data.customerConcerns, ["noise"]);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(await writePolledSnapshot(db, 569, 5, new Date(), {
      tekmetricShopId: 9637, data: { ...ro(5), jobs: [] }, updatedDate: ro(5).updatedDate,
    }), true);
    assert.deepEqual((await col.findOne({ workOrderId: "5" })).data.jobs, []);
    // Older sync versions populated only MOS shopId (including numeric RO ids).
    // Webhooks must adopt that scoped row instead of inserting a duplicate.
    await col.insertMany([
      { shopId: 569, workOrderId: 6, workOrderNumber: 6, vin: "LEGACYVIN", odometer: 45000, status: "Estimate" },
      { shopId: 570, workOrderId: 6, workOrderNumber: 6, vin: "OTHERTENANT", status: "Estimate" },
    ]);
    const legacyResponse = await webhook.POST(new NextRequest("http://localhost/api/webhooks/tekmetric", {
      method: "POST", headers: { "x-webhook-forward": "true" },
      body: JSON.stringify({ event: "RepairOrder.Updated", data: { repairOrder: ro(6) } }),
    }));
    assert.equal(legacyResponse.status, 200);
    assert.equal(await col.countDocuments({ shopId: { $in: [569, "569"] }, workOrderNumber: 6 }), 1);
    assert.equal((await col.findOne({ shopId: "569", workOrderId: "6" })).vin, "LEGACYVIN");
    assert.equal((await col.findOne({ shopId: 570, workOrderId: 6 })).tekmetricShopId, undefined);
    assert.equal((await dashboardRead()).rows.filter((r: any) => r.displayRo === 6).length, 1);
    deferred.splice(0);
  } finally {
    await client.close(); daemon.kill("SIGTERM");
    await new Promise<void>(resolve => daemon.once("exit", () => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
