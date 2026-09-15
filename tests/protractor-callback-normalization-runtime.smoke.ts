/**
 * Offline runtime coverage for the real NormalizedIngestionService timing
 * wiring.  The service, adapter, Mongo Db, PG writer, and repair-pattern
 * module are all local fakes; this test never opens a database or provider
 * connection.
 *
 * Run:
 * NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
 * PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
 * npx tsx tests/protractor-callback-normalization-runtime.smoke.ts
 */

import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import Module from "node:module";
import {
  createNormalizationTimingRecorder,
  type NormalizationTimingRecord,
} from "../lib/integrations/core/normalization-timing";

type AnyDoc = Record<string, any>;
type TimingMode = "none" | "partial" | "throw";
type FailureMode = "none" | "canonical_read" | "mirror" | "stamp";

type IoCall = {
  kind: string;
  source?: string;
};

type RuntimeMode = {
  failure?: FailureMode;
  childDelays?: boolean;
  ingestionVia?: string;
  sourceSystem?: string;
  sourceId?: unknown;
  forceUpdate?: boolean;
  pgWorkOrderHit?: AnyDoc | null;
  mongoWorkOrderCandidates?: AnyDoc[];
};

const originalModuleLoad = (Module as any)._load;
let repairMode: TimingMode = "none";
let repairCalls = 0;

const repairPatternsMock = {
  __esModule: true,
  updateRepairPatternsForIngestion: async (jobs: AnyDoc[]): Promise<number> => {
    repairCalls += 1;
    if (repairMode === "throw") throw new Error("repair failure");
    return repairMode === "partial" ? Math.max(0, jobs.length - 1) : jobs.length;
  },
  updateRepairPattern: async (): Promise<void> => undefined,
};

let NormalizedIngestionService: any;

(Module as any)._load = function (
  request: string,
  parent: unknown,
  ...rest: unknown[]
) {
  if (request === "@/lib/repair-patterns") return repairPatternsMock;
  return originalModuleLoad.call(this, request, parent, ...rest);
};

function sourceId(data: AnyDoc): string {
  return String(data.id || data.ID || data.kind || "unknown");
}

function createAdapter(sourceSystem = "protractor", sourceIdOverride?: unknown): AnyDoc {
  const vehicle = {
    year: 2020,
    make: "FORD",
    model: "F-150",
    vin: "VIN-TEST",
  };
  const customer = {
    firstName: "Test",
    lastName: "Customer",
    fullName: "Test Customer",
  };
  return {
    sourceSystem,
    mapVehicle: () => vehicle,
    mapCustomer: () => customer,
    mapWorkOrder: () => ({
      workOrderNumber: "wo-test",
      status: "closed",
      workOrderType: "repair",
      grandTotal: 10,
    }),
    mapServiceJob: (_shopId: number, _workOrderId: string, data: AnyDoc) => ({
      title: data.title || data.id,
      laborHoursBilled: 1,
      laborTotal: 5,
      partsTotal: 0,
      total: 5,
    }),
    mapLineItem: (
      _shopId: number,
      _workOrderId: string,
      _serviceJobId: string,
      data: AnyDoc,
    ) => ({
      description: data.id,
      lineType: "part",
      quantity: 1,
      unitPrice: 1,
      extendedPrice: 1,
    }),
    mapPayment: () => ({
      amount: 5,
      status: "paid",
      method: "cash",
    }),
    mapInspection: () => ({ inspectionType: "multi_point", status: "completed" }),
    mapRecommendation: () => ({ title: "Test recommendation", status: "declined" }),
    getSourceIds: (data: AnyDoc) => [{
      system: sourceSystem,
      idType: `${data.kind || "source"}_id`,
      idValue: sourceIdOverride === undefined ? sourceId(data) : sourceIdOverride,
      isPrimary: true,
    }],
    extractVehicleFromWorkOrder: () => vehicle,
    extractCustomerFromWorkOrder: () => customer,
    extractServiceJobsFromWorkOrder: () => [],
    extractRawServiceJobsFromWorkOrder: (data: AnyDoc) => data.rawJobs || [],
    extractLineItemsFromServiceJob: (data: AnyDoc) => data.lines || [],
    extractPaymentsFromWorkOrder: (data: AnyDoc) => data.payments || [],
    extractInspectionsFromWorkOrder: (data: AnyDoc) => data.inspections || [],
    extractRecommendationsFromWorkOrder: (data: AnyDoc) => data.recommendations || [],
  };
}

function makeRuntime(
  withTiming: boolean,
  mode: RuntimeMode = {},
): {
  service: any;
  calls: IoCall[];
  workOrderQueries: AnyDoc[];
  workOrderFindOneArgCounts: number[];
  records: NormalizationTimingRecord[];
  activeServiceJobs: () => number;
  maxServiceJobs: () => number;
} {
  const calls: IoCall[] = [];
  const records: NormalizationTimingRecord[] = [];
  const workOrderQueries: AnyDoc[] = [];
  const workOrderFindOneArgCounts: number[] = [];
  let activeServiceJobs = 0;
  let maxServiceJobs = 0;
  const collections = new Map<string, AnyDoc>();

  const collectionFor = (name: string): AnyDoc => {
    const existing = collections.get(name);
    if (existing) return existing;
    const collection = {
      findOne: async (...args: unknown[]): Promise<AnyDoc | null> => {
        const query = args[0] as AnyDoc | undefined;
        calls.push({ kind: `mongo.read.${name}` });
        if (name === "normalized_work_orders") {
          workOrderQueries.push(query || {});
          workOrderFindOneArgCounts.push(args.length);
          const candidate = (mode.mongoWorkOrderCandidates || []).find((doc) =>
            matchesCapturedMongoQuery(doc, query || {}),
          );
          return candidate || null;
        }
        return null;
      },
      insertOne: async (): Promise<void> => {
        calls.push({ kind: `mongo.insert.${name}` });
        if (mode.failure === "mirror") throw new Error("mirror failure");
      },
      updateOne: async (): Promise<void> => {
        calls.push({ kind: `mongo.update.${name}` });
        if (mode.failure === "mirror" || mode.failure === "stamp") {
          throw new Error("mirror or stamp failure");
        }
      },
    };
    collections.set(name, collection);
    return collection;
  };

  const db = {
    collection: (name: string) => collectionFor(name),
  } as AnyDoc;

  const writer: AnyDoc = {
    findVehicleByNaturalKey: async () => {
      calls.push({ kind: "pg.read.vehicle" });
      if (mode.failure === "canonical_read") throw new Error("canonical read failure");
      return null;
    },
    findCustomerByNaturalKey: async () => {
      calls.push({ kind: "pg.read.customer" });
      return null;
    },
    findWorkOrderByNaturalKey: async () => {
      calls.push({ kind: "pg.read.work_order" });
      return mode.pgWorkOrderHit ?? null;
    },
    findServiceJobByNaturalKey: async () => {
      calls.push({ kind: "pg.read.service_job" });
      return null;
    },
    findLineItemByNaturalKey: async () => {
      calls.push({ kind: "pg.read.line_item" });
      return null;
    },
    findPaymentByNaturalKey: async () => {
      calls.push({ kind: "pg.read.payment" });
      return null;
    },
    upsertVehicle: async () => calls.push({ kind: "pg.write.vehicle" }),
    upsertCustomer: async () => calls.push({ kind: "pg.write.customer" }),
    upsertWorkOrder: async () => calls.push({ kind: "pg.write.work_order" }),
    upsertServiceJob: async (doc: AnyDoc) => {
      const source = String(doc.provenance?.sourceIds?.[0]?.idValue || "unknown");
      calls.push({ kind: "pg.write.service_job.start", source });
      if (mode.childDelays) {
        activeServiceJobs += 1;
        maxServiceJobs = Math.max(maxServiceJobs, activeServiceJobs);
        await new Promise((resolve) => setTimeout(resolve, source === "job-a" ? 8 : 0));
        activeServiceJobs -= 1;
      }
      calls.push({ kind: "pg.write.service_job.end", source });
    },
    upsertLineItem: async (doc: AnyDoc) => {
      const source = String(doc.provenance?.sourceIds?.[0]?.idValue || "unknown");
      calls.push({ kind: "pg.write.line_item", source });
    },
    upsertPayment: async () => calls.push({ kind: "pg.write.payment" }),
  };

  const timing = withTiming
    ? createNormalizationTimingRecorder(Date.now, (record) => records.push(record))
    : undefined;
  const service = new NormalizedIngestionService(
    db,
    (mode.sourceSystem || "protractor") as any,
    7,
    undefined,
    {
      createAuditLog: false,
      dualWriteToJobIndex: false,
      dualWriteToRepairPatterns: false,
      dualWriteToSupabase: false,
      ingestionVia: mode.ingestionVia,
      forceUpdate: mode.forceUpdate,
      callbackNormalizationTiming: timing,
    },
    createAdapter(mode.sourceSystem || "protractor", mode.sourceId),
  );
  (service as any).supabaseDualWriter = writer;

  return {
    service,
    calls,
    workOrderQueries,
    workOrderFindOneArgCounts,
    records,
    activeServiceJobs: () => activeServiceJobs,
    maxServiceJobs: () => maxServiceJobs,
  };
}

function matchesCapturedMongoQuery(doc: AnyDoc, query: AnyDoc): boolean {
  if (doc.shopId !== query.shopId) return false;
  const sourceIds = doc.provenance?.sourceIds;
  const elemMatch = query["provenance.sourceIds"]?.$elemMatch;
  if (!Array.isArray(sourceIds) || !elemMatch) return false;
  const hasFullIdentity = sourceIds.some((candidate: AnyDoc) =>
    Object.entries(elemMatch).every(([key, value]) => candidate[key] === value),
  );
  const dottedIdValue = query["provenance.sourceIds.idValue"];
  return hasFullIdentity &&
    (dottedIdValue === undefined ||
      sourceIds.some((candidate: AnyDoc) => candidate.idValue === dottedIdValue));
}

function resultShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resultShape);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "entityId")
      .map(([key, child]) => [key, resultShape(child)]),
  );
}

async function runRepresentativePath(withTiming: boolean): Promise<{
  calls: IoCall[];
  records: NormalizationTimingRecord[];
  results: unknown;
}> {
  const runtime = makeRuntime(withTiming);
  const { service } = runtime;
  const results = [
    await service.ingestVehicle({ kind: "vehicle", id: "vehicle-1" }),
    await service.ingestCustomer({ kind: "customer", id: "customer-1" }),
    await service.ingestWorkOrderWithAllEntities({
      kind: "work_order",
      id: "work-order-1",
      inspections: [{ kind: "inspection", id: "inspection-1" }],
      recommendations: [{ kind: "recommendation", id: "recommendation-1" }],
    }),
    await service.ingestServiceJob("work-order-1", {
      kind: "service_job",
      id: "service-job-1",
      title: "Brake",
    }),
    await service.ingestLineItem("work-order-1", "service-job-1", {
      kind: "line_item",
      id: "line-item-1",
    }),
    await service.ingestPayment("work-order-1", {
      kind: "payment",
      id: "payment-1",
    }),
  ];
  (service as any).options.callbackNormalizationTiming?.finalize("success");
  return {
    calls: runtime.calls,
    records: runtime.records,
    results: resultShape(results),
  };
}

function operationRecord(
  records: NormalizationTimingRecord[],
): Map<string, { count: number; failedCount: number; skippedCount: number }> {
  const record = records[0];
  return new Map(
    (record?.operations || []).map((entry) => [
      entry.operation,
      {
        count: entry.count,
        failedCount: entry.failedCount,
        skippedCount: entry.skippedCount,
      },
    ]),
  );
}

function existingWorkOrder(sourceIdValue: string): AnyDoc {
  return {
    _id: "existing-work-order",
    shopId: 7,
    vehicleId: "",
    customerId: "",
    version: 1,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    provenance: {
      contentHash: "old-content",
      sourceIds: [{
        system: "protractor",
        idType: "work_order_id",
        idValue: sourceIdValue,
        isPrimary: true,
      }],
    },
  };
}

async function runWorkOrder(
  mode: RuntimeMode = {},
  id = "callback-ro-1",
): Promise<{ runtime: ReturnType<typeof makeRuntime>; result: any }> {
  const runtime = makeRuntime(false, mode);
  const result = await runtime.service.ingestWorkOrder({ kind: "work_order", id });
  return { runtime, result };
}

async function main(): Promise<void> {
  ({ NormalizedIngestionService } = await import(
    "../lib/integrations/core/normalized-ingestion"
  ));
  (Module as any)._load = originalModuleLoad;
  const originalWriteMode = process.env.WRITE_MONGO_NORMALIZED;
  process.env.WRITE_MONGO_NORMALIZED = "1";
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  console.error = () => undefined;
  console.log = () => undefined;
  try {
    const optedOut = await runRepresentativePath(false);
    const optedIn = await runRepresentativePath(true);
    assert.deepEqual(
      optedIn.calls,
      optedOut.calls,
      "timing opt-in does not change actual PG/Mongo I/O calls",
    );
    assert.deepEqual(
      optedIn.results,
      optedOut.results,
      "timing opt-in does not change ingestion results",
    );
    assert.equal(optedOut.records.length, 0, "opt-out emits no normalization record");

    const operations = operationRecord(optedIn.records);
    for (const operation of [
      "vehicle_pg_natural_key_read",
      "vehicle_mongo_natural_key_read",
      "customer_pg_natural_key_read",
      "customer_mongo_natural_key_read",
      "work_order_pg_natural_key_read",
      "work_order_mongo_natural_key_read",
      "service_job_pg_natural_key_read",
      "service_job_mongo_natural_key_read",
      "line_item_pg_natural_key_read",
      "line_item_mongo_natural_key_read",
      "payment_pg_natural_key_read",
      "payment_mongo_natural_key_read",
      "post_parent_vehicle_fk_pg_read",
      "post_parent_vehicle_fk_mongo_read",
    ]) {
      assert(operations.get(operation)?.count, `${operation} is timed`);
    }
    assert.equal(operations.get("aces_decode"), undefined);
    assert.equal(operations.get("job_index_lookup"), undefined);
    assert.equal(operations.get("job_index_write"), undefined);
    assert(operations.get("inspection")?.count);
    assert(operations.get("recommendation")?.count);

    const callbackPath = await runWorkOrder({ ingestionVia: "webhook-queue-replay" });
    const callbackQuery = callbackPath.runtime.workOrderQueries[0];
    const callbackIdentity = {
      system: "protractor",
      idType: "work_order_id",
      idValue: "callback-ro-1",
      isPrimary: true,
    };
    assert.equal(callbackPath.result.success, true);
    assert.deepEqual(callbackQuery, {
      shopId: 7,
      "provenance.sourceIds": { $elemMatch: callbackIdentity },
      "provenance.sourceIds.idValue": "callback-ro-1",
    }, "callback replay captures the dotted source-id predicate");
    assert.deepEqual(callbackPath.runtime.workOrderFindOneArgCounts, [1], "no Mongo hint is passed");
    assert.equal(
      (callbackQuery as AnyDoc)["provenance.sourceSystem"],
      undefined,
      "no source-system filter",
    );

    const legacyRow = existingWorkOrder("callback-ro-1");
    const legacyPath = await runWorkOrder({
      ingestionVia: "webhook-queue-replay",
      forceUpdate: true,
      mongoWorkOrderCandidates: [legacyRow],
    });
    assert.equal(
      legacyPath.result.action,
      "updated",
      "a legacy row without top-level provenance.sourceSystem remains eligible",
    );
    assert.equal(
      matchesCapturedMongoQuery(legacyRow, callbackQuery),
      true,
      "full identity matches a legacy sourceIds element",
    );
    const crossedElements = {
      shopId: 7,
      provenance: {
        sourceIds: [
          { ...callbackIdentity, idValue: "different-ro" },
          { ...callbackIdentity, system: "tekmetric", idType: "vehicle_id", isPrimary: false },
        ],
      },
    };
    assert.equal(
      matchesCapturedMongoQuery(crossedElements, callbackQuery),
      false,
      "dotted id plus elemMatch cannot cross array elements",
    );
    for (const [field, wrongValue] of [
      ["system", "tekmetric"],
      ["idType", "vehicle_id"],
      ["isPrimary", false],
    ] as const) {
      assert.equal(
        matchesCapturedMongoQuery({
          shopId: 7,
          provenance: { sourceIds: [{ ...callbackIdentity, [field]: wrongValue }] },
        }, callbackQuery),
        false,
        `wrong ${field} does not match the full elemMatch`,
      );
    }
    assert.equal(
      matchesCapturedMongoQuery({ ...legacyRow, shopId: 8 }, callbackQuery),
      false,
      "shopId remains part of the existing identity query",
    );

    for (const [label, mode] of [
      ["poll", { ingestionVia: "poll" }],
      ["unset", {}],
      ["other provider", { sourceSystem: "tekmetric", ingestionVia: "webhook-queue-replay" }],
      ["empty id", { ingestionVia: "webhook-queue-replay", sourceId: "" }],
      ["non-string id", { ingestionVia: "webhook-queue-replay", sourceId: 42 }],
    ] as const) {
      const unaffected = await runWorkOrder(mode);
      assert.equal(unaffected.runtime.workOrderQueries.length, 1, `${label} still uses Mongo fallback`);
      assert.equal(
        unaffected.runtime.workOrderQueries[0]["provenance.sourceIds.idValue"],
        undefined,
        `${label} does not add the callback-only predicate`,
      );
      assert.deepEqual(unaffected.runtime.workOrderFindOneArgCounts, [1], `${label} has no hint`);
    }

    const pgHit = await runWorkOrder({
      ingestionVia: "webhook-queue-replay",
      pgWorkOrderHit: existingWorkOrder("callback-ro-1"),
    });
    assert.equal(pgHit.result.success, true);
    assert.equal(pgHit.runtime.workOrderQueries.length, 0, "PG hit skips Mongo fallback");
    assert.equal(
      pgHit.runtime.calls.some((call) => call.kind === "mongo.read.normalized_work_orders"),
      false,
      "PG hit avoids the Mongo natural-key read",
    );

    process.env.WRITE_MONGO_NORMALIZED = "0";
    try {
      const mirrorsOff = await runWorkOrder({ ingestionVia: "webhook-queue-replay" });
      assert.equal(mirrorsOff.runtime.workOrderQueries.length, 0, "mirror-off skips Mongo fallback");
      assert.equal(
        mirrorsOff.runtime.calls.some((call) => call.kind.startsWith("mongo.")),
        false,
        "mirror-off performs no Mongo I/O",
      );
    } finally {
      process.env.WRITE_MONGO_NORMALIZED = "1";
    }

    const failedReadRuntime = makeRuntime(true, { failure: "canonical_read" });
    const failedRead = await failedReadRuntime.service.ingestVehicle({
      kind: "vehicle",
      id: "vehicle-failure",
    });
    (failedReadRuntime.service as any).options.callbackNormalizationTiming.finalize("failed");
    assert.equal(failedRead.success, false, "canonical read failure remains an ingestion failure");
    const failedReadOperation = operationRecord(failedReadRuntime.records).get(
      "vehicle_pg_natural_key_read",
    );
    assert.equal(failedReadOperation?.failedCount, 1);
    assert.equal(
      failedReadRuntime.calls.some((call) => call.kind === "mongo.read.normalized_vehicles"),
      false,
      "a failed canonical read does not add a Mongo read",
    );

    const mirrorRuntime = makeRuntime(true, { failure: "mirror" });
    const mirrorResult = await mirrorRuntime.service.ingestWorkOrder({
      kind: "work_order",
      id: "work-order-mirror",
    });
    (mirrorRuntime.service as any).options.callbackNormalizationTiming.finalize("success");
    assert.equal(mirrorResult.success, true, "swallowed mirror failure remains non-fatal");
    assert(
      operationRecord(mirrorRuntime.records).get("work_order_mirror_write")?.failedCount,
      "swallowed mirror failure is counted",
    );

    const stampRuntime = makeRuntime(true, {
      failure: "stamp",
      ingestionVia: "webhook-queue-replay",
    });
    const stampResult = await stampRuntime.service.ingestWorkOrder({
      kind: "work_order",
      id: "work-order-stamp",
    });
    (stampRuntime.service as any).options.callbackNormalizationTiming.finalize("success");
    assert.equal(stampResult.success, true, "swallowed stamp failure remains non-fatal");
    assert.equal(
      operationRecord(stampRuntime.records).get("ingestion_stamp")?.failedCount,
      1,
    );

    const repairRuntime = makeRuntime(true);
    (repairRuntime.service as any).options.dualWriteToRepairPatterns = true;
    (repairRuntime.service as any).options.ingestionVia = "webhook-queue-replay";
    repairMode = "partial";
    repairCalls = 0;
    await (repairRuntime.service as any).writeToRepairPatterns(
      { MileageIn: 20_000, ClosedDate: "2025-01-01T00:00:00.000Z" },
      [{ title: "Brake", laborTotal: 1, partsTotal: 1, total: 2, laborHoursBilled: 1 }],
    );
    (repairRuntime.service as any).options.callbackNormalizationTiming.finalize("failed");
    assert.equal(repairCalls, 1);
    assert.equal(
      operationRecord(repairRuntime.records).get("repair_patterns")?.failedCount,
      1,
      "partial repair-pattern return is counted",
    );

    const repairThrowRuntime = makeRuntime(true);
    (repairThrowRuntime.service as any).options.dualWriteToRepairPatterns = true;
    (repairThrowRuntime.service as any).options.ingestionVia = "webhook-queue-replay";
    repairMode = "throw";
    repairCalls = 0;
    await (repairThrowRuntime.service as any).writeToRepairPatterns(
      { MileageIn: 20_000, ClosedDate: "2025-01-01T00:00:00.000Z" },
      [{ title: "Brake", laborTotal: 1, partsTotal: 1, total: 2, laborHoursBilled: 1 }],
    );
    (repairThrowRuntime.service as any).options.callbackNormalizationTiming.finalize("failed");
    assert.equal(repairCalls, 1);
    assert.equal(
      operationRecord(repairThrowRuntime.records).get("repair_patterns")?.failedCount,
      1,
      "repair-pattern throw is counted",
    );
    repairMode = "none";

    const childRuntime = makeRuntime(true, { childDelays: true });
    const childResult = await childRuntime.service.ingestWorkOrderWithAllEntities({
      kind: "work_order",
      id: "work-order-children",
      rawJobs: [
        { kind: "service_job", id: "job-a", title: "A", lines: [{ kind: "line_item", id: "line-a" }] },
        { kind: "service_job", id: "job-b", title: "B", lines: [{ kind: "line_item", id: "line-b" }] },
      ],
    });
    (childRuntime.service as any).options.callbackNormalizationTiming.finalize("success");
    assert.equal(childResult.serviceJobs.length, 2);
    assert.equal(childResult.lineItems.length, 2);
    for (const source of ["job-a", "job-b"]) {
      const serviceEnd = childRuntime.calls.findIndex(
        (call) => call.kind === "pg.write.service_job.end" && call.source === source,
      );
      const lineWrite = childRuntime.calls.findIndex(
        (call) => call.kind === "pg.write.line_item" &&
          call.source === (source === "job-a" ? "line-a" : "line-b"),
      );
      assert(serviceEnd >= 0 && lineWrite > serviceEnd, `${source} line waits for its own service job`);
    }
    assert(childRuntime.maxServiceJobs() <= 5, "child service-job concurrency remains bounded");
    assert.equal(childRuntime.activeServiceJobs(), 0);
  } finally {
    repairMode = "none";
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    if (originalWriteMode === undefined) delete process.env.WRITE_MONGO_NORMALIZED;
    else process.env.WRITE_MONGO_NORMALIZED = originalWriteMode;
  }
  process.stdout.write("protractor callback normalization runtime: all checks passed\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});