/**
 * Smoke test for task #414 — pin the FK invariant on the
 * `ingestWorkOrder` / `ingestServiceJob` skip paths — extended for the
 * task #552 W3a change-detection cutover.
 *
 * Before #414, when a Mongo doc existed with a matching contentHash the
 * ingest method short-circuited *before* any PG write. If the Mongo doc
 * pre-dated the W3a polarity flip (#344), the PG row was never created,
 * and any subsequent child `service_job` / `line_item` insert would
 * FK-violate against the missing parent. The #414 fix performs an
 * idempotent PG upsert on that skip path.
 *
 * Task #552 moved change-detection itself to PG-canonical: the ingest
 * method now looks the existing record up via the PG natural-key finders
 * (`findWorkOrderByNaturalKey` / `findServiceJobByNaturalKey`) first, and
 * only falls back to the Mongo `findOne` while shadow writes are on. There
 * are now two skip scenarios, both of which must keep the FK invariant:
 *   1. Mongo-fallback hit (PG finder returns null, pre-flip Mongo doc):
 *      the #414 skip-fk-backfill upsert MUST fire so the missing PG parent
 *      is created.
 *   2. PG-canonical hit (finder returns a `__fromPg` record): the PG row
 *      already exists, so the backfill upsert MUST NOT fire — `existing`
 *      is only a partial projection and spreading it would clobber the row.
 *
 * Run: `npx tsx tests/pg-canonical-fk-skip-path.smoke.ts`
 */

import type { Db } from "mongodb";
import { NormalizedIngestionService } from "../lib/integrations/core/normalized-ingestion";
import type { INormalizedAdapter } from "../lib/integrations/core/normalized-adapter";
import type { SupabaseDualWriter } from "../lib/supabase-dual-writer";
import type { SourceSystem } from "../lib/normalized-schema";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface UpsertCall {
  kind: "wo" | "sj";
  doc: { _id?: string; workOrderId?: string };
}

type MockWriter = Pick<
  SupabaseDualWriter,
  | "upsertWorkOrder"
  | "upsertServiceJob"
  | "findWorkOrderByNaturalKey"
  | "findServiceJobByNaturalKey"
>;

function makeStubMongoDb(existingByCol: Record<string, unknown[]>): Db {
  // Minimal subset of the Mongo `Db` surface that NormalizedIngestionService
  // actually exercises in the work-order / service-job paths. Cast through
  // `unknown` so we don't have to stub the full driver type.
  const stub = {
    collection(name: string) {
      const docs = existingByCol[name] ?? [];
      return {
        async findOne() {
          return docs[0] ?? null;
        },
        async insertOne() {
          return { acknowledged: true };
        },
        async updateOne() {
          return { acknowledged: true };
        },
      };
    },
  };
  return stub as unknown as Db;
}

function makeStubAdapter(): INormalizedAdapter {
  const stub = {
    sourceSystem: "tekmetric" as SourceSystem,
    mapWorkOrder: () => ({
      workOrderNumber: "WO-1",
      workOrderType: "repair",
      status: "closed",
      vehicle: { vehicleId: "" },
    }),
    mapServiceJob: () => ({
      title: "Oil change",
      jobType: "custom",
      status: "completed",
    }),
    getSourceIds: () => [
      { system: "tekmetric", idType: "work_order_id", idValue: "1", isPrimary: true },
    ],
    extractVehicleFromWorkOrder: () => null,
    extractCustomerFromWorkOrder: () => null,
    extractServiceJobsFromWorkOrder: () => [],
    extractRawServiceJobsFromWorkOrder: () => [],
    extractLineItemsFromServiceJob: () => [],
    extractPaymentsFromWorkOrder: () => [],
    extractInspectionsFromWorkOrder: () => [],
    extractRecommendationsFromWorkOrder: () => [],
    mapLineItem: () => ({}),
    mapPayment: () => ({}),
    mapInspection: () => ({}),
    mapRecommendation: () => ({}),
  };
  return stub as unknown as INormalizedAdapter;
}

function makeService(mongoDb: Db, writer: MockWriter): NormalizedIngestionService {
  // Constructor signature: (db, sourceSystem, shopId, enterpriseId?, options?, adapterOverride?)
  // Pass dualWriteToSupabase:false so the constructor skips the real PG init,
  // then attach our mock writer directly via a narrow internal-shape cast.
  const svc = new NormalizedIngestionService(
    mongoDb,
    "tekmetric" as SourceSystem,
    97,
    undefined,
    {
      dualWriteToSupabase: false,
      createAuditLog: false,
      dualWriteToJobIndex: false,
      dualWriteToRepairPatterns: false,
      syncRunId: "test",
    },
    makeStubAdapter(),
  );
  (svc as unknown as { supabaseDualWriter: MockWriter }).supabaseDualWriter = writer;
  return svc;
}

async function probeContentHash(kind: "wo" | "sj"): Promise<string> {
  // Probe: run ingest against an EMPTY Mongo so the create branch fires,
  // capturing the contentHash the writer sees.
  const mongoDb = makeStubMongoDb({});
  let captured = "";
  const probeWriter: MockWriter = {
    upsertWorkOrder: async (d) => {
      if (kind === "wo") captured = d.provenance?.contentHash ?? "";
    },
    upsertServiceJob: async (d) => {
      if (kind === "sj") captured = d.provenance?.contentHash ?? "";
    },
    // Empty PG → finders miss, so change-detection falls through to the
    // (empty) Mongo stub and the create branch fires.
    findWorkOrderByNaturalKey: async () => null,
    findServiceJobByNaturalKey: async () => null,
  };
  const svc = makeService(mongoDb, probeWriter);
  if (kind === "wo") await svc.ingestWorkOrder({ id: "1" });
  else await svc.ingestServiceJob("wo-pg-canonical-id", { id: "10" });
  return captured;
}

async function main() {
  console.log("=== pg-canonical-fk-skip-path.smoke ===\n");

  const woHash = await probeContentHash("wo");
  const sjHash = await probeContentHash("sj");
  ok("probe captured WO contentHash", !!woHash);
  ok("probe captured SJ contentHash", !!sjHash);

  const fakeWoMongo = {
    _id: "wo-pg-canonical-id",
    shopId: 97,
    enterpriseId: null,
    vehicleId: "veh-1",
    customerId: null,
    workOrderNumber: "WO-1",
    workOrderType: "repair",
    status: "closed",
    provenance: {
      contentHash: woHash,
      sourceIds: [
        { system: "tekmetric", idType: "work_order_id", idValue: "1", isPrimary: true },
      ],
      sourceSystem: "tekmetric",
      lastSeenAt: new Date(),
      lastSyncedAt: new Date(),
    },
    softDelete: { isDeleted: false },
    version: 3,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  };

  const fakeSjMongo = {
    _id: "sj-pg-canonical-id",
    shopId: 97,
    workOrderId: "wo-pg-canonical-id",
    title: "Oil change",
    jobType: "custom",
    status: "completed",
    provenance: {
      contentHash: sjHash,
      sourceIds: [
        { system: "tekmetric", idType: "service_job_id", idValue: "10", isPrimary: true },
      ],
      sourceSystem: "tekmetric",
    },
    softDelete: { isDeleted: false },
    version: 2,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  };

  const upsertCalls: UpsertCall[] = [];

  // Scenario 1 — Mongo-fallback hit (pre-flip doc, PG row missing). The PG
  // finders miss (return null), so change-detection falls back to Mongo and
  // the #414 skip-fk-backfill upsert MUST fire.
  const mongoFallbackWriter: MockWriter = {
    upsertWorkOrder: async (d) => {
      upsertCalls.push({ kind: "wo", doc: d });
    },
    upsertServiceJob: async (d) => {
      upsertCalls.push({ kind: "sj", doc: d });
    },
    findWorkOrderByNaturalKey: async () => null,
    findServiceJobByNaturalKey: async () => null,
  };

  // WO skip-path test (Mongo fallback)
  {
    const mongoDb = makeStubMongoDb({ normalized_work_orders: [fakeWoMongo] });
    const svc = makeService(mongoDb, mongoFallbackWriter);
    upsertCalls.length = 0;
    const r = await svc.ingestWorkOrder({ id: "1" });
    ok(
      "WO skip branch (Mongo fallback) returns 'skipped'",
      r.action === "skipped",
      `got ${r.action} (${r.message ?? ""})`,
    );
    ok(
      "WO skip branch (Mongo fallback) performs idempotent PG upsert (task #414)",
      upsertCalls.some((c) => c.kind === "wo" && c.doc._id === "wo-pg-canonical-id"),
      "upsertWorkOrder was NOT invoked on skip — PG FK invariant would break",
    );
  }

  // SJ skip-path test (Mongo fallback)
  {
    const mongoDb = makeStubMongoDb({ normalized_service_jobs: [fakeSjMongo] });
    const svc = makeService(mongoDb, mongoFallbackWriter);
    upsertCalls.length = 0;
    const r = await svc.ingestServiceJob("wo-pg-canonical-id", { id: "10" });
    ok(
      "SJ skip branch (Mongo fallback) returns 'skipped'",
      r.action === "skipped",
      `got ${r.action} (${r.message ?? ""})`,
    );
    ok(
      "SJ skip branch (Mongo fallback) performs idempotent PG upsert (task #414)",
      upsertCalls.some(
        (c) =>
          c.kind === "sj" &&
          c.doc._id === "sj-pg-canonical-id" &&
          c.doc.workOrderId === "wo-pg-canonical-id",
      ),
      "upsertServiceJob was NOT invoked on skip — child line_items would FK-violate",
    );
  }

  // Scenario 2 — PG-canonical hit (task #552). The finder returns a
  // `__fromPg` record, so the PG row already exists. The skip branch MUST
  // still return 'skipped' but MUST NOT run the backfill upsert (which would
  // spread a partial projection over the real row).
  const pgWoRecord = {
    _id: "wo-pg-canonical-id",
    provenance: {
      contentHash: woHash,
      sourceIds: [
        { system: "tekmetric", idType: "work_order_id", idValue: "1", isPrimary: true },
      ],
    },
    softDelete: { isDeleted: false },
    version: 5,
    createdAt: new Date("2025-01-01"),
    vehicleId: "veh-1",
    customerId: null,
    __fromPg: true,
  };
  const pgSjRecord = {
    _id: "sj-pg-canonical-id",
    provenance: {
      contentHash: sjHash,
      sourceIds: [
        { system: "tekmetric", idType: "service_job_id", idValue: "10", isPrimary: true },
      ],
    },
    softDelete: { isDeleted: false },
    version: 4,
    createdAt: new Date("2025-01-01"),
    __fromPg: true,
  };
  const pgCanonicalWriter: MockWriter = {
    upsertWorkOrder: async (d) => {
      upsertCalls.push({ kind: "wo", doc: d });
    },
    upsertServiceJob: async (d) => {
      upsertCalls.push({ kind: "sj", doc: d });
    },
    findWorkOrderByNaturalKey: async () => pgWoRecord as any,
    findServiceJobByNaturalKey: async () => pgSjRecord as any,
  };

  // WO skip-path test (PG canonical) — Mongo is empty so a fallback would
  // miss; the only hit comes from the PG finder.
  {
    const mongoDb = makeStubMongoDb({});
    const svc = makeService(mongoDb, pgCanonicalWriter);
    upsertCalls.length = 0;
    const r = await svc.ingestWorkOrder({ id: "1" });
    ok(
      "WO skip branch (PG canonical) returns 'skipped'",
      r.action === "skipped",
      `got ${r.action} (${r.message ?? ""})`,
    );
    ok(
      "WO skip branch (PG canonical) does NOT re-upsert the existing PG row (task #552)",
      !upsertCalls.some((c) => c.kind === "wo"),
      "upsertWorkOrder fired on a __fromPg hit — partial projection would clobber the real row",
    );
  }

  // SJ skip-path test (PG canonical)
  {
    const mongoDb = makeStubMongoDb({});
    const svc = makeService(mongoDb, pgCanonicalWriter);
    upsertCalls.length = 0;
    const r = await svc.ingestServiceJob("wo-pg-canonical-id", { id: "10" });
    ok(
      "SJ skip branch (PG canonical) returns 'skipped'",
      r.action === "skipped",
      `got ${r.action} (${r.message ?? ""})`,
    );
    ok(
      "SJ skip branch (PG canonical) does NOT re-upsert the existing PG row (task #552)",
      !upsertCalls.some((c) => c.kind === "sj"),
      "upsertServiceJob fired on a __fromPg hit — partial projection would clobber the real row",
    );
  }

  if (failed) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
