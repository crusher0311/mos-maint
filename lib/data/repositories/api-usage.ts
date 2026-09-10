// Repository for the `api_usage` and `api_rate_limits` collections.
//
// These collections back the cross-worker rate limiter and the
// observability dashboards. Callers stay narrow: insert records,
// claim/release rate-limit slots, and run a small set of stats
// queries.
import type { Collection, Document, Filter, ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/data/db";
import { shadowWriteMongoIntegrationOps } from "@/lib/db/integration-ops-write-mode";
import {
  pgAvgLatency,
  pgClaimRateLimitSlot,
  pgCountUsage,
  pgInsertUsageRecords,
  pgRecent429s,
  pgReleaseRateLimitSlot,
  pgTopShops,
} from "@/lib/data/repositories/pg/api-usage";

const USAGE_COLLECTION = "api_usage";
const RATE_LIMIT_COLLECTION = "api_rate_limits";
const PROTRACTOR_CALLBACK_TRANSPORT_KEY = "protractor-callback-transport";
const PROTRACTOR_PHYSICAL_TRANSPORT_KEY = "protractor-physical-transport-v1";
export const PROTRACTOR_PHYSICAL_TRANSPORT_INTERVAL_MS = 1000;
const PROTRACTOR_PHYSICAL_TRANSPORT_LEASE_MS = 180_000;

export const __protractorPhysicalTransportTestHooks: {
  getDb: typeof getDb;
  randomUUID: () => string;
} = {
  getDb,
  randomUUID,
};

/**
 * Flag helpers for the api-usage cutover (task #999), local to this repo
 * per the ops-store convention (mirroring
 * `lib/db/integration-cache-write-mode.ts`): the schema/foundation adds
 * no new flag to `lib/db/*`, so polarity + shadow-write live here.
 *
 *   API_USAGE_PG_CANONICAL === "1"  → PG is canonical (read/write PG,
 *                                     shadow-write Mongo). Default OFF
 *                                     keeps byte-identical Mongo
 *                                     behaviour.
 *   WRITE_MONGO_API_USAGE !== "0"   → keep the Mongo shadow write on
 *                                     during the post-flip soak.
 */
function isApiUsagePgCanonical(): boolean {
  return process.env.API_USAGE_PG_CANONICAL === "1";
}
function shouldShadowWriteMongoApiUsage(): boolean {
  return process.env.WRITE_MONGO_API_USAGE !== "0";
}

export interface ApiUsageRecord extends Document {
  _id?: ObjectId;
  provider: string;
  shopId?: number | null;
  shopName?: string;
  endpoint: string;
  method: string;
  statusCode: number;
  isError: boolean;
  isRateLimited?: boolean;
  errorMessage?: string;
  errorCode?: string;
  latencyMs: number;
  requestId?: string;
  sourceWorker?: string;
  timestamp: Date;
}

type UsageFilter = Filter<Document>;

export interface RateLimitRecord {
  _id: string;
  count: number;
  createdAt?: Date;
  expiresAt?: Date;
}

export interface ProtractorOperatorStopState {
  active: boolean;
  stopId?: string;
  reason?: string;
  changedBy?: string;
  activatedAt?: Date;
  updatedAt?: Date;
  physicalAdmissionInFlight: boolean;
  canary?: ProtractorCanaryState;
  canaryHistory: ProtractorCanaryState[];
}

export interface ProtractorCanaryState {
  generation: string;
  expiresAt: Date;
  maxAdmissions: number;
  consumedAdmissions: number;
  remainingAdmissions: number;
  endedBy?: "time" | "budget" | "operator";
  endedAt?: Date;
  audit: Array<{
    event: "opened" | "admitted" | "ended" | "operator_stop";
    at: Date;
    generation: string;
    consumedAdmissions: number;
    remainingAdmissions: number;
    endedBy?: "time" | "budget" | "operator";
  }>;
}

function projectProtractorStopState(row: any, now: Date): ProtractorOperatorStopState {
  const state = row?.operatorStop;
  const projectCanary = (canary: any): ProtractorCanaryState => {
    let endedBy = canary?.endedBy as "time" | "budget" | "operator" | undefined;
    if (!endedBy && canary) {
      if (state?.active === true && canary === row?.canary) endedBy = "operator";
      else if ((canary.consumedAdmissions ?? 0) >= (canary.maxAdmissions ?? 0)) endedBy = "budget";
      else if (canary.expiresAt instanceof Date && canary.expiresAt.getTime() <= now.getTime()) endedBy = "time";
    }
    return {
      generation: canary.generation,
      expiresAt: canary.expiresAt,
      maxAdmissions: canary.maxAdmissions,
      consumedAdmissions: canary.consumedAdmissions ?? 0,
      remainingAdmissions: Math.max(
        0,
        (canary.maxAdmissions ?? 0) - (canary.consumedAdmissions ?? 0),
      ),
      endedBy,
      endedAt: canary.endedAt ?? (endedBy === "time" ? canary.expiresAt : undefined),
      audit: Array.isArray(canary.audit) ? canary.audit : [],
    };
  };
  const canary = row?.canary;
  let endedBy = canary?.endedBy as "time" | "budget" | "operator" | undefined;
  if (!endedBy && canary) {
    if (state?.active === true) endedBy = "operator";
    else if ((canary.consumedAdmissions ?? 0) >= (canary.maxAdmissions ?? 0)) endedBy = "budget";
    else if (canary.expiresAt instanceof Date && canary.expiresAt.getTime() <= now.getTime()) endedBy = "time";
  }
  return {
    active: state?.active === true,
    stopId: state?.stopId,
    reason: state?.reason,
    changedBy: state?.changedBy,
    activatedAt: state?.activatedAt,
    updatedAt: state?.updatedAt,
    physicalAdmissionInFlight:
      Boolean(row?.physicalAdmissionOwnerToken) &&
      row?.leaseExpiresAt instanceof Date &&
      row.leaseExpiresAt.getTime() > now.getTime(),
    canary: canary ? { ...projectCanary(canary), endedBy } : undefined,
    canaryHistory: Array.isArray(row?.canaryHistory)
      ? row.canaryHistory.map(projectCanary)
      : [],
  };
}

async function finalizeProtractorCanaryTerminalState(
  col: Collection<any>,
): Promise<any | null> {
  return col.findOneAndUpdate(
    {
      _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
      "operatorStop.active": { $ne: true },
      "canary.generation": { $type: "string" },
      "canary.expiresAt": { $type: "date" },
      "canary.maxAdmissions": { $type: "number" },
      "canary.consumedAdmissions": { $type: "number" },
      "canary.endedBy": { $exists: false },
      $or: [
        { "canary.audit": { $exists: false } },
        { "canary.audit": { $type: "array" } },
      ],
      $expr: {
        $or: [
          { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
          { $lte: ["$canary.expiresAt", "$$NOW"] },
        ],
      },
    },
    [{
      $set: {
        "canary.endedBy": {
          $cond: [
            { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
            "budget",
            "time",
          ],
        },
        "canary.endedAt": {
          $cond: [
            { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
            "$$NOW",
            "$canary.expiresAt",
          ],
        },
        "canary.audit": {
          $concatArrays: [
            { $ifNull: ["$canary.audit", []] },
            [{
              event: "ended",
              at: {
                $cond: [
                  { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
                  "$$NOW",
                  "$canary.expiresAt",
                ],
              },
              generation: "$canary.generation",
              consumedAdmissions: "$canary.consumedAdmissions",
              remainingAdmissions: {
                $max: [
                  0,
                  { $subtract: ["$canary.maxAdmissions", "$canary.consumedAdmissions"] },
                ],
              },
              endedBy: {
                $cond: [
                  { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
                  "budget",
                  "time",
                ],
              },
            }],
          ],
        },
      },
    }],
    { returnDocument: "after", maxTimeMS: 1000 },
  );
}

async function usageCollection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(USAGE_COLLECTION);
}

async function rateLimitCollection(): Promise<Collection<RateLimitRecord>> {
  const db = await getDb();
  return db.collection<RateLimitRecord>(RATE_LIMIT_COLLECTION);
}

export async function insertUsageRecords(records: Document[]): Promise<void> {
  if (records.length === 0) return;
  if (isApiUsagePgCanonical()) {
    await pgInsertUsageRecords(records.map((r) => ({ ...r })));
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoApiUsage,
      "api_usage.insert",
      async () => {
        const col = await usageCollection();
        await col.insertMany(records.map((r) => ({ ...r })));
      },
    );
    return;
  }
  const col = await usageCollection();
  await col.insertMany(records.map((r) => ({ ...r })));
}

export interface RateLimitClaimResult {
  count: number;
}

export async function claimRateLimitSlot(
  key: string,
  expiresAt: Date,
): Promise<RateLimitClaimResult> {
  if (isApiUsagePgCanonical()) {
    const result = await pgClaimRateLimitSlot(key, expiresAt);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoApiUsage,
      "api_rate_limits.claim",
      async () => {
        const col = await rateLimitCollection();
        await col.updateOne(
          { _id: key },
          {
            $inc: { count: 1 },
            $setOnInsert: { createdAt: new Date(), expiresAt },
          },
          { upsert: true },
        );
      },
    );
    return result;
  }
  const col = await rateLimitCollection();
  const result = await col.findOneAndUpdate(
    { _id: key },
    {
      $inc: { count: 1 },
      $setOnInsert: { createdAt: new Date(), expiresAt },
    },
    { upsert: true, returnDocument: "after" },
  );
  return { count: result?.count ?? 1 };
}

export async function releaseRateLimitSlot(key: string): Promise<void> {
  if (isApiUsagePgCanonical()) {
    await pgReleaseRateLimitSlot(key);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoApiUsage,
      "api_rate_limits.release",
      async () => {
        const col = await rateLimitCollection();
        await col.updateOne({ _id: key }, { $inc: { count: -1 } });
      },
    );
    return;
  }
  const col = await rateLimitCollection();
  await col.updateOne({ _id: key }, { $inc: { count: -1 } });
}

async function initializeTransportLease(
  key: string,
  getDatabase: typeof getDb = getDb,
): Promise<void> {
  const db = await getDatabase();
  const col = db.collection<any>(RATE_LIMIT_COLLECTION);
  try {
    await col.updateOne(
      { _id: key },
      {
        $setOnInsert: {
          count: 0,
          createdAt: new Date(),
          nextAllowedAt: new Date(0),
          leaseExpiresAt: new Date(0),
        },
        ...(key === PROTRACTOR_PHYSICAL_TRANSPORT_KEY
          ? { $unset: { expiresAt: "" } }
          : {}),
      },
      { upsert: true, maxTimeMS: 1000 },
    );
  } catch (error: any) {
    if (!/duplicate key/i.test(String(error?.message || error))) throw error;
  }
}

async function acquireTransportLease(
  key: string,
  deadlineMs: number,
  leaseDurationMs: number,
): Promise<string | null> {
  await initializeTransportLease(key);
  const db = await getDb();
  const col = db.collection<any>(RATE_LIMIT_COLLECTION);
  while (Date.now() < deadlineMs) {
    const token = randomUUID();
    try {
      const row = await col.findOneAndUpdate(
        {
          _id: key,
          $expr: {
            $and: [
              { $lte: [{ $ifNull: ["$nextAllowedAt", "$$NOW"] }, "$$NOW"] },
              { $lte: [{ $ifNull: ["$leaseExpiresAt", "$$NOW"] }, "$$NOW"] },
            ],
          },
        },
        [{
          $set: {
            count: { $ifNull: ["$count", 0] },
            createdAt: { $ifNull: ["$createdAt", "$$NOW"] },
            ownerToken: token,
            leaseExpiresAt: {
              $dateAdd: { startDate: "$$NOW", unit: "millisecond", amount: leaseDurationMs },
            },
            expiresAt: { $dateAdd: { startDate: "$$NOW", unit: "day", amount: 1 } },
          },
        }],
        { upsert: false, returnDocument: "after", maxTimeMS: 1000 },
      );
      if (row?.ownerToken === token) return token;
    } catch (error: any) {
      if (!/duplicate key/i.test(String(error?.message || error))) throw error;
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
  return null;
}

async function releaseTransportLease(
  key: string,
  ownerToken: string,
  nextIntervalMs: number,
): Promise<void> {
  const db = await getDb();
  await db.collection<any>(RATE_LIMIT_COLLECTION).updateOne(
    { _id: key, ownerToken },
    [{
      $set: {
        ownerToken: "$$REMOVE",
        leaseExpiresAt: "$$REMOVE",
        nextAllowedAt: {
          $dateAdd: { startDate: "$$NOW", unit: "millisecond", amount: nextIntervalMs },
        },
      },
    }],
    { maxTimeMS: 1000 },
  );
}

async function renewTransportLease(
  key: string,
  ownerToken: string,
  leaseDurationMs: number,
): Promise<boolean> {
  const db = await getDb();
  const row = await db.collection<any>(RATE_LIMIT_COLLECTION).findOneAndUpdate(
    {
      _id: key,
      ownerToken,
      leaseExpiresAt: { $gt: new Date() },
    },
    [{
      $set: {
        leaseExpiresAt: {
          $dateAdd: { startDate: "$$NOW", unit: "millisecond", amount: leaseDurationMs },
        },
        expiresAt: { $dateAdd: { startDate: "$$NOW", unit: "day", amount: 1 } },
      },
    }],
    { returnDocument: "after", maxTimeMS: 1000 },
  );
  return row?.ownerToken === ownerToken;
}

/**
 * Canonical Mongo CAS lease for callback transport attempts. This primitive is
 * intentionally Mongo-owned regardless of api-usage cutover flags so every
 * replica contends on exactly one fleet record.
 */
export async function acquireCallbackTransportLease(deadlineMs: number): Promise<string | null> {
  return acquireTransportLease(PROTRACTOR_CALLBACK_TRANSPORT_KEY, deadlineMs, 90_000);
}

export async function releaseCallbackTransportLease(ownerToken: string): Promise<void> {
  return releaseTransportLease(PROTRACTOR_CALLBACK_TRANSPORT_KEY, ownerToken, 1000);
}

/**
 * Provider-wide hard pacer for every Protractor physical REST/SOAP attempt.
 * The lease is held through the relay response, so requests cannot overlap,
 * accumulate credits, or bunch at a fixed-window boundary. A crashed owner
 * fails closed until the lease expires beyond the longest relay deadline.
 */
export async function acquireProtractorPhysicalTransportLease(
  deadlineMs: number,
): Promise<string | null> {
  await initializeTransportLease(
    PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
    __protractorPhysicalTransportTestHooks.getDb,
  );
  const db = await __protractorPhysicalTransportTestHooks.getDb();
  const col = db.collection<any>(RATE_LIMIT_COLLECTION);
  while (Date.now() < deadlineMs) {
    const token = __protractorPhysicalTransportTestHooks.randomUUID();
    const row = await col.findOneAndUpdate(
      {
        _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
        "operatorStop.active": { $ne: true },
        $expr: {
          $and: [
              {
                $or: [
                  { $eq: [{ $type: "$canary" }, "missing"] },
                  {
                    $and: [
                      { $eq: [{ $type: "$canary.generation" }, "string"] },
                      { $eq: [{ $type: "$canary.expiresAt" }, "date"] },
                      { $in: [{ $type: "$canary.maxAdmissions" }, ["int", "long", "double", "decimal"]] },
                      { $in: [{ $type: "$canary.consumedAdmissions" }, ["int", "long", "double", "decimal"]] },
                      { $in: [{ $type: "$canary.audit" }, ["missing", "array"]] },
                      { $eq: [{ $type: "$canary.endedBy" }, "missing"] },
                      { $gt: ["$canary.expiresAt", "$$NOW"] },
                      { $lt: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
                    ],
                  },
                ],
              },
            { $lte: [{ $ifNull: ["$nextAllowedAt", "$$NOW"] }, "$$NOW"] },
            { $lte: [{ $ifNull: ["$leaseExpiresAt", "$$NOW"] }, "$$NOW"] },
          ],
        },
      },
      [{
        $set: {
          count: { $ifNull: ["$count", 0] },
          createdAt: { $ifNull: ["$createdAt", "$$NOW"] },
          ownerToken: token,
          ownerCanaryGeneration: {
            $cond: [
              { $eq: [{ $type: "$canary.generation" }, "string"] },
              "$canary.generation",
              "$$REMOVE",
            ],
          },
          physicalAdmissionStartedAt: "$$REMOVE",
          physicalAdmissionOwnerToken: "$$REMOVE",
          leaseExpiresAt: {
            $dateAdd: {
              startDate: "$$NOW",
              unit: "millisecond",
              amount: PROTRACTOR_PHYSICAL_TRANSPORT_LEASE_MS,
            },
          },
          expiresAt: "$$REMOVE",
        },
      }],
      { returnDocument: "after", maxTimeMS: 1000 },
    );
    if (row?.ownerToken === token) return token;
    const terminal = await finalizeProtractorCanaryTerminalState(col);
    if (terminal) return null;
    const state = await col.findOne(
      {
        _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
      },
      {
        projection: {
          operatorStop: 1,
          canary: 1,
        },
        maxTimeMS: 1000,
      },
    );
    if (state?.operatorStop?.active === true) return null;
    const hasCanary = Boolean(
      state && Object.prototype.hasOwnProperty.call(state, "canary"),
    );
    if (
      hasCanary &&
      (
        state?.canary?.endedBy ||
        typeof state?.canary?.generation !== "string" ||
        !(state?.canary?.expiresAt instanceof Date) ||
        typeof state?.canary?.maxAdmissions !== "number" ||
        typeof state?.canary?.consumedAdmissions !== "number" ||
        state.canary.expiresAt.getTime() <= Date.now() ||
        state.canary.consumedAdmissions >= state.canary.maxAdmissions
      )
    ) return null;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return null;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
  }
  return null;
}

export async function confirmProtractorPhysicalTransportLease(
  ownerToken: string,
): Promise<boolean> {
  const db = await __protractorPhysicalTransportTestHooks.getDb();
  const col = db.collection<any>(RATE_LIMIT_COLLECTION);
  // This update is the atomic physical-admission boundary. Operator activation
  // and dispatch contend on the same document: whichever commits first wins.
  // If dispatch wins, activation still blocks every subsequent lease/dispatch.
  const row = await col.findOneAndUpdate(
    {
      _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
      ownerToken,
      leaseExpiresAt: { $gt: new Date() },
      "operatorStop.active": { $ne: true },
      physicalAdmissionOwnerToken: { $ne: ownerToken },
      $expr: {
        $or: [
          { $eq: [{ $type: "$canary" }, "missing"] },
          {
            $and: [
              { $eq: [{ $type: "$canary.generation" }, "string"] },
              { $eq: [{ $type: "$canary.expiresAt" }, "date"] },
              { $in: [{ $type: "$canary.maxAdmissions" }, ["int", "long", "double", "decimal"]] },
              { $in: [{ $type: "$canary.consumedAdmissions" }, ["int", "long", "double", "decimal"]] },
              { $in: [{ $type: "$canary.audit" }, ["missing", "array"]] },
              { $eq: [{ $type: "$canary.endedBy" }, "missing"] },
              { $eq: ["$ownerCanaryGeneration", "$canary.generation"] },
              { $gt: ["$canary.expiresAt", "$$NOW"] },
              { $lt: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
            ],
          },
        ],
      },
    },
    [{
      $set: {
        physicalAdmissionStartedAt: "$$NOW",
        physicalAdmissionOwnerToken: { $literal: ownerToken },
        "canary.consumedAdmissions": {
          $cond: [
            { $eq: [{ $type: "$canary" }, "missing"] },
            "$$REMOVE",
            { $add: [{ $ifNull: ["$canary.consumedAdmissions", 0] }, 1] },
          ],
        },
        "canary.endedBy": {
          $cond: [
            { $eq: [{ $type: "$canary" }, "missing"] },
            "$$REMOVE",
            {
              $cond: [
                {
                  $gte: [
                    { $add: [{ $ifNull: ["$canary.consumedAdmissions", 0] }, 1] },
                    "$canary.maxAdmissions",
                  ],
                },
                "budget",
                "$$REMOVE",
              ],
            },
          ],
        },
        "canary.endedAt": {
          $cond: [
            { $eq: [{ $type: "$canary" }, "missing"] },
            "$$REMOVE",
            {
              $cond: [
                {
                  $gte: [
                    { $add: [{ $ifNull: ["$canary.consumedAdmissions", 0] }, 1] },
                    "$canary.maxAdmissions",
                  ],
                },
                "$$NOW",
                "$$REMOVE",
              ],
            },
          ],
        },
        "canary.audit": {
          $cond: [
            { $eq: [{ $type: "$canary" }, "missing"] },
            "$$REMOVE",
            {
              $concatArrays: [
                { $ifNull: ["$canary.audit", []] },
                [{
              event: {
                $cond: [
                  {
                    $gte: [
                      { $add: [{ $ifNull: ["$canary.consumedAdmissions", 0] }, 1] },
                      "$canary.maxAdmissions",
                    ],
                  },
                  "ended",
                  "admitted",
                ],
              },
              at: "$$NOW",
              generation: "$canary.generation",
              consumedAdmissions: {
                $add: [{ $ifNull: ["$canary.consumedAdmissions", 0] }, 1],
              },
              remainingAdmissions: {
                $max: [
                  0,
                  {
                    $subtract: [
                      "$canary.maxAdmissions",
                      { $add: [{ $ifNull: ["$canary.consumedAdmissions", 0] }, 1] },
                    ],
                  },
                ],
              },
              endedBy: {
                $cond: [
                  {
                    $gte: [
                      { $add: [{ $ifNull: ["$canary.consumedAdmissions", 0] }, 1] },
                      "$canary.maxAdmissions",
                    ],
                  },
                  "budget",
                  null,
                ],
              },
                }],
              ],
            },
          ],
        },
      },
    }],
    { returnDocument: "after", maxTimeMS: 1000 },
  );
  if (!row) await finalizeProtractorCanaryTerminalState(col);
  return row?.ownerToken === ownerToken;
}

export async function renewProtractorPhysicalTransportLease(
  ownerToken: string,
): Promise<boolean> {
  const db = await __protractorPhysicalTransportTestHooks.getDb();
  const row = await db.collection<any>(RATE_LIMIT_COLLECTION).findOneAndUpdate(
    {
      _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
      ownerToken,
      leaseExpiresAt: { $gt: new Date() },
    },
    [{
      $set: {
        leaseExpiresAt: {
          $dateAdd: {
            startDate: "$$NOW",
            unit: "millisecond",
            amount: PROTRACTOR_PHYSICAL_TRANSPORT_LEASE_MS,
          },
        },
        expiresAt: "$$REMOVE",
      },
    }],
    { returnDocument: "after", maxTimeMS: 1000 },
  );
  return row?.ownerToken === ownerToken;
}

export async function releaseProtractorPhysicalTransportLease(ownerToken: string): Promise<void> {
  const db = await __protractorPhysicalTransportTestHooks.getDb();
  await db.collection<any>(RATE_LIMIT_COLLECTION).updateOne(
    { _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY, ownerToken },
    [{
      $set: {
        ownerToken: "$$REMOVE",
        ownerCanaryGeneration: "$$REMOVE",
        leaseExpiresAt: "$$REMOVE",
        physicalAdmissionStartedAt: "$$REMOVE",
        physicalAdmissionOwnerToken: "$$REMOVE",
        nextAllowedAt: {
          $dateAdd: {
            startDate: "$$NOW",
            unit: "millisecond",
            amount: PROTRACTOR_PHYSICAL_TRANSPORT_INTERVAL_MS,
          },
        },
      },
    }],
    { maxTimeMS: 1000 },
  );
}

export async function getProtractorOperatorStop(): Promise<ProtractorOperatorStopState> {
  await initializeTransportLease(
    PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
    __protractorPhysicalTransportTestHooks.getDb,
  );
  const db = await __protractorPhysicalTransportTestHooks.getDb();
  const now = new Date();
  const col = db.collection<any>(RATE_LIMIT_COLLECTION);
  await finalizeProtractorCanaryTerminalState(col);
  const row = await col.findOne(
    { _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY },
    {
      projection: {
        operatorStop: 1,
        canary: 1,
          canaryHistory: 1,
        physicalAdmissionOwnerToken: 1,
        leaseExpiresAt: 1,
      },
      maxTimeMS: 1000,
    },
  );
  return projectProtractorStopState(row, now);
}

export async function activateProtractorOperatorStop(input: {
  changedBy: string;
  reason: string;
  now?: Date;
}): Promise<ProtractorOperatorStopState> {
  const changedBy = input.changedBy.trim();
  const reason = input.reason.trim();
  if (!changedBy) throw new Error("changedBy is required");
  if (!reason) throw new Error("reason is required");
  await initializeTransportLease(
    PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
    __protractorPhysicalTransportTestHooks.getDb,
  );
  const db = await __protractorPhysicalTransportTestHooks.getDb();
  const now = input.now ?? new Date();
  const pipelineNow = input.now ?? "$$NOW";
  const stopId = __protractorPhysicalTransportTestHooks.randomUUID();
  const row = await db.collection<any>(RATE_LIMIT_COLLECTION).findOneAndUpdate(
    { _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY },
    [{
      $set: {
        operatorStop: {
          active: true,
          stopId,
          reason: { $literal: reason },
          changedBy: { $literal: changedBy },
          activatedAt: pipelineNow,
          updatedAt: pipelineNow,
        },
        canary: {
          $cond: [
            { $eq: [{ $type: "$canary.generation" }, "string"] },
            {
              $mergeObjects: [
                "$canary",
                {
                  endedBy: {
                    $ifNull: [
                      "$canary.endedBy",
                      {
                        $switch: {
                          branches: [
                            {
                              case: {
                                $gte: [
                                  "$canary.consumedAdmissions",
                                  "$canary.maxAdmissions",
                                ],
                              },
                              then: "budget",
                            },
                            {
                              case: { $lte: ["$canary.expiresAt", pipelineNow] },
                              then: "time",
                            },
                          ],
                          default: "operator",
                        },
                      },
                    ],
                  },
                  endedAt: {
                    $ifNull: [
                      "$canary.endedAt",
                      {
                        $cond: [
                          { $lte: ["$canary.expiresAt", pipelineNow] },
                          "$canary.expiresAt",
                          pipelineNow,
                        ],
                      },
                    ],
                  },
                  audit: {
                    $concatArrays: [
                      { $ifNull: ["$canary.audit", []] },
                      [{
                        event: "operator_stop",
                        at: pipelineNow,
                        generation: "$canary.generation",
                        consumedAdmissions: "$canary.consumedAdmissions",
                        remainingAdmissions: {
                          $max: [
                            0,
                            {
                              $subtract: [
                                "$canary.maxAdmissions",
                                "$canary.consumedAdmissions",
                              ],
                            },
                          ],
                        },
                        endedBy: {
                          $ifNull: [
                            "$canary.endedBy",
                            {
                              $switch: {
                                branches: [
                                  {
                                    case: {
                                      $gte: [
                                        "$canary.consumedAdmissions",
                                        "$canary.maxAdmissions",
                                      ],
                                    },
                                    then: "budget",
                                  },
                                  {
                                    case: { $lte: ["$canary.expiresAt", pipelineNow] },
                                    then: "time",
                                  },
                                ],
                                default: "operator",
                              },
                            },
                          ],
                        },
                      }],
                    ],
                  },
                },
              ],
            },
            "$$REMOVE",
          ],
        },
        expiresAt: "$$REMOVE",
      },
    }],
    { returnDocument: "after", maxTimeMS: 1000 },
  );
  return projectProtractorStopState(row, now);
}

export async function clearProtractorOperatorStop(input: {
  changedBy: string;
  expectedStopId: string;
  reason: string;
  expiresAt: Date;
  maxAdmissions: number;
  now?: Date;
}): Promise<ProtractorOperatorStopState> {
  const changedBy = input.changedBy.trim();
  const reason = input.reason.trim();
  const expectedStopId = input.expectedStopId.trim();
  if (!changedBy || !reason || !expectedStopId) {
    throw new Error("changedBy, reason, and expectedStopId are required");
  }
  const db = await __protractorPhysicalTransportTestHooks.getDb();
  const now = input.now ?? new Date();
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= now.getTime()) {
    throw new Error("expiresAt must be a future date");
  }
  if (!Number.isInteger(input.maxAdmissions) || input.maxAdmissions < 1 || input.maxAdmissions > 3) {
    throw new Error("maxAdmissions must be an integer from 1 to 3");
  }
  const generation = __protractorPhysicalTransportTestHooks.randomUUID();
  const row = await db.collection<any>(RATE_LIMIT_COLLECTION).findOneAndUpdate(
    {
      _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
      "operatorStop.active": true,
      "operatorStop.stopId": expectedStopId,
    },
    [{
      $set: {
        operatorStop: {
          active: false,
          stopId: { $literal: expectedStopId },
          reason: { $literal: reason },
          changedBy: { $literal: changedBy },
          clearedAt: now,
          updatedAt: now,
        },
        canaryHistory: {
          $cond: [
            {
              $and: [
                { $eq: [{ $type: "$canary.generation" }, "string"] },
                { $eq: [{ $type: "$canary.expiresAt" }, "date"] },
                { $in: [{ $type: "$canary.maxAdmissions" }, ["int", "long", "double", "decimal"]] },
                { $in: [{ $type: "$canary.consumedAdmissions" }, ["int", "long", "double", "decimal"]] },
                { $in: ["$canary.endedBy", ["time", "budget", "operator"]] },
                { $eq: [{ $type: "$canary.endedAt" }, "date"] },
                { $isArray: "$canary.audit" },
              ],
            },
            {
              $slice: [
                {
                  $concatArrays: [
                    { $cond: [{ $isArray: "$canaryHistory" }, "$canaryHistory", []] },
                    ["$canary"],
                  ],
                },
                -20,
              ],
            },
            {
              $slice: [
                { $cond: [{ $isArray: "$canaryHistory" }, "$canaryHistory", []] },
                -20,
              ],
            },
          ],
        },
        canary: {
          generation,
          expiresAt: input.expiresAt,
          maxAdmissions: input.maxAdmissions,
          consumedAdmissions: 0,
          startedAt: now,
          audit: [{
            event: "opened",
            at: now,
            generation,
            consumedAdmissions: 0,
            remainingAdmissions: input.maxAdmissions,
          }],
        },
        expiresAt: "$$REMOVE",
      },
    }],
    { returnDocument: "after", maxTimeMS: 1000 },
  );
  if (!row) throw new Error("operator stop changed; refresh state before clearing");
  return projectProtractorStopState(row, now);
}

export async function countUsage(filter: UsageFilter): Promise<number> {
  const col = await usageCollection();
  return col.countDocuments(filter);
}

export async function aggregateUsage<T extends Document = Document>(pipeline: Document[]): Promise<T[]> {
  const col = await usageCollection();
  return col.aggregate<T>(pipeline).toArray();
}

export async function findOneUsage(
  filter: UsageFilter,
): Promise<ApiUsageRecord | null> {
  const col = await usageCollection();
  return (await col.findOne(filter)) as ApiUsageRecord | null;
}

export interface FindUsageOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  projection?: Record<string, 0 | 1>;
}

export async function findUsage(
  filter: UsageFilter,
  opts: FindUsageOptions = {},
): Promise<ApiUsageRecord[]> {
  const col = await usageCollection();
  const cursor = col.find(filter);
  if (opts.sort) cursor.sort(opts.sort);
  if (opts.limit) cursor.limit(opts.limit);
  if (opts.projection) cursor.project(opts.projection);
  return (await cursor.toArray()) as ApiUsageRecord[];
}

export async function ensureApiUsageIndexes(): Promise<void> {
  const col = await usageCollection();
  await Promise.all([
    col.createIndex({ provider: 1, timestamp: -1 }),
    col.createIndex({ provider: 1, isError: 1, timestamp: -1 }),
    col.createIndex({ provider: 1, shopId: 1, timestamp: -1 }),
    col.createIndex({ requestId: 1 }, { sparse: true }),
    col.createIndex({ timestamp: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Typed, flag-gated read helpers                                             */
/*                                                                            */
/* These wrap the specific windowed-count / group-by-shop / recent-429       */
/* shapes that the usage-stats readers need, so those callers no longer      */
/* have to hand-write Mongo pipelines (which can't be generically            */
/* translated to SQL). When PG is canonical they run SQL; otherwise they     */
/* run the equivalent Mongo query, byte-identical to the old inline code.    */
/* -------------------------------------------------------------------------- */

export interface UsageWindowCountOptions {
  isError?: boolean;
  isRateLimited?: boolean;
}

/** count(*) for a provider since `since`, optionally error/429-only. */
export async function countUsageInWindow(
  provider: string,
  since: Date,
  opts: UsageWindowCountOptions = {},
): Promise<number> {
  if (isApiUsagePgCanonical()) {
    return pgCountUsage({ provider, since, ...opts });
  }
  const filter: UsageFilter = { provider, timestamp: { $gte: since } };
  if (opts.isError !== undefined) filter.isError = opts.isError;
  if (opts.isRateLimited !== undefined) filter.isRateLimited = opts.isRateLimited;
  const col = await usageCollection();
  return col.countDocuments(filter);
}

/** avg(latencyMs) for a provider since `since`. */
export async function avgLatencyInWindow(
  provider: string,
  since: Date,
): Promise<number> {
  if (isApiUsagePgCanonical()) {
    return pgAvgLatency(provider, since);
  }
  const col = await usageCollection();
  const rows = await col
    .aggregate<{ avg: number }>([
      { $match: { provider, timestamp: { $gte: since } } },
      { $group: { _id: null, avg: { $avg: "$latencyMs" } } },
    ])
    .toArray();
  return rows[0]?.avg ?? 0;
}

/** Top-N shops by request count for a provider since `since`. */
export async function topShopsInWindow(
  provider: string,
  since: Date,
  limit: number,
): Promise<{ shopId: number; count: number }[]> {
  if (isApiUsagePgCanonical()) {
    return pgTopShops(provider, since, limit);
  }
  const col = await usageCollection();
  const rows = await col
    .aggregate<{ _id: number; count: number }>([
      {
        $match: {
          provider,
          timestamp: { $gte: since },
          shopId: { $exists: true, $ne: null },
        },
      },
      { $group: { _id: "$shopId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ])
    .toArray();
  return rows.map((r) => ({ shopId: r._id, count: r.count }));
}

/** Recent rate-limited / 429 rows for a provider, newest first. */
export async function recentRateLimitedInWindow(
  provider: string,
  since: Date,
  limit: number,
): Promise<{ timestamp: Date; endpoint?: string; shopId?: number }[]> {
  if (isApiUsagePgCanonical()) {
    const rows = await pgRecent429s(provider, since, limit);
    return rows.map((r) => ({
      timestamp: r.timestamp,
      endpoint: r.endpoint ?? undefined,
      shopId: r.shopId ?? undefined,
    }));
  }
  const col = await usageCollection();
  const rows = (await col
    .find({
      provider,
      $or: [{ isRateLimited: true }, { statusCode: 429 }],
      timestamp: { $gte: since },
    })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray()) as ApiUsageRecord[];
  return rows.map((r) => ({
    timestamp: r.timestamp,
    endpoint: r.endpoint,
    shopId: r.shopId ?? undefined,
  }));
}
