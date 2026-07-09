/**
 * Task #520 regression test: a Protractor WorkOrder webhook must make the RO
 * visible in `/api/dashboard/data-v2` within the SAME request cycle.
 *
 * Background: Task #517 fixed a real shop incident (CAR Experts RO 3575/3578)
 * where the webhook only wrote `protractor_work_orders` and left
 * `normalized_work_orders` (what the dashboard reads) stale until the next
 * 2 AM cron, so the RO "disappeared" from the dashboard. The fix runs
 * `ingestWorkOrderWithAllEntities` INLINE in the webhook before bumping
 * `dashboard_updates`. That fix is invisible to anyone reading the webhook
 * code — a refactor that moves normalization back to fire-and-forget would
 * silently re-introduce the bug. This test locks the behavior in.
 *
 * The real `NormalizedIngestionService` requires Postgres (its
 * `dualWriteToSupabase` throws when the PG writer isn't initialized), so we
 * drive both routes through their `__deps` test seams against an in-memory
 * Mongo and inject a lightweight ingestion stand-in that writes the same
 * `normalized_work_orders` shape the dashboard query reads. What we are
 * actually asserting is the WIRING: that the webhook calls the ingestion
 * inline (awaited) and that the dashboard read surfaces the row.
 *
 * Cases:
 *   (1) Webhook → dashboard visibility: a brand-new RO shows up in data-v2.
 *   (2) Zero-mileage default include + `showOnlyWithMileage = true` hides it.
 *   (3) Drift backstop re-normalizes when a `protractor_work_orders` snapshot
 *       is newer than its `normalized_work_orders` counterpart.
 *
 * Run: `npx tsx tests/protractor-webhook-dashboard-visibility.smoke.ts`
 */

import { NextRequest } from "next/server";
import { makeFakeDb, type FakeDb } from "./utils/fake-mongo";
import * as webhookRoute from "../app/api/webhooks/protractor/[token]/route";
import * as dashboardRoute from "../app/api/dashboard/data-v2/route";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TOKEN = "wh_token_abc";
const SHOP_ID = 42;
const SID = "sid-test-123";

/**
 * Build a Protractor WorkOrder payload the way `fetchWorkOrderById` would
 * return it (the snapshot/raw shape the route + drift backstop consume).
 */
function makeWorkOrder(opts: {
  id: string;
  woNumber: number;
  vin: string;
  mileage?: number;
  stage?: string;
  customerName?: string;
}) {
  return {
    ID: opts.id,
    WorkOrderNumber: opts.woNumber,
    WorkflowStage: opts.stage ?? "WorkAuthorized",
    Completed: false,
    InUsage: opts.mileage ?? 0,
    CustomerName: opts.customerName ?? "Jane Tester",
    ServiceItem: {
      VIN: opts.vin,
      Odometer: opts.mileage ?? 0,
      Year: 2019,
      Make: "Toyota",
      Model: "Camry",
    },
  };
}

/**
 * Lightweight ingestion stand-in. Mirrors what the real
 * `ingestWorkOrderWithAllEntities` persists into `normalized_work_orders`
 * (keyed by provenance protractor sourceId) closely enough that the
 * dashboard active query reads it back. Idempotent upsert so the drift
 * backstop updates the existing row rather than duplicating it.
 */
function makeFakeIngestionFactory(calls: { count: number }) {
  return (
    db: any,
    _sourceSystem: string,
    shopId: number,
    _enterpriseId: string | undefined,
    _options: any,
  ) => ({
    async ingestWorkOrderWithAllEntities(sourceData: any) {
      calls.count += 1;
      const sourceId = String(
        sourceData.ID ?? sourceData.id ?? sourceData.WorkOrderNumber,
      );
      const si = sourceData.ServiceItem || {};
      const vin = String(si.VIN || si.Lookup || sourceData.VIN || "").toUpperCase();
      const mileageIn = Number(sourceData.InUsage ?? si.Odometer ?? 0) || 0;
      const mileageOut = Number(sourceData.OutUsage ?? 0) || 0;
      const col = db.collection("normalized_work_orders");
      const existing = await col.findOne({
        shopId,
        "provenance.sourceIds": {
          $elemMatch: { sourceSystem: "protractor", sourceId },
        },
      });
      const now = new Date();
      const setDoc = {
        shopId,
        vin,
        status: sourceData.WorkflowStage || "WorkAuthorized",
        mileageIn,
        mileageOut,
        sourceId,
        smsType: "protractor",
        customer: { name: sourceData.CustomerName || "Unknown Customer" },
        vehicle: {
          year: si.Year ?? null,
          make: si.Make ?? null,
          model: si.Model ?? null,
        },
        provenance: { sourceIds: [{ sourceSystem: "protractor", sourceId }] },
        updatedAt: now,
      };
      if (existing) {
        await col.updateOne({ _id: existing._id }, { $set: setDoc });
        return { workOrder: { success: true, action: "updated", entityId: existing._id } };
      }
      const _id = `nwo_${sourceId}`;
      await col.insertOne({ _id, createdAt: now, ...setDoc });
      return { workOrder: { success: true, action: "created", entityId: _id } };
    },
  });
}

function fakeCookies(sid: string | null) {
  return async () => ({
    get: (name: string) =>
      name === "sid" && sid ? { value: sid } : undefined,
  });
}

function seedWorld(extra?: Record<string, any[]>): FakeDb {
  return makeFakeDb({
    shops: [
      {
        shopId: SHOP_ID,
        name: "Test Shop",
        protractorWebhookToken: TOKEN,
        protractor: { configured: false },
        preferences: {},
      },
    ],
    sessions: [
      {
        token: SID,
        userId: "user-1",
        shopId: SHOP_ID,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ],
    users: [{ _id: "user-1", email: "advisor@test.com", role: "advisor", shopId: SHOP_ID }],
    normalized_work_orders: [],
    protractor_work_orders: [],
    events: [],
    dashboard_updates: [],
    carfax_reports: [],
    ...(extra || {}),
  });
}

function webhookReq(query: Record<string, string>, payload: any): NextRequest {
  const qs = new URLSearchParams(query).toString();
  return new NextRequest(`http://localhost/api/webhooks/protractor/${TOKEN}?${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function dashboardReq(): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/data-v2", { method: "GET" });
}

function wireWebhookDeps(fake: FakeDb, opts: { workOrder: any; calls: { count: number } }) {
  const orig = { ...webhookRoute.__deps };
  webhookRoute.__deps.getDb = async () => fake.db as any;
  webhookRoute.__deps.insertEvent = (async (doc: any) => {
    await fake.db.collection("events").insertOne(doc);
  }) as any;
  webhookRoute.__deps.fetchWorkOrderById = (async () => ({
    ok: true,
    workOrder: opts.workOrder,
  })) as any;
  webhookRoute.__deps.upsertProtractorWorkOrderSnapshot = (async (
    shopId: number,
    wo: any,
  ) => {
    await fake.db.collection("protractor_work_orders").updateOne(
      { shopId, workOrderId: String(wo.ID) },
      {
        $set: {
          shopId,
          workOrderId: String(wo.ID),
          workOrderNumber: wo.WorkOrderNumber,
          vin: wo.ServiceItem?.VIN,
          completed: false,
          fetchedAt: new Date(),
          rawPayload: wo,
        },
      },
      { upsert: true },
    );
  }) as any;
  webhookRoute.__deps.triggerVhiOnWorkOrderCreate = (async () => undefined) as any;
  webhookRoute.__deps.triggerVhiOnWorkOrderClose = (async () => undefined) as any;
  webhookRoute.__deps.createIngestionService = makeFakeIngestionFactory(opts.calls) as any;
  return () => Object.assign(webhookRoute.__deps, orig);
}

function wireDashboardDeps(
  fake: FakeDb,
  opts: { sid?: string | null; calls: { count: number } },
) {
  const orig = { ...dashboardRoute.__deps };
  dashboardRoute.__deps.getDb = async () => fake.db as any;
  dashboardRoute.__deps.cookies = fakeCookies(
    opts.sid === undefined ? SID : opts.sid,
  ) as any;
  dashboardRoute.__deps.createIngestionService = makeFakeIngestionFactory(opts.calls) as any;
  return () => Object.assign(dashboardRoute.__deps, orig);
}

async function run() {
  console.log("protractor-webhook-dashboard-visibility smoke (Task #520)");

  // -------------------------------------------------------------------------
  // (1) Webhook → dashboard visibility within the same request cycle.
  // -------------------------------------------------------------------------
  {
    const fake = seedWorld();
    const wo = makeWorkOrder({ id: "WO1001", woNumber: 1001, vin: "1HGCM82633A001001", mileage: 53000 });
    const ingestCalls = { count: 0 };
    const restoreWh = wireWebhookDeps(fake, { workOrder: wo, calls: ingestCalls });
    const dashCalls = { count: 0 };
    const restoreDash = wireDashboardDeps(fake, { calls: dashCalls });
    try {
      const whRes = await webhookRoute.POST(
        webhookReq({ type: "WorkOrder", id: "WO1001", operation: "Create" }, {}),
        { params: { token: TOKEN } },
      );
      ok("webhook returns 200", whRes.status === 200);
      ok("webhook normalized inline (ingest called exactly once)", ingestCalls.count === 1, `count=${ingestCalls.count}`);
      ok(
        "normalized_work_orders has the new RO after webhook",
        fake.collections.normalized_work_orders.some((r: any) => r.sourceId === "WO1001"),
      );

      const dashRes = await dashboardRoute.GET(dashboardReq());
      ok("dashboard returns 200", dashRes.status === 200);
      const body = await dashRes.json();
      const row = body.rows?.find((r: any) => String(r.displayRo) === "WO1001");
      ok("RO appears in dashboard rows within same request cycle", !!row, JSON.stringify(body.rows?.map((r: any) => r.displayRo)));
      ok("  → row carries the VIN", row?.displayVin === "1HGCM82633A001001");
      ok("  → row carries mileage (53000)", row?.displayMiles === 53000, `miles=${row?.displayMiles}`);
    } finally {
      restoreDash();
      restoreWh();
    }
  }

  // -------------------------------------------------------------------------
  // (2) Zero-mileage RO included by default; hidden when showOnlyWithMileage.
  // -------------------------------------------------------------------------
  {
    const fake = seedWorld();
    const wo = makeWorkOrder({ id: "WO2002", woNumber: 2002, vin: "1HGCM82633A002002", mileage: 0 });
    const ingestCalls = { count: 0 };
    const restoreWh = wireWebhookDeps(fake, { workOrder: wo, calls: ingestCalls });
    const dashCalls = { count: 0 };
    const restoreDash = wireDashboardDeps(fake, { calls: dashCalls });
    try {
      await webhookRoute.POST(
        webhookReq({ type: "WorkOrder", id: "WO2002", operation: "Create" }, {}),
        { params: { token: TOKEN } },
      );

      // Default: zero-mileage RO is included.
      const dashRes1 = await dashboardRoute.GET(dashboardReq());
      const body1 = await dashRes1.json();
      const row1 = body1.rows?.find((r: any) => String(r.displayRo) === "WO2002");
      ok("zero-mileage RO included by default", !!row1);
      ok("  → displayMiles is null for zero-mileage RO", row1?.displayMiles === null, `miles=${row1?.displayMiles}`);

      // Opt into legacy behavior: showOnlyWithMileage = true → hidden.
      const shop = fake.collections.shops.find((s: any) => s.shopId === SHOP_ID);
      shop.preferences = { showOnlyWithMileage: true };
      const dashRes2 = await dashboardRoute.GET(dashboardReq());
      const body2 = await dashRes2.json();
      const row2 = body2.rows?.find((r: any) => String(r.displayRo) === "WO2002");
      ok("showOnlyWithMileage=true hides the zero-mileage RO", !row2, JSON.stringify(body2.rows?.map((r: any) => r.displayRo)));
    } finally {
      restoreDash();
      restoreWh();
    }
  }

  // -------------------------------------------------------------------------
  // (3) Task #757: the drift backstop no longer runs on the dashboard read
  //     path. A stale normalized row (older than its protractor snapshot) is
  //     served AS-IS — no synchronous re-ingestion — so the hottest page stays
  //     fast. The cron (/api/cron/drift-reconcile) corrects the drift instead;
  //     that path is covered by tests/drift-reconcile-cron.smoke.ts.
  // -------------------------------------------------------------------------
  {
    const staleUpdatedAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min old
    const freshFetchedAt = new Date(); // now → would drift > 2 min threshold
    const driftWo = makeWorkOrder({ id: "WO3003", woNumber: 3003, vin: "1HGCM82633A003003", mileage: 71000 });

    const fake = seedWorld({
      shops: [
        {
          shopId: SHOP_ID,
          name: "Test Shop",
          protractorWebhookToken: TOKEN,
          protractor: { configured: true },
          preferences: {},
        },
      ],
      normalized_work_orders: [
        {
          _id: "nwo_WO3003",
          shopId: SHOP_ID,
          vin: "1HGCM82633A003003",
          status: "WorkAuthorized",
          mileageIn: 71000,
          mileageOut: 0,
          sourceId: "WO3003",
          smsType: "protractor",
          customer: { name: "Stale Sam" },
          vehicle: { year: 2019, make: "Toyota", model: "Camry" },
          provenance: { sourceIds: [{ sourceSystem: "protractor", sourceId: "WO3003" }] },
          createdAt: staleUpdatedAt,
          updatedAt: staleUpdatedAt,
        },
      ],
      protractor_work_orders: [
        {
          shopId: SHOP_ID,
          workOrderId: "WO3003",
          workOrderNumber: 3003,
          vin: "1HGCM82633A003003",
          completed: false,
          fetchedAt: freshFetchedAt,
          rawPayload: driftWo,
        },
      ],
    });

    const dashCalls = { count: 0 };
    const restoreDash = wireDashboardDeps(fake, { calls: dashCalls });
    try {
      const beforeRow = fake.collections.normalized_work_orders.find((r: any) => r.sourceId === "WO3003");
      const beforeUpdatedAt = beforeRow.updatedAt as Date;

      const dashRes = await dashboardRoute.GET(dashboardReq());
      ok("dashboard returns 200 (drift no longer inline)", dashRes.status === 200);
      ok(
        "dashboard read does NOT re-ingest inline (off read path)",
        dashCalls.count === 0,
        `count=${dashCalls.count}`,
      );

      const afterRow = fake.collections.normalized_work_orders.find((r: any) => r.sourceId === "WO3003");
      ok(
        "stale normalized_work_orders.updatedAt is left untouched by the read",
        (afterRow.updatedAt as Date).getTime() === beforeUpdatedAt.getTime(),
        `before=${beforeUpdatedAt.toISOString()} after=${(afterRow.updatedAt as Date).toISOString()}`,
      );

      const body = await dashRes.json();
      ok(
        "existing (stale) RO still visible in dashboard rows",
        !!body.rows?.find((r: any) => String(r.displayRo) === "WO3003"),
      );
    } finally {
      restoreDash();
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
