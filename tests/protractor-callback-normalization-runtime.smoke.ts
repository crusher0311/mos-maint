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

function createAdapter(): AnyDoc {
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
    sourceSystem: "protractor",
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
      system: "protractor",
      idType: `${data.kind || "source"}_id`,
      idValue: sourceId(data),
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
  records: NormalizationTimingRecord[];
  activeServiceJobs: () => number;
  maxServiceJobs: () => number;
} {
  const calls: IoCall[] = [];
  const records: NormalizationTimingRecord[] = [];
  let activeServiceJobs = 0;
  let maxServiceJobs = 0;
  const collections = new Map<string, AnyDoc>();

  const collectionFor = (name: string): AnyDoc => {
    const existing = collections.get(name);
    if (existing) return existing;
    const collection = {
      findOne: async (): Promise<null> => {
        calls.push({ kind: `mongo.read.${name}` });
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
      return null;
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
    "protractor",
    7,
    undefined,
    {
      createAuditLog: false,
      dualWriteToJobIndex: false,
      dualWriteToRepairPatterns: false,
      dualWriteToSupabase: false,
      ingestionVia: mode.ingestionVia,
      callbackNormalizationTiming: timing,
    },
    createAdapter(),
  );
  (service as any).supabaseDualWriter = writer;

  return {
    service,
    calls,
    records,
    activeServiceJobs: () => activeServiceJobs,
    maxServiceJobs: () => maxServiceJobs,
  };
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