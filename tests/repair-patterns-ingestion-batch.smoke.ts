/**
 * Regression coverage for the normalized-ingestion repair-pattern batch path.
 *
 * The fake collection applies the small Mongo update-pipeline expression
 * subset used by this path. No Mongo/PG/provider connection is opened.
 *
 * Run independently:
 *   PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
 *   NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
 *     npx tsx tests/repair-patterns-ingestion-batch.smoke.ts
 */

import assert from "node:assert/strict";

type Doc = Record<string, any>;

function pathValue(doc: Doc, path: string): any {
  return path.split(".").reduce((value, part) => value?.[part], doc);
}

function sameValue(left: any, right: any): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, value]) =>
    sameValue(pathValue(doc, key), value),
  );
}

function evaluate(expr: any, doc: Doc, vars: Record<string, any> = {}): any {
  if (expr instanceof Date || expr === null || typeof expr !== "object") {
    if (typeof expr === "string" && expr.startsWith("$$")) {
      return expr
        .slice(2)
        .split(".")
        .reduce((value: any, part: string) => value?.[part], vars);
    }
    if (typeof expr === "string" && expr.startsWith("$")) {
      return pathValue(doc, expr.slice(1));
    }
    return expr;
  }
  if (Array.isArray(expr)) return expr.map((item) => evaluate(item, doc, vars));
  if ("$literal" in expr) return expr.$literal;
  if ("$ifNull" in expr) {
    const value = evaluate(expr.$ifNull[0], doc, vars);
    return value == null ? evaluate(expr.$ifNull[1], doc, vars) : value;
  }
  if ("$add" in expr) {
    return expr.$add.reduce((sum: number, item: any) => sum + Number(evaluate(item, doc, vars)), 0);
  }
  if ("$multiply" in expr) {
    return expr.$multiply.reduce((product: number, item: any) => product * Number(evaluate(item, doc, vars)), 1);
  }
  if ("$divide" in expr) {
    return Number(evaluate(expr.$divide[0], doc, vars)) / Number(evaluate(expr.$divide[1], doc, vars));
  }
  if ("$cond" in expr) {
    const [condition, whenTrue, whenFalse] = expr.$cond;
    return evaluate(condition, doc, vars)
      ? evaluate(whenTrue, doc, vars)
      : evaluate(whenFalse, doc, vars);
  }
  if ("$or" in expr) {
    return expr.$or.some((item: any) => Boolean(evaluate(item, doc, vars)));
  }
  if ("$eq" in expr) {
    return sameValue(
      evaluate(expr.$eq[0], doc, vars),
      evaluate(expr.$eq[1], doc, vars),
    );
  }
  if ("$gt" in expr) {
    return evaluate(expr.$gt[0], doc, vars) > evaluate(expr.$gt[1], doc, vars);
  }
  if ("$lt" in expr) {
    return evaluate(expr.$lt[0], doc, vars) < evaluate(expr.$lt[1], doc, vars);
  }
  if ("$type" in expr) {
    return evaluate(expr.$type, doc, vars) === undefined ? "missing" : "date";
  }
  if ("$in" in expr) {
    const needle = evaluate(expr.$in[0], doc, vars);
    return (evaluate(expr.$in[1], doc, vars) || []).some((item: any) =>
      sameValue(item, needle),
    );
  }
  if ("$concatArrays" in expr) {
    return expr.$concatArrays.reduce(
      (out: any[], item: any) => out.concat(evaluate(item, doc, vars)),
      [],
    );
  }
  if ("$let" in expr) {
    const scoped = { ...vars };
    for (const [name, value] of Object.entries(expr.$let.vars ?? {})) {
      scoped[name] = evaluate(value, doc, scoped);
    }
    return evaluate(expr.$let.in, doc, scoped);
  }
  if ("$reduce" in expr) {
    const input = evaluate(expr.$reduce.input, doc, vars) || [];
    let value = evaluate(expr.$reduce.initialValue, doc, vars);
    for (const item of input) {
      value = evaluate(expr.$reduce.in, doc, { ...vars, this: item, value });
    }
    return value;
  }
  return Object.fromEntries(
    Object.entries(expr).map(([key, value]) => [
      key,
      evaluate(value, doc, vars),
    ]),
  );
}

function applyPipeline(doc: Doc, pipeline: any[]): void {
  for (const stage of pipeline) {
    if (stage.$set) {
      const values = Object.fromEntries(
        Object.entries(stage.$set).map(([key, expression]) => [
          key,
          evaluate(expression, doc),
        ]),
      );
      Object.assign(doc, values);
    } else if (stage.$unset) {
      delete doc[stage.$unset];
    } else {
      throw new Error(`unsupported fake stage: ${JSON.stringify(stage)}`);
    }
  }
}

function makeFakeDb(seed: Doc[]) {
  const docs = seed.map((doc) => ({ ...doc }));
  const calls: Array<{ ops: any[]; options: any }> = [];
  let updateCalls = 0;
  let failedIndex: number | null = null;
  let writeConcernFailure = false;
  let singleWriteError: Error | null = null;
  const collection = {
    async updateOne() {
      updateCalls += 1;
      if (singleWriteError) throw singleWriteError;
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    },
    async bulkWrite(ops: any[], options: any) {
      calls.push({ ops, options });
      ops.forEach((operation, index) => {
        if (failedIndex === index) return;
        const { filter, update, upsert } = operation.updateOne;
        let doc = docs.find((candidate) => matches(candidate, filter));
        if (!doc && upsert) {
          const upserted = { ...filter };
          doc = upserted;
          docs.push(upserted);
        }
        if (doc) applyPipeline(doc, update);
      });
      if (failedIndex !== null) {
        throw Object.assign(new Error("simulated bulk key failure"), {
          writeErrors: [{ index: failedIndex }],
          result: {
            getWriteConcernError: () => writeConcernFailure ? { code: 64 } : undefined,
          },
        });
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
  };
  return {
    docs,
    calls,
    get updateCalls() {
      return updateCalls;
    },
    collection,
    failAt(index: number | null) {
      failedIndex = index;
    },
    failWriteConcern(value: boolean) {
      writeConcernFailure = value;
    },
    failSingleWrite(error: Error | null) {
      singleWriteError = error;
    },
    resetCounts() {
      calls.splice(0, calls.length);
      updateCalls = 0;
    },
  };
}

const existing = {
  shopId: 7,
  year: 2020,
  make: "FORD",
  model: "F-150",
  mileageBucket: 85000,
  jobTitleNormalized: "brake job",
  jobTitle: "Old Brake",
  occurrences: 2,
  totalLabor: 100,
  totalParts: 50,
  totalAmount: 150,
  avgLabor: 50,
  avgParts: 25,
  avgTotal: 75,
  avgHours: 5,
  lastPerformed: new Date("2025-02-01T00:00:00.000Z"),
  firstPerformed: new Date("2024-01-01T00:00:00.000Z"),
  vinsSeen: ["VIN-OLD"],
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

const fake = makeFakeDb([existing]);
const mongoPath = require.resolve("../lib/mongo");
const pgCalls: string[] = [];
let pgFailure: Error & { code?: number } | null = null;
const pgPath = require.resolve("../lib/data/repositories/pg/repair-patterns");
require.cache[mongoPath] = {
  id: mongoPath,
  filename: mongoPath,
  loaded: true,
  children: [],
  paths: [],
  exports: { getDb: async () => ({ collection: () => fake.collection }) },
} as any;
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    updateRepairPattern: async (job: { jobTitle: string }) => {
      pgCalls.push(job.jobTitle);
      if (pgFailure) throw pgFailure;
    },
  },
} as any;

async function main() {
  const { updateRepairPatternsForIngestion } = await import("../lib/repair-patterns");
  const jobs = [
    {
      shopId: 7,
      year: 2020,
      make: "ford",
      model: "f-150",
      mileage: 85300,
      jobTitle: "Brake Job",
      laborAmount: 10,
      partsAmount: 5,
      totalAmount: 15,
      laborHours: 2,
      vin: "VIN-A",
      performedDate: new Date("2025-01-01T00:00:00.000Z"),
    },
    {
      shopId: 7,
      year: 2020,
      make: "FORD",
      model: "F-150",
      mileage: 85400,
      jobTitle: "brake job ",
      laborAmount: 20,
      partsAmount: 6,
      totalAmount: 26,
      laborHours: 0,
      vin: "VIN-B",
      performedDate: new Date("2025-03-01T00:00:00.000Z"),
    },
    {
      shopId: 7,
      year: 2020,
      make: "ford",
      model: "f-150",
      mileage: 85300,
      jobTitle: "$39 Oil",
      laborAmount: 10,
      partsAmount: 2,
      totalAmount: 12,
      laborHours: 3,
      vin: "VIN-C",
      performedDate: new Date("2025-04-01T00:00:00.000Z"),
    },
  ];

  const invalidSameKey = {
    ...jobs[0],
    laborHours: Number.NaN,
    vin: "SECRET-BAD-VIN",
  };

  process.env.REPAIR_PATTERNS_PG_CANONICAL = "1";
  process.env.WRITE_MONGO_REPAIR_PATTERNS = "0";
  assert.equal(await updateRepairPatternsForIngestion([jobs[0], jobs[2]]), 2);
  assert.deepEqual(pgCalls, ["Brake Job", "$39 Oil"], "PG stays sequential");
  assert.equal(fake.calls.length, 0, "PG mode does not use Mongo bulk");
  pgFailure = Object.assign(new Error("SECRET-PG-DETAIL"), { code: 91 });
  const pgErrorLogs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => pgErrorLogs.push(args);
  try {
    assert.equal(await updateRepairPatternsForIngestion([jobs[0]]), 0);
  } finally {
    console.error = originalConsoleError;
    pgFailure = null;
  }
  assert(
    pgErrorLogs.every(
      (args) => !JSON.stringify(args).includes("SECRET-PG-DETAIL"),
    ),
    "PG failure logs do not expose raw errors",
  );

  process.env.REPAIR_PATTERNS_PG_CANONICAL = "0";
  const rejectedLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => rejectedLogs.push(args);
  try {
    assert.equal(
      await updateRepairPatternsForIngestion([
        jobs[0],
        jobs[1],
        invalidSameKey,
        jobs[2],
      ]),
      3,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert(
    rejectedLogs.every((args) => !JSON.stringify(args).includes("SECRET-BAD-VIN")),
    "rejected-job logs do not expose VINs",
  );
  assert.equal(fake.calls.length, 1, "all keys use one bulk round trip");
  assert.equal(fake.calls[0].options.ordered, false);
  assert.equal(fake.calls[0].ops.length, 2, "duplicate natural keys are folded");

  const brake = fake.docs.find((doc) => doc.jobTitleNormalized === "brake job")!;
  assert.equal(brake.occurrences, 4, "duplicate jobs still count separately");
  assert.equal(brake.totalLabor, 130);
  assert.equal(brake.totalParts, 61);
  assert.equal(brake.totalAmount, 191);
  assert.equal(brake.avgLabor, 32.5);
  assert.equal(brake.avgParts, 15.25);
  assert.equal(brake.avgTotal, 47.75);
  assert.equal(brake.avgHours, 4, "zero-hour jobs preserve the running mean");
  assert.equal(brake.jobTitle, "brake job ", "last job value wins");
  assert.equal(brake.lastPerformed.getTime(), new Date("2025-03-01").getTime());
  assert.deepEqual(brake.vinsSeen, ["VIN-OLD", "VIN-A", "VIN-B"]);
  assert.equal(brake.enterpriseId, null, "missing enterprise is stored as null");

  const oil = fake.docs.find((doc) => doc.jobTitleNormalized === "$39 oil")!;
  assert.equal(oil.occurrences, 1);
  assert.equal(oil.avgLabor, 10);
  assert.equal(oil.avgHours, 3);
  assert.equal(oil.jobTitle, "$39 Oil", "dollar-prefixed title is literal");
  assert.deepEqual(oil.vinsSeen, ["VIN-C"]);
  assert.equal(oil.enterpriseId, null);

  const hugeDuplicateGroup = Array.from({ length: 1200 }, (_, index) => ({
    ...jobs[0],
    laborHours: index % 2 === 0 ? 2 : 0,
    vin: `VIN-HUGE-${index}`,
  }));
  fake.failAt(null);
  assert.equal(
    await updateRepairPatternsForIngestion([
      ...hugeDuplicateGroup.slice(0, 600),
      invalidSameKey,
      ...hugeDuplicateGroup.slice(600),
    ]),
    1200,
    "large duplicate group excludes only its invalid record",
  );
  const hugePipeline = fake.calls[1].ops[0].updateOne.update;
  const avgHoursExpression = hugePipeline[0].$set.avgHours;
  assert(avgHoursExpression.$let?.vars?.result?.$reduce);
  assert.equal(
    avgHoursExpression.$let.vars.result.$reduce.input.$literal.length,
    1200,
    "large duplicate average uses one bounded-depth reducer",
  );

  fake.failAt(1);
  const bulkFailureLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => bulkFailureLogs.push(args);
  const isolated = await updateRepairPatternsForIngestion([
    jobs[0],
    jobs[2],
  ]);
  console.error = originalConsoleError;
  assert.equal(isolated, 1, "one failed key does not erase another key");
  assert.equal(fake.calls.length, 3);
  assert(
    bulkFailureLogs.every(
      (args) =>
        !JSON.stringify(args).includes("oil change") &&
        !JSON.stringify(args).includes("VIN-C"),
    ),
    "bulk failure logs do not expose filters or VINs",
  );

  fake.failWriteConcern(true);
  console.error = (...args: unknown[]) => bulkFailureLogs.push(args);
  try {
    assert.equal(
      await updateRepairPatternsForIngestion([jobs[0], jobs[2]]),
      0,
      "mixed operation and write-concern errors never claim confirmed successes",
    );
  } finally {
    fake.failWriteConcern(false);
    console.error = originalConsoleError;
  }

  const { NormalizedIngestionService } = await import(
    "../lib/integrations/core/normalized-ingestion"
  );
  const adapter = (sourceSystem: "protractor" | "tekmetric") =>
    ({
      sourceSystem,
      extractVehicleFromWorkOrder: () => ({
        year: 2020,
        make: "FORD",
        model: "F-150",
        vin: "VIN-SOURCE",
      }),
    }) as any;
  const serviceJobs = [jobs[0], jobs[2]].map((job) => ({
    ...job,
    title: job.jobTitle,
    laborTotal: job.laborAmount,
    partsTotal: job.partsAmount,
    total: job.totalAmount,
    laborHoursBilled: job.laborHours,
  }));
  const runRepairPatternPath = async (
    sourceSystem: "protractor" | "tekmetric",
    ingestionVia: string,
  ) => {
    const service = new NormalizedIngestionService(
      {} as any,
      sourceSystem as any,
      7,
      undefined,
      {
        dualWriteToJobIndex: false,
        dualWriteToRepairPatterns: true,
        dualWriteToSupabase: false,
        createAuditLog: false,
        ingestionVia,
      },
      adapter(sourceSystem),
    );
    await (service as any).writeToRepairPatterns(
      { MileageIn: 85300, ClosedDate: "2025-05-01T00:00:00.000Z" },
      serviceJobs,
    );
  };

  fake.failAt(null);
  fake.resetCounts();
  await runRepairPatternPath("protractor", "webhook-queue-replay");
  assert.equal(fake.calls.length, 1, "callback replay opts into one bulk write");
  assert.equal(fake.updateCalls, 0);

  fake.resetCounts();
  await runRepairPatternPath("tekmetric", "webhook-queue-replay");
  assert.equal(fake.calls.length, 0, "non-Protractor replay stays sequential");
  assert.equal(fake.updateCalls, 4);

  fake.resetCounts();
  fake.failSingleWrite(new Error("SECRET-NORMALIZED-DETAIL"));
  const normalizedErrorLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => normalizedErrorLogs.push(args);
  try {
    await runRepairPatternPath("tekmetric", "backfill");
  } finally {
    console.error = originalConsoleError;
    fake.failSingleWrite(null);
  }
  assert(
    normalizedErrorLogs.every(
      (args) => !JSON.stringify(args).includes("SECRET-NORMALIZED-DETAIL"),
    ),
    "normalized fallback logs do not expose raw errors",
  );

  console.log("repair-patterns-ingestion-batch.smoke: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
