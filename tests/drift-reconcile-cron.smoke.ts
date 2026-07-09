/**
 * Task #757 regression test: the dashboard read-model drift backstop now runs
 * off the read path, in the `/api/cron/drift-reconcile` cron, instead of
 * synchronously on every `/api/dashboard/data-v2` load.
 *
 * Background: Task #517/#519 added a drift backstop that re-normalizes any
 * Protractor/Tekmetric snapshot newer than its `normalized_work_orders`
 * counterpart. It ran inline on the hottest page, adding latency. Task #757
 * moves the exact same (bounded, idempotent) reconcile logic into a cron so the
 * read path returns without waiting on re-ingestion. This test locks in that
 * the cron:
 *   (1) reconciles a drifted Protractor shop (ingest called, row refreshed),
 *   (2) reconciles a drifted Tekmetric shop (batch ingest called),
 *   (3) honors the `?provider=` filter (only that provider is swept),
 *   (4) only sweeps shops with the provider `configured`,
 *   (5) returns an `{ ok, protractorShops, tekmetricShops }` summary.
 *
 * The real `NormalizedIngestionService` needs Postgres, so we drive the cron
 * through its `__deps.getDb` seam and the shared drift lib's
 * `__deps.createIngestionService` seam against an in-memory Mongo, injecting a
 * lightweight ingestion stand-in that touches the same `normalized_work_orders`
 * row the reconcile targets.
 *
 * Run: `npx tsx tests/drift-reconcile-cron.smoke.ts`
 */

import { NextRequest } from "next/server";
import { makeFakeDb, type FakeDb } from "./utils/fake-mongo";
import * as cronRoute from "../app/api/cron/drift-reconcile/route";
import * as driftLib from "../lib/dashboard/drift-reconcile";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Calls = { protractor: number; tekmetric: number };

/**
 * Ingestion stand-in that mirrors what the reconcile expects and refreshes the
 * `normalized_work_orders.updatedAt` of the targeted row so the test can assert
 * the drift was corrected. Supports both the Protractor single-WO path and the
 * Tekmetric batch path.
 */
function makeFakeIngestionFactory(calls: Calls) {
  return (
    db: any,
    sourceSystem: "protractor" | "tekmetric",
    shopId: number,
    _enterpriseId: string | undefined,
    _options: any,
  ) => ({
    async ingestWorkOrderWithAllEntities(sourceData: any) {
      calls.protractor += 1;
      const sourceId = String(sourceData.ID ?? sourceData.id ?? sourceData.WorkOrderNumber);
      await db.collection("normalized_work_orders").updateOne(
        { shopId, sourceId },
        { $set: { updatedAt: new Date() } },
      );
      return { workOrder: { success: true, action: "updated", entityId: sourceId } };
    },
    async ingestWorkOrderBatchWithAllEntities(batch: any[]) {
      calls.tekmetric += 1;
      for (const enriched of batch) {
        const sourceId = String(enriched.id);
        await db.collection("normalized_work_orders").updateOne(
          { shopId, sourceId },
          { $set: { updatedAt: new Date() } },
        );
      }
      return { workOrders: { created: 0, updated: batch.length, skipped: 0 } };
    },
  });
}

function cronReq(query: Record<string, string> = {}): NextRequest {
  const qs = new URLSearchParams(query).toString();
  return new NextRequest(`http://localhost/api/cron/drift-reconcile${qs ? `?${qs}` : ""}`, {
    method: "GET",
  });
}

const STALE = new Date(Date.now() - 10 * 60 * 1000); // 10 min old
const FRESH = new Date(); // now → drift > 2 min threshold

function protractorSnapshot(shopId: number, woId: string, woNum: number, vin: string) {
  return {
    shopId,
    workOrderId: woId,
    workOrderNumber: woNum,
    vin,
    completed: false,
    fetchedAt: FRESH,
    rawPayload: {
      ID: woId,
      WorkOrderNumber: woNum,
      WorkflowStage: "WorkAuthorized",
      Completed: false,
      ServiceItem: { VIN: vin, Odometer: 71000, Year: 2019, Make: "Toyota", Model: "Camry" },
    },
  };
}

function tekmetricSnapshot(shopId: number, woId: string, woNum: number, vin: string) {
  return {
    shopId,
    workOrderId: woId,
    workOrderNumber: woNum,
    status: "In Progress",
    statusCode: "IN_PROGRESS",
    vin,
    vehicleYear: 2020,
    vehicleMake: "Honda",
    vehicleModel: "Civic",
    customerName: "Fresh Fran",
    fetchedAt: FRESH,
    data: {
      id: Number(woId),
      vehicleId: 999,
      vehicle: { vin, year: 2020, make: "Honda", model: "Civic" },
      customer: { firstName: "Fresh", lastName: "Fran" },
    },
  };
}

function staleNormalized(shopId: number, sourceId: string, system: string, vin: string) {
  return {
    _id: `nwo_${sourceId}`,
    shopId,
    vin,
    status: "WorkAuthorized",
    mileageIn: 71000,
    mileageOut: 0,
    sourceId,
    smsType: system,
    customer: { name: "Stale Sam" },
    vehicle: { year: 2019, make: "Toyota", model: "Camry" },
    provenance: {
      sourceSystem: system,
      sourceIds: [{ system, sourceSystem: system, idValue: sourceId, sourceId }],
    },
    createdAt: STALE,
    updatedAt: STALE,
  };
}

function seedWorld(extra?: Record<string, any[]>): FakeDb {
  return makeFakeDb({
    shops: [],
    normalized_work_orders: [],
    protractor_work_orders: [],
    tekmetric_work_orders: [],
    ...(extra || {}),
  });
}

function wire(fake: FakeDb, calls: Calls) {
  const origGetDb = cronRoute.__deps.getDb;
  const origIngest = driftLib.__deps.createIngestionService;
  cronRoute.__deps.getDb = (async () => fake.db as any) as any;
  driftLib.__deps.createIngestionService = makeFakeIngestionFactory(calls) as any;
  return () => {
    cronRoute.__deps.getDb = origGetDb;
    driftLib.__deps.createIngestionService = origIngest;
  };
}

async function run() {
  console.log("drift-reconcile cron smoke (Task #757)");

  // Sweep cases run unauthenticated; ensure CRON_SECRET is unset so the gate
  // opens (the auth gate itself is covered in case (0) below).
  const savedSecret = process.env.CRON_SECRET;

  // -------------------------------------------------------------------------
  // (0) Auth gate: with CRON_SECRET set, missing/wrong bearer is rejected and
  //     no work runs; a matching secret is accepted.
  // -------------------------------------------------------------------------
  {
    process.env.CRON_SECRET = "shhh";
    const fake = seedWorld({ shops: [{ shopId: 42, protractor: { configured: true } }] });
    const calls: Calls = { protractor: 0, tekmetric: 0 };
    const restore = wire(fake, calls);
    try {
      const noAuth = await cronRoute.GET(cronReq());
      ok("401 when CRON_SECRET set and no auth", noAuth.status === 401);
      const wrong = new NextRequest("http://localhost/api/cron/drift-reconcile", {
        method: "GET",
        headers: { authorization: "Bearer nope" },
      });
      ok("401 when CRON_SECRET set and wrong bearer", (await cronRoute.GET(wrong)).status === 401);
      ok("no work when unauthorized", calls.protractor === 0 && calls.tekmetric === 0);
      const good = await cronRoute.GET(cronReq({ secret: "shhh" }));
      ok("200 when secret query param matches", good.status === 200);
    } finally {
      restore();
    }
    delete process.env.CRON_SECRET;
  }

  // -------------------------------------------------------------------------
  // (1)+(2) Full sweep reconciles both a Protractor and a Tekmetric shop.
  // -------------------------------------------------------------------------
  {
    const fake = seedWorld({
      shops: [
        { shopId: 42, protractor: { configured: true } },
        { shopId: 77, tekmetric: { configured: true } },
        { shopId: 88 }, // no provider configured → skipped
      ],
      normalized_work_orders: [
        staleNormalized(42, "3003", "protractor", "1HGCM82633A003003"),
        staleNormalized(77, "5005", "tekmetric", "2HGCM82633A005005"),
      ],
      protractor_work_orders: [protractorSnapshot(42, "3003", 3003, "1HGCM82633A003003")],
      tekmetric_work_orders: [tekmetricSnapshot(77, "5005", 5005, "2HGCM82633A005005")],
    });
    const calls: Calls = { protractor: 0, tekmetric: 0 };
    const restore = wire(fake, calls);
    try {
      const beforeP = (fake.collections.normalized_work_orders.find((r: any) => r.sourceId === "3003")!.updatedAt as Date).getTime();
      const beforeT = (fake.collections.normalized_work_orders.find((r: any) => r.sourceId === "5005")!.updatedAt as Date).getTime();

      const res = await cronRoute.GET(cronReq());
      ok("cron returns 200", res.status === 200);
      const body = await res.json();
      ok("response ok:true", body.ok === true);
      ok("swept 1 protractor shop", body.protractorShops === 1, `got=${body.protractorShops}`);
      ok("swept 1 tekmetric shop", body.tekmetricShops === 1, `got=${body.tekmetricShops}`);
      ok("no errors", Array.isArray(body.errors) && body.errors.length === 0, JSON.stringify(body.errors));

      ok("protractor drift re-normalized (ingest called)", calls.protractor === 1, `count=${calls.protractor}`);
      ok("tekmetric drift re-normalized (batch ingest called)", calls.tekmetric === 1, `count=${calls.tekmetric}`);

      const afterP = (fake.collections.normalized_work_orders.find((r: any) => r.sourceId === "3003")!.updatedAt as Date).getTime();
      const afterT = (fake.collections.normalized_work_orders.find((r: any) => r.sourceId === "5005")!.updatedAt as Date).getTime();
      ok("protractor normalized row updatedAt advanced", afterP > beforeP);
      ok("tekmetric normalized row updatedAt advanced", afterT > beforeT);
    } finally {
      restore();
    }
  }

  // -------------------------------------------------------------------------
  // (3) provider=protractor only sweeps Protractor shops.
  // -------------------------------------------------------------------------
  {
    const fake = seedWorld({
      shops: [
        { shopId: 42, protractor: { configured: true } },
        { shopId: 77, tekmetric: { configured: true } },
      ],
      normalized_work_orders: [
        staleNormalized(42, "3003", "protractor", "1HGCM82633A003003"),
        staleNormalized(77, "5005", "tekmetric", "2HGCM82633A005005"),
      ],
      protractor_work_orders: [protractorSnapshot(42, "3003", 3003, "1HGCM82633A003003")],
      tekmetric_work_orders: [tekmetricSnapshot(77, "5005", 5005, "2HGCM82633A005005")],
    });
    const calls: Calls = { protractor: 0, tekmetric: 0 };
    const restore = wire(fake, calls);
    try {
      const res = await cronRoute.GET(cronReq({ provider: "protractor" }));
      const body = await res.json();
      ok("provider=protractor swept 1 protractor shop", body.protractorShops === 1, `got=${body.protractorShops}`);
      ok("provider=protractor swept 0 tekmetric shops", body.tekmetricShops === 0, `got=${body.tekmetricShops}`);
      ok("provider=protractor did not touch tekmetric ingest", calls.tekmetric === 0, `count=${calls.tekmetric}`);
    } finally {
      restore();
    }
  }

  // -------------------------------------------------------------------------
  // (4) A configured shop with no recent snapshots is a no-op (no ingest).
  // -------------------------------------------------------------------------
  {
    const fake = seedWorld({
      shops: [{ shopId: 42, protractor: { configured: true } }],
      normalized_work_orders: [],
      protractor_work_orders: [], // nothing to reconcile
    });
    const calls: Calls = { protractor: 0, tekmetric: 0 };
    const restore = wire(fake, calls);
    try {
      const res = await cronRoute.GET(cronReq());
      const body = await res.json();
      ok("empty shop still counts as swept", body.protractorShops === 1, `got=${body.protractorShops}`);
      ok("no ingest when there are no snapshots", calls.protractor === 0, `count=${calls.protractor}`);
    } finally {
      restore();
    }
  }

  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;

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
