import { getDb } from "./mongo";
import { Collection, ObjectId } from "mongodb";

export interface RepairPattern {
  _id?: ObjectId;
  shopId: number;
  enterpriseId?: number;
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

function getMileageBucket(mileage: number): number {
  return Math.floor(mileage / 5000) * 5;
}

function normalizeJobTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export async function getRepairPatternsCollection(): Promise<Collection<RepairPattern>> {
  const db = await getDb();
  return db.collection<RepairPattern>(COLLECTION_NAME);
}

export async function updateRepairPattern(params: {
  shopId: number;
  enterpriseId?: number;
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
      enterpriseId: params.enterpriseId,
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

export async function updateRepairPatternBatch(jobs: Array<{
  shopId: number;
  enterpriseId?: number;
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
  let updated = 0;
  for (const job of jobs) {
    try {
      await updateRepairPattern(job);
      updated++;
    } catch (err) {
      console.error("Failed to update repair pattern:", err);
    }
  }
  return updated;
}

export async function getShopPatterns(params: {
  shopId: number;
  enterpriseId?: number;
  year: number;
  make: string;
  model: string;
  mileage: number;
  includeEnterprise?: boolean;
  limit?: number;
}): Promise<PatternMatch[]> {
  const collection = await getRepairPatternsCollection();
  const mileageBucket = getMileageBucket(params.mileage);
  
  // Search current bucket and adjacent buckets (±1 bucket = ±5k miles)
  const buckets = [mileageBucket - 5, mileageBucket, mileageBucket + 5].filter(b => b >= 0);

  const shopFilter: any = params.includeEnterprise && params.enterpriseId
    ? { enterpriseId: params.enterpriseId }
    : { shopId: params.shopId };

  const patterns = await collection.find({
    ...shopFilter,
    year: params.year,
    make: params.make.toUpperCase(),
    model: params.model.toUpperCase(),
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
  enterpriseId: number;
  year: number;
  make: string;
  model: string;
  mileage: number;
  limit?: number;
}): Promise<PatternMatch[]> {
  const collection = await getRepairPatternsCollection();
  const mileageBucket = getMileageBucket(params.mileage);
  const buckets = [mileageBucket - 5, mileageBucket, mileageBucket + 5].filter(b => b >= 0);

  // Aggregate across all enterprise shops
  const pipeline = [
    {
      $match: {
        enterpriseId: params.enterpriseId,
        year: params.year,
        make: params.make.toUpperCase(),
        model: params.model.toUpperCase(),
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
