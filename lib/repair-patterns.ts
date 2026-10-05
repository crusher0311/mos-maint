import { getDb } from "./mongo";
import { Collection, ObjectId } from "mongodb";
import { toObjectId } from "./object-id-utils";
import {
  isRepairPatternsPgCanonical,
  shouldShadowWriteMongoRepairPatterns,
  shadowWriteMongoLegacyStore,
} from "./db/legacy-store-write-mode";
import * as pg from "./data/repositories/pg/repair-patterns";

export interface RepairPattern {
  _id?: ObjectId;
  shopId: number;
  enterpriseId?: string; // MongoDB ObjectId string
  year: number;
  make: string;
  model: string;
  mileageBucket: number; // 5k increments: 85000 → 85, 92000 → 90
  jobTitle: string;
  jobTitleNormalized: string; // lowercase, trimmed for matching
  occurrences: number;
  totalLabor: number;
  totalParts: number;
  totalAmount: number;
  avgLabor: number;
  avgParts: number;
  avgTotal: number;
  avgHours: number;
  lastPerformed: Date;
  firstPerformed: Date;
  vinsSeen: string[]; // Track unique vehicles (capped at 100 for space)
  updatedAt: Date;
  createdAt: Date;
}

export interface PatternMatch {
  jobTitle: string;
  occurrences: number;
  avgTotal: number;
  avgHours: number;
  avgLabor: number;
  avgParts: number;
  lastPerformed: Date;
  confidence: "high" | "medium" | "low";
  mileageBucket: number;
  uniqueVehicles: number;
}

const COLLECTION_NAME = "shop_repair_patterns";

// Model variants that share platforms/components and should cross-reference failures
const MODEL_VARIANTS: Record<string, string[]> = {
  // Ford SUVs - shared platforms
  "EXPEDITION": ["EXPEDITION", "EXPEDITION MAX"],
  "EXPEDITION MAX": ["EXPEDITION", "EXPEDITION MAX"],
  "EXPLORER": ["EXPLORER", "EXPLORER SPORT", "EXPLORER SPORT TRAC"],
  "EXPLORER SPORT": ["EXPLORER", "EXPLORER SPORT"],
  "EXPLORER SPORT TRAC": ["EXPLORER", "EXPLORER SPORT TRAC"],
  // Ford F-Series
  "F-150": ["F-150", "F-150 LIGHTNING"],
  "F-150 LIGHTNING": ["F-150", "F-150 LIGHTNING"],
  // Chevy SUVs
  "TAHOE": ["TAHOE", "SUBURBAN"],
  "SUBURBAN": ["TAHOE", "SUBURBAN"],
  "TRAVERSE": ["TRAVERSE", "ACADIA"],
  // GMC
  "YUKON": ["YUKON", "YUKON XL", "TAHOE", "SUBURBAN"],
  "YUKON XL": ["YUKON", "YUKON XL", "SUBURBAN"],
  "ACADIA": ["ACADIA", "TRAVERSE"],
  // Jeep
  "GRAND CHEROKEE": ["GRAND CHEROKEE", "GRAND CHEROKEE L"],
  "GRAND CHEROKEE L": ["GRAND CHEROKEE", "GRAND CHEROKEE L"],
  "WRANGLER": ["WRANGLER", "WRANGLER UNLIMITED"],
  "WRANGLER UNLIMITED": ["WRANGLER", "WRANGLER UNLIMITED"],
  // Toyota
  "4RUNNER": ["4RUNNER", "GX460", "GX"],
  "TACOMA": ["TACOMA"],
  "TUNDRA": ["TUNDRA", "SEQUOIA"],
  "SEQUOIA": ["SEQUOIA", "TUNDRA"],
  // Lexus (Toyota platform)
  "GX460": ["GX460", "GX", "4RUNNER"],
  "GX": ["GX", "GX460", "4RUNNER"],
  "LX570": ["LX570", "LX", "LAND CRUISER"],
  "LX": ["LX", "LX570", "LAND CRUISER"],
  "LAND CRUISER": ["LAND CRUISER", "LX570", "LX"],
  // Honda/Acura
  "PILOT": ["PILOT", "MDX"],
  "MDX": ["MDX", "PILOT"],
  "ODYSSEY": ["ODYSSEY"],
  "CR-V": ["CR-V", "RDX"],
  "RDX": ["RDX", "CR-V"],
};

function getModelVariants(model: string): string[] {
  const normalized = model.toUpperCase().trim();
  return MODEL_VARIANTS[normalized] || [normalized];
}

function getMileageBucket(mileage: number): number {
  return Math.floor(mileage / 5000) * 5000;
}

function normalizeJobTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export async function getRepairPatternsCollection(): Promise<Collection<RepairPattern>> {
  const db = await getDb();
  return db.collection<RepairPattern>(COLLECTION_NAME);
}

interface UpdateRepairPatternInput {
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  jobTitle: string;
  laborAmount: number;
  partsAmount: number;
  totalAmount: number;
  laborHours: number;
  vin?: string;
  performedDate: Date;
}

/** Map a caller's mileage-based input to the PG repo's bucketed shape. */
function toPgUpdateParams(
  params: UpdateRepairPatternInput,
): pg.UpdateRepairPatternParams {
  return {
    shopId: params.shopId,
    enterpriseId: params.enterpriseId,
    year: params.year,
    make: params.make,
    model: params.model,
    mileageBucket: getMileageBucket(params.mileage),
    jobTitle: params.jobTitle,
    jobTitleNormalized: normalizeJobTitle(params.jobTitle),
    laborAmount: params.laborAmount,
    partsAmount: params.partsAmount,
    totalAmount: params.totalAmount,
    laborHours: params.laborHours,
    vin: params.vin,
    performedDate: params.performedDate,
  };
}

export async function updateRepairPattern(
  params: UpdateRepairPatternInput,
): Promise<void> {
  if (isRepairPatternsPgCanonical()) {
    await pg.updateRepairPattern(toPgUpdateParams(params));
    if (shouldShadowWriteMongoRepairPatterns()) {
      await shadowWriteMongoLegacyStore("shop_repair_patterns.update", () =>
        updateRepairPatternMongo(params),
      );
    }
    return;
  }
  await updateRepairPatternMongo(params);
}

/**
 * Ingestion-only batch path.
 *
 * `updateRepairPatternBatch` predates the normalized-ingestion caller and its
 * Mongo implementation only applies the counter update.  In particular, it
 * does not recompute the averages, so it cannot be used as a drop-in
 * replacement for the two updates made by `updateRepairPattern`.
 *
 * Mongo canonical mode uses one pipeline update per natural key.  Jobs with
 * the same key are folded in input order before the bulk write so that:
 *   - every duplicate job still increments occurrences;
 *   - the last job's title/enterprise value wins;
 *   - VINs retain add-to-set semantics and input order;
 *   - rolling hours averages match the sequential update, including jobs with
 *     no positive labor-hours value; and
 *   - one bad key does not prevent unrelated keys from being attempted.
 *
 * PG canonical mode deliberately remains sequential.  The PG repository's
 * existing batch helper is also sequential, and keeping this dispatch here
 * avoids changing canonical write ordering or shadow-write behavior.
 */
export async function updateRepairPatternsForIngestion(
  jobs: UpdateRepairPatternInput[],
): Promise<number> {
  if (jobs.length === 0) return 0;

  if (isRepairPatternsPgCanonical()) {
    let processed = 0;
    for (const job of jobs) {
      try {
        await updateRepairPattern(job);
        processed += 1;
      } catch (err) {
        // Match the existing per-job isolation of the ingestion caller.
        console.error(
          "[repair-patterns] ingestion PG update failed",
          repairPatternErrorCode(err),
        );
      }
    }
    return processed;
  }

  return updateRepairPatternsMongoForIngestion(jobs);
}

function repairPatternErrorCode(err: unknown): number {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && Number.isFinite(code) ? code : 0;
}

function isValidRepairPatternInput(
  params: UpdateRepairPatternInput,
): boolean {
  return Boolean(
    params &&
    Number.isFinite(params.shopId) &&
    Number.isFinite(params.year) &&
    typeof params.make === "string" &&
    typeof params.model === "string" &&
    Number.isFinite(params.mileage) &&
    typeof params.jobTitle === "string" &&
    Number.isFinite(params.laborAmount) &&
    Number.isFinite(params.partsAmount) &&
    Number.isFinite(params.totalAmount) &&
    Number.isFinite(params.laborHours) &&
    (params.enterpriseId === undefined ||
      typeof params.enterpriseId === "string") &&
    (params.vin === undefined || typeof params.vin === "string") &&
    params.performedDate instanceof Date &&
    Number.isFinite(params.performedDate.getTime()),
  );
}

async function updateRepairPatternMongo(params: {
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  jobTitle: string;
  laborAmount: number;
  partsAmount: number;
  totalAmount: number;
  laborHours: number;
  vin?: string;
  performedDate: Date;
}): Promise<void> {
  const collection = await getRepairPatternsCollection();
  const mileageBucket = getMileageBucket(params.mileage);
  const jobTitleNormalized = normalizeJobTitle(params.jobTitle);

  const key = {
    shopId: params.shopId,
    year: params.year,
    make: params.make.toUpperCase(),
    model: params.model.toUpperCase(),
    mileageBucket,
    jobTitleNormalized,
  };

  const now = new Date();

  const updateDoc: any = {
    $set: {
      jobTitle: params.jobTitle,
      enterpriseId: toObjectId(params.enterpriseId),
      updatedAt: now,
    },
    $inc: {
      occurrences: 1,
      totalLabor: params.laborAmount || 0,
      totalParts: params.partsAmount || 0,
      totalAmount: params.totalAmount || 0,
    },
    $max: {
      lastPerformed: params.performedDate,
    },
    $min: {
      firstPerformed: params.performedDate,
    },
    $setOnInsert: {
      createdAt: now,
      avgLabor: 0,
      avgParts: 0,
      avgTotal: 0,
      avgHours: 0,
    },
  };

  // $addToSet creates the array if it doesn't exist, so we don't need $setOnInsert for vinsSeen
  if (params.vin) {
    updateDoc.$addToSet = { vinsSeen: params.vin };
  }

  await collection.updateOne(key, updateDoc, { upsert: true });

  // Update averages in a second operation (MongoDB doesn't support computed fields in same update)
  await collection.updateOne(key, [
    {
      $set: {
        avgLabor: { $divide: ["$totalLabor", "$occurrences"] },
        avgParts: { $divide: ["$totalParts", "$occurrences"] },
        avgTotal: { $divide: ["$totalAmount", "$occurrences"] },
        avgHours: params.laborHours > 0 
          ? { $divide: [{ $add: [{ $multiply: ["$avgHours", { $subtract: ["$occurrences", 1] }] }, params.laborHours] }, "$occurrences"] }
          : "$avgHours",
      },
    },
  ]);
}

type RepairPatternKey = {
  shopId: number;
  year: number;
  make: string;
  model: string;
  mileageBucket: number;
  jobTitleNormalized: string;
};

interface RepairPatternIngestionGroup {
  filter: RepairPatternKey;
  jobs: UpdateRepairPatternInput[];
}

function repairPatternKey(params: UpdateRepairPatternInput): RepairPatternKey {
  return {
    shopId: params.shopId,
    year: params.year,
    make: params.make.toUpperCase(),
    model: params.model.toUpperCase(),
    mileageBucket: getMileageBucket(params.mileage),
    jobTitleNormalized: normalizeJobTitle(params.jobTitle),
  };
}

function repairPatternKeyId(key: RepairPatternKey): string {
  return [
    key.shopId,
    key.year,
    key.make,
    key.model,
    key.mileageBucket,
    key.jobTitleNormalized,
  ].join("\u0000");
}

function literal(value: unknown): { $literal: unknown } {
  return { $literal: value };
}

/**
 * Build the running-hours expression for one natural-key group.
 *
 * The single-write average cannot simply use the sum of positive hours:
 * updateRepairPattern keeps avgHours unchanged for a zero-hours job, while
 * that job still increases occurrences.  A later positive-hours job therefore
 * weights the unchanged average by the larger occurrence count. Applying that
 * recurrence in a constant-depth Mongo reducer preserves the behavior exactly
 * without another read round trip.
 */
function buildIngestionAvgHoursExpression(
  jobs: UpdateRepairPatternInput[],
): unknown {
  // Keep the expression depth constant even when a work order contains many
  // duplicate jobs. The reducer carries the same (avg, occurrence) pair that
  // updateRepairPattern updates one job at a time.
  return {
    $let: {
      vars: {
        result: {
          $reduce: {
            input: literal(jobs.map((job) => job.laborHours)),
            initialValue: {
              avg: { $ifNull: ["$avgHours", 0] },
              occurrences: { $ifNull: ["$occurrences", 0] },
            },
            in: {
              avg: {
                $cond: [
                  { $gt: ["$$this", 0] },
                  {
                    $divide: [
                      {
                        $add: [
                          {
                            $multiply: [
                              "$$value.avg",
                              "$$value.occurrences",
                            ],
                          },
                          "$$this",
                        ],
                      },
                      { $add: ["$$value.occurrences", 1] },
                    ],
                  },
                  "$$value.avg",
                ],
              },
              occurrences: {
                $add: ["$$value.occurrences", 1],
              },
            },
          },
        },
      },
      in: "$$result.avg",
    },
  };
}

function buildIngestionVinsExpression(
  jobs: UpdateRepairPatternInput[],
): unknown {
  const vins = jobs
    .map((job) => job.vin)
    .filter((vin): vin is string => Boolean(vin));

  // $addToSet preserves the existing array and appends newly observed values
  // in input order. $reduce makes that order explicit rather than depending on
  // the server's output-order choice for $setUnion.
  return {
    $reduce: {
      input: literal(vins),
      initialValue: { $ifNull: ["$vinsSeen", literal([])] },
      in: {
        $cond: [
          { $in: ["$$this", "$$value"] },
          "$$value",
          { $concatArrays: ["$$value", ["$$this"]] },
        ],
      },
    },
  };
}

function buildIngestionDateExpression(
  field: "lastPerformed" | "firstPerformed",
  value: Date,
): unknown {
  const comparison =
    field === "lastPerformed"
      ? { $gt: [literal(value), `$${field}`] }
      : { $lt: [literal(value), `$${field}`] };

  return {
    $cond: [
      {
        $or: [
          { $eq: [{ $type: `$${field}` }, "missing"] },
          { $eq: [`$${field}`, null] },
          comparison,
        ],
      },
      literal(value),
      `$${field}`,
    ],
  };
}

function buildIngestionPipeline(
  group: RepairPatternIngestionGroup,
  now: Date,
): unknown[] {
  const { filter, jobs } = group;
  const lastJob = jobs[jobs.length - 1];
  const lastPerformed = jobs.reduce(
    (latest, job) =>
      job.performedDate > latest ? job.performedDate : latest,
    jobs[0].performedDate,
  );
  const firstPerformed = jobs.reduce(
    (earliest, job) =>
      job.performedDate < earliest ? job.performedDate : earliest,
    jobs[0].performedDate,
  );

  const laborTotal = jobs.reduce(
    (sum, job) => sum + (job.laborAmount || 0),
    0,
  );
  const partsTotal = jobs.reduce(
    (sum, job) => sum + (job.partsAmount || 0),
    0,
  );
  const amountTotal = jobs.reduce(
    (sum, job) => sum + (job.totalAmount || 0),
    0,
  );
  const occurrences = { $ifNull: ["$occurrences", 0] };
  const newOccurrences = { $add: [occurrences, jobs.length] };

  const setStage: Record<string, unknown> = {
    shopId: filter.shopId,
    year: filter.year,
    make: literal(filter.make),
    model: literal(filter.model),
    mileageBucket: filter.mileageBucket,
    jobTitleNormalized: literal(filter.jobTitleNormalized),
    jobTitle: literal(lastJob.jobTitle),
    updatedAt: literal(now),
    createdAt: {
      $cond: [
        { $eq: [{ $type: "$createdAt" }, "missing"] },
        literal(now),
        "$createdAt",
      ],
    },
    occurrences: newOccurrences,
    totalLabor: {
      $add: [{ $ifNull: ["$totalLabor", 0] }, laborTotal],
    },
    totalParts: {
      $add: [{ $ifNull: ["$totalParts", 0] }, partsTotal],
    },
    totalAmount: {
      $add: [{ $ifNull: ["$totalAmount", 0] }, amountTotal],
    },
    avgHours: buildIngestionAvgHoursExpression(jobs),
    lastPerformed: buildIngestionDateExpression(
      "lastPerformed",
      lastPerformed,
    ),
    firstPerformed: buildIngestionDateExpression(
      "firstPerformed",
      firstPerformed,
    ),
    vinsSeen: buildIngestionVinsExpression(jobs),
    enterpriseId: literal(toObjectId(lastJob.enterpriseId) ?? null),
  };

  const averagesStage = {
    avgLabor: {
      $cond: [
        { $gt: ["$occurrences", 0] },
        { $divide: ["$totalLabor", "$occurrences"] },
        0,
      ],
    },
    avgParts: {
      $cond: [
        { $gt: ["$occurrences", 0] },
        { $divide: ["$totalParts", "$occurrences"] },
        0,
      ],
    },
    avgTotal: {
      $cond: [
        { $gt: ["$occurrences", 0] },
        { $divide: ["$totalAmount", "$occurrences"] },
        0,
      ],
    },
  };

  const pipeline: unknown[] = [
    { $set: setStage },
    { $set: averagesStage },
  ];

  return pipeline;
}

function bulkWriteErrorIndices(err: unknown): Set<number> {
  const direct = (err as { writeErrors?: unknown } | null)?.writeErrors;
  if (Array.isArray(direct)) {
    return new Set(
      direct
        .map((writeError) => (writeError as { index?: unknown })?.index)
        .filter((index): index is number => typeof index === "number"),
    );
  }

  const result = (err as { result?: { getWriteErrors?: () => unknown[] } } | null)
    ?.result;
  const nested = result?.getWriteErrors?.();
  if (!Array.isArray(nested)) return new Set();
  return new Set(
    nested
      .map((writeError) => (writeError as { index?: unknown })?.index)
      .filter((index): index is number => typeof index === "number"),
  );
}

async function updateRepairPatternsMongoForIngestion(
  jobs: UpdateRepairPatternInput[],
): Promise<number> {
  const validJobs: UpdateRepairPatternInput[] = [];
  let rejectedJobs = 0;
  for (const job of jobs) {
    if (isValidRepairPatternInput(job)) validJobs.push(job);
    else rejectedJobs += 1;
  }
  if (rejectedJobs > 0) {
    console.error("[repair-patterns] ingestion jobs rejected", rejectedJobs);
  }
  if (validJobs.length === 0) return 0;

  let collection: Collection<RepairPattern>;
  try {
    collection = await getRepairPatternsCollection();
  } catch (err) {
    console.error(
      "[repair-patterns] ingestion Mongo collection unavailable",
      repairPatternErrorCode(err),
    );
    return 0;
  }

  const groups = new Map<string, RepairPatternIngestionGroup>();

  let preparationFailures = 0;
  for (const job of validJobs) {
    try {
      const filter = repairPatternKey(job);
      const id = repairPatternKeyId(filter);
      const group = groups.get(id);
      if (group) group.jobs.push(job);
      else groups.set(id, { filter, jobs: [job] });
    } catch (err) {
      preparationFailures += 1;
    }
  }
  if (preparationFailures > 0) {
    console.error(
      "[repair-patterns] ingestion key preparation failed",
      preparationFailures,
    );
  }

  const now = new Date();
  const preparedGroups: RepairPatternIngestionGroup[] = [];
  const bulkOps: Array<{
    updateOne: {
      filter: RepairPatternKey;
      update: unknown[];
      upsert: true;
    };
  }> = [];
  for (const group of groups.values()) {
    try {
      bulkOps.push({
        updateOne: {
          filter: group.filter,
          update: buildIngestionPipeline(group, now),
          upsert: true,
        },
      });
      preparedGroups.push(group);
    } catch (err) {
      preparationFailures += 1;
    }
  }
  if (preparationFailures > 0) {
    console.error(
      "[repair-patterns] ingestion groups rejected",
      preparationFailures,
    );
  }

  if (bulkOps.length === 0) return 0;

  try {
    await collection.bulkWrite(bulkOps, { ordered: false });
    return preparedGroups.reduce((count, group) => count + group.jobs.length, 0);
  } catch (err) {
    const bulkError = err as {
      err?: unknown;
      writeConcernError?: unknown;
      result?: { getWriteConcernError?: () => unknown };
    };
    if (
      bulkError?.err ||
      bulkError?.writeConcernError ||
      bulkError?.result?.getWriteConcernError?.()
    ) {
      // An operation may have reached Mongo without satisfying write concern.
      // Never infer confirmed success from the other operation indexes.
      console.error("[repair-patterns] ingestion bulk confirmation unknown");
      return 0;
    }
    // unordered bulk writes attempt unrelated keys even when one key fails.
    // Mongo exposes the failed operation indexes on BulkWriteError; count all
    // other groups as processed and keep the ingestion itself non-fatal.
    const failedIndices = bulkWriteErrorIndices(err);
    if (failedIndices.size === 0) {
      console.error(
        "[repair-patterns] ingestion bulk write failed",
        repairPatternErrorCode(err),
      );
      return 0;
    }

    let processed = 0;
    let failedJobs = 0;
    preparedGroups.forEach((group, index) => {
      if (failedIndices.has(index)) {
        failedJobs += group.jobs.length;
      } else {
        processed += group.jobs.length;
      }
    });
    console.error("[repair-patterns] ingestion bulk keys failed", failedJobs);
    return processed;
  }
}

export async function updateRepairPatternBatch(jobs: Array<{
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  jobTitle: string;
  laborAmount: number;
  partsAmount: number;
  totalAmount: number;
  laborHours: number;
  vin?: string;
  performedDate: Date;
}>): Promise<number> {
  if (jobs.length === 0) return 0;

  if (isRepairPatternsPgCanonical()) {
    const n = await pg.updateRepairPatternBatch(jobs.map(toPgUpdateParams));
    if (shouldShadowWriteMongoRepairPatterns()) {
      await shadowWriteMongoLegacyStore("shop_repair_patterns.updateBatch", () =>
        updateRepairPatternBatchMongo(jobs),
      );
    }
    return n;
  }
  return updateRepairPatternBatchMongo(jobs);
}

async function updateRepairPatternBatchMongo(jobs: Array<{
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  jobTitle: string;
  laborAmount: number;
  partsAmount: number;
  totalAmount: number;
  laborHours: number;
  vin?: string;
  performedDate: Date;
}>): Promise<number> {
  const collection = await getRepairPatternsCollection();
  const now = new Date();
  
  const bulkOps = jobs.map(params => {
    const mileageBucket = getMileageBucket(params.mileage);
    const jobTitleNormalized = normalizeJobTitle(params.jobTitle);
    
    const filter = {
      shopId: params.shopId,
      year: params.year,
      make: params.make.toUpperCase(),
      model: params.model.toUpperCase(),
      mileageBucket,
      jobTitleNormalized,
    };
    
    const updateDoc: any = {
      $set: {
        jobTitle: params.jobTitle,
        enterpriseId: toObjectId(params.enterpriseId),
        updatedAt: now,
      },
      $inc: {
        occurrences: 1,
        totalLabor: params.laborAmount || 0,
        totalParts: params.partsAmount || 0,
        totalAmount: params.totalAmount || 0,
      },
      $max: {
        lastPerformed: params.performedDate,
      },
      $min: {
        firstPerformed: params.performedDate,
      },
      $setOnInsert: {
        createdAt: now,
        avgLabor: 0,
        avgParts: 0,
        avgTotal: 0,
        avgHours: 0,
      },
    };
    
    if (params.vin) {
      updateDoc.$addToSet = { vinsSeen: params.vin };
    }
    
    return {
      updateOne: {
        filter,
        update: updateDoc,
        upsert: true,
      },
    };
  });
  
  try {
    const result = await collection.bulkWrite(bulkOps, { ordered: false });
    return result.upsertedCount + result.modifiedCount;
  } catch (err) {
    console.error("Bulk write error:", err);
    return 0;
  }
}

export async function getShopPatterns(params: {
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  includeEnterprise?: boolean;
  limit?: number;
}): Promise<PatternMatch[]> {
  if (isRepairPatternsPgCanonical()) {
    const mileageBucket = getMileageBucket(params.mileage);
    const buckets = [mileageBucket - 5000, mileageBucket, mileageBucket + 5000].filter(b => b >= 0);
    const modelVariants = getModelVariants(params.model);
    const rows = await pg.getShopPatterns({
      shopId: params.shopId,
      enterpriseId: params.enterpriseId,
      year: params.year,
      make: params.make,
      model: params.model,
      buckets,
      modelVariants,
      includeEnterprise: params.includeEnterprise,
      limit: params.limit || 20,
    });
    return rows.map(p => ({
      jobTitle: p.jobTitle,
      occurrences: p.occurrences,
      avgTotal: Math.round(p.avgTotal * 100) / 100,
      avgHours: Math.round(p.avgHours * 10) / 10,
      avgLabor: Math.round(p.avgLabor * 100) / 100,
      avgParts: Math.round(p.avgParts * 100) / 100,
      lastPerformed: p.lastPerformed as Date,
      mileageBucket: p.mileageBucket ?? 0,
      uniqueVehicles: p.uniqueVehicles,
      confidence: p.occurrences >= 10 ? "high" : p.occurrences >= 5 ? "medium" : "low",
    }));
  }

  const collection = await getRepairPatternsCollection();
  const mileageBucket = getMileageBucket(params.mileage);
  
  // Search current bucket and adjacent buckets (±1 bucket = ±5k miles)
  const buckets = [mileageBucket - 5000, mileageBucket, mileageBucket + 5000].filter(b => b >= 0);

  const shopFilter: any = params.includeEnterprise && params.enterpriseId
    ? { enterpriseId: toObjectId(params.enterpriseId) }
    : { shopId: params.shopId };

  // Include related model variants (e.g., Expedition + Expedition Max)
  const modelVariants = getModelVariants(params.model);
  
  const patterns = await collection.find({
    ...shopFilter,
    year: params.year,
    make: params.make.toUpperCase(),
    model: { $in: modelVariants },
    mileageBucket: { $in: buckets },
    occurrences: { $gte: 2 }, // At least 2 occurrences to be a pattern
  })
    .sort({ occurrences: -1 })
    .limit(params.limit || 20)
    .toArray();

  return patterns.map(p => ({
    jobTitle: p.jobTitle,
    occurrences: p.occurrences,
    avgTotal: Math.round(p.avgTotal * 100) / 100,
    avgHours: Math.round(p.avgHours * 10) / 10,
    avgLabor: Math.round(p.avgLabor * 100) / 100,
    avgParts: Math.round(p.avgParts * 100) / 100,
    lastPerformed: p.lastPerformed,
    mileageBucket: p.mileageBucket,
    uniqueVehicles: p.vinsSeen?.length || 0,
    confidence: p.occurrences >= 10 ? "high" : p.occurrences >= 5 ? "medium" : "low",
  }));
}

export async function getEnterprisePatterns(params: {
  enterpriseId: string;
  year: number;
  make: string;
  model: string;
  mileage: number;
  limit?: number;
}): Promise<PatternMatch[]> {
  if (isRepairPatternsPgCanonical()) {
    const mileageBucket = getMileageBucket(params.mileage);
    const buckets = [mileageBucket - 5000, mileageBucket, mileageBucket + 5000].filter(b => b >= 0);
    const modelVariants = getModelVariants(params.model);
    const rows = await pg.getEnterprisePatterns({
      enterpriseId: params.enterpriseId,
      year: params.year,
      make: params.make,
      model: params.model,
      buckets,
      modelVariants,
      limit: params.limit || 20,
    });
    return rows.map(p => ({
      jobTitle: p.jobTitle,
      occurrences: p.occurrences,
      avgTotal: Math.round(p.avgTotal * 100) / 100,
      avgHours: 0, // Would need separate tracking for accurate enterprise hours
      avgLabor: Math.round(p.avgLabor * 100) / 100,
      avgParts: Math.round(p.avgParts * 100) / 100,
      lastPerformed: p.lastPerformed as Date,
      mileageBucket: p.mileageBucket ?? 0,
      uniqueVehicles: p.shopCount, // Simplified: count of shops that did this
      confidence: p.occurrences >= 10 ? "high" : p.occurrences >= 5 ? "medium" : "low",
    }));
  }

  const collection = await getRepairPatternsCollection();
  const mileageBucket = getMileageBucket(params.mileage);
  const buckets = [mileageBucket - 5000, mileageBucket, mileageBucket + 5000].filter(b => b >= 0);

  // Include related model variants (e.g., Expedition + Expedition Max)
  const modelVariants = getModelVariants(params.model);
  
  // Aggregate across all enterprise shops
  const pipeline = [
    {
      $match: {
        enterpriseId: toObjectId(params.enterpriseId),
        year: params.year,
        make: params.make.toUpperCase(),
        model: { $in: modelVariants },
        mileageBucket: { $in: buckets },
      },
    },
    {
      $group: {
        _id: "$jobTitleNormalized",
        jobTitle: { $first: "$jobTitle" },
        totalOccurrences: { $sum: "$occurrences" },
        totalLabor: { $sum: "$totalLabor" },
        totalParts: { $sum: "$totalParts" },
        totalAmount: { $sum: "$totalAmount" },
        lastPerformed: { $max: "$lastPerformed" },
        mileageBucket: { $first: "$mileageBucket" },
        allVins: { $push: "$vinsSeen" },
        shopCount: { $sum: 1 },
      },
    },
    {
      $match: {
        totalOccurrences: { $gte: 2 },
      },
    },
    {
      $project: {
        jobTitle: 1,
        occurrences: "$totalOccurrences",
        avgTotal: { $divide: ["$totalAmount", "$totalOccurrences"] },
        avgLabor: { $divide: ["$totalLabor", "$totalOccurrences"] },
        avgParts: { $divide: ["$totalParts", "$totalOccurrences"] },
        lastPerformed: 1,
        mileageBucket: 1,
        shopCount: 1,
      },
    },
    { $sort: { occurrences: -1 } },
    { $limit: params.limit || 20 },
  ];

  const results = await collection.aggregate(pipeline).toArray();

  return results.map((p: any) => ({
    jobTitle: p.jobTitle,
    occurrences: p.occurrences,
    avgTotal: Math.round(p.avgTotal * 100) / 100,
    avgHours: 0, // Would need separate tracking for accurate enterprise hours
    avgLabor: Math.round(p.avgLabor * 100) / 100,
    avgParts: Math.round(p.avgParts * 100) / 100,
    lastPerformed: p.lastPerformed,
    mileageBucket: p.mileageBucket,
    uniqueVehicles: p.shopCount, // Simplified: count of shops that did this
    confidence: p.occurrences >= 10 ? "high" : p.occurrences >= 5 ? "medium" : "low",
  }));
}

export async function setupRepairPatternsIndexes(): Promise<void> {
  // Mongo-only: the PG mirror's indexes are created by the drizzle migration
  // (drizzle/0025_task1000_package3.sql). When the domain is PG-canonical this
  // Mongo `createIndex` work must NOT run.
  if (isRepairPatternsPgCanonical()) {
    return;
  }

  const collection = await getRepairPatternsCollection();

  // Primary lookup index
  await collection.createIndex(
    { shopId: 1, year: 1, make: 1, model: 1, mileageBucket: 1, jobTitleNormalized: 1 },
    { unique: true, name: "shop_vehicle_job_unique" }
  );

  // Enterprise aggregation index
  await collection.createIndex(
    { enterpriseId: 1, year: 1, make: 1, model: 1, mileageBucket: 1 },
    { name: "enterprise_vehicle_lookup" }
  );

  // High-occurrence patterns
  await collection.createIndex(
    { shopId: 1, occurrences: -1 },
    { name: "shop_top_patterns" }
  );

  console.log("Repair patterns indexes created");
}
