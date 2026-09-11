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
  mode?: "bounded" | "timed_trial";
  scope?: ProtractorTimedTrialScope;
  startedAt?: Date;
  expiresAt: Date;
  maxAdmissions: number | null;
  consumedAdmissions: number;
  remainingAdmissions: number | null;
  requiresCallback?: boolean;
  endedBy?: "time" | "budget" | "operator";
  endedAt?: Date;
  auditTruncatedAdmissions?: number;
  audit: Array<{
    event: "opened" | "admitted" | "ended" | "operator_stop";
    at: Date;
    generation: string;
    consumedAdmissions: number;
    remainingAdmissions: number | null;
    endedBy?: "time" | "budget" | "operator";
  }>;
}

export type ProtractorTimedTrialScope = "callbacks" | "callbacks_and_interactive";

/*
 * Keep these predicates in expression form instead of relying on JavaScript
 * validation after a document has been read.  The physical transport record
 * is a shared CAS boundary, so malformed persisted accounting must be
 * rejected by the same Mongo operation that admits or finalizes it.
 *
 * The range checks are deliberately inside $cond. MongoDB is allowed to
 * evaluate $and/$or operands eagerly; putting comparisons behind the type
 * guard prevents a malformed value from reaching arithmetic/comparison
 * expressions that expect numeric operands.
 */
const MAX_SAFE_ADMISSIONS = Number.MAX_SAFE_INTEGER;

function isSafeAdmissionCounter(value: unknown): boolean {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(MAX_SAFE_ADMISSIONS);
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const validBoundedCanaryAccountingExpression = {
  $cond: [
    {
      $and: [
        { $eq: [{ $type: "$canary.generation" }, "string"] },
        { $eq: [{ $type: "$canary.expiresAt" }, "date"] },
        {
          $or: [
            { $eq: [{ $type: "$canary.mode" }, "missing"] },
            { $eq: ["$canary.mode", "bounded"] },
          ],
        },
        { $in: [{ $type: "$canary.maxAdmissions" }, ["int", "long"]] },
        { $in: [{ $type: "$canary.consumedAdmissions" }, ["int", "long"]] },
        { $in: [{ $type: "$canary.audit" }, ["missing", "array"]] },
        {
          $or: [
            { $eq: [{ $type: "$canary.auditTruncatedAdmissions" }, "missing"] },
            { $in: [{ $type: "$canary.auditTruncatedAdmissions" }, ["int", "long"]] },
          ],
        },
        {
          $or: [
            { $eq: [{ $type: "$canary.endedBy" }, "missing"] },
            { $in: ["$canary.endedBy", ["time", "budget", "operator"]] },
          ],
        },
        {
          $or: [
            { $eq: [{ $type: "$canary.endedAt" }, "missing"] },
            { $eq: [{ $type: "$canary.endedAt" }, "date"] },
          ],
        },
      ],
    },
    {
      $and: [
        { $gte: ["$canary.maxAdmissions", 1] },
        { $lte: ["$canary.maxAdmissions", 3] },
        { $gte: ["$canary.consumedAdmissions", 0] },
        { $lte: ["$canary.consumedAdmissions", MAX_SAFE_ADMISSIONS] },
        {
          $or: [
            { $eq: [{ $type: "$canary.auditTruncatedAdmissions" }, "missing"] },
            {
              $and: [
                { $gte: ["$canary.auditTruncatedAdmissions", 0] },
                { $lte: ["$canary.auditTruncatedAdmissions", MAX_SAFE_ADMISSIONS] },
              ],
            },
          ],
        },
        { $lte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
      ],
    },
    false,
  ],
};

const validTimedTrialCanaryAccountingExpression = {
  $cond: [
    {
      $and: [
        { $eq: [{ $type: "$canary.generation" }, "string"] },
        { $eq: ["$canary.mode", "timed_trial"] },
        {
          $or: [
            {
              $and: [
                { $eq: [{ $type: "$canary.scope" }, "missing"] },
                {
                  $or: [
                    { $eq: [{ $type: "$canary.requiresCallback" }, "missing"] },
                    {
                      $and: [
                        { $in: [{ $type: "$canary.requiresCallback" }, ["bool", "boolean"]] },
                        { $eq: ["$canary.requiresCallback", true] },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              $and: [
                { $eq: [{ $type: "$canary.scope" }, "string"] },
                { $eq: ["$canary.scope", "callbacks"] },
                { $in: [{ $type: "$canary.requiresCallback" }, ["bool", "boolean"]] },
                { $eq: ["$canary.requiresCallback", true] },
              ],
            },
            {
              $and: [
                { $eq: [{ $type: "$canary.scope" }, "string"] },
                { $eq: ["$canary.scope", "callbacks_and_interactive"] },
                { $in: [{ $type: "$canary.requiresCallback" }, ["bool", "boolean"]] },
                { $eq: ["$canary.requiresCallback", false] },
              ],
            },
          ],
        },
        { $eq: [{ $type: "$canary.startedAt" }, "date"] },
        { $eq: [{ $type: "$canary.expiresAt" }, "date"] },
        { $eq: [{ $type: "$canary.maxAdmissions" }, "null"] },
        { $eq: [{ $type: "$canary.remainingAdmissions" }, "null"] },
        { $in: [{ $type: "$canary.consumedAdmissions" }, ["int", "long"]] },
        { $in: [{ $type: "$canary.audit" }, ["missing", "array"]] },
        {
          $or: [
            { $eq: [{ $type: "$canary.auditTruncatedAdmissions" }, "missing"] },
            { $in: [{ $type: "$canary.auditTruncatedAdmissions" }, ["int", "long"]] },
          ],
        },
        {
          $or: [
            { $eq: [{ $type: "$canary.endedBy" }, "missing"] },
            { $in: ["$canary.endedBy", ["time", "operator"]] },
          ],
        },
        {
          $or: [
            { $eq: [{ $type: "$canary.endedAt" }, "missing"] },
            { $eq: [{ $type: "$canary.endedAt" }, "date"] },
          ],
        },
      ],
    },
    {
      $and: [
        { $gte: ["$canary.consumedAdmissions", 0] },
        { $lte: ["$canary.consumedAdmissions", MAX_SAFE_ADMISSIONS] },
        {
          $or: [
            { $eq: [{ $type: "$canary.auditTruncatedAdmissions" }, "missing"] },
            {
              $and: [
                { $gte: ["$canary.auditTruncatedAdmissions", 0] },
                { $lte: ["$canary.auditTruncatedAdmissions", MAX_SAFE_ADMISSIONS] },
              ],
            },
          ],
        },
        { $eq: [{ $subtract: ["$canary.expiresAt", "$canary.startedAt"] }, 1_800_000] },
      ],
    },
    false,
  ],
};

const validCanaryAccountingExpression = {
  $or: [
    validBoundedCanaryAccountingExpression,
    validTimedTrialCanaryAccountingExpression,
  ],
};

const openBoundedCanaryExpression = {
  $cond: [
    validBoundedCanaryAccountingExpression,
    {
      $and: [
        { $eq: [{ $type: "$canary.endedBy" }, "missing"] },
        { $gt: ["$canary.expiresAt", "$$NOW"] },
        { $lt: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
      ],
    },
    false,
  ],
};

const openTimedTrialCanaryExpression = {
  $cond: [
    validTimedTrialCanaryAccountingExpression,
    {
      $and: [
        { $eq: [{ $type: "$canary.endedBy" }, "missing"] },
        { $lte: ["$canary.startedAt", "$$NOW"] },
        { $gt: ["$canary.expiresAt", "$$NOW"] },
        { $lt: ["$canary.consumedAdmissions", MAX_SAFE_ADMISSIONS] },
      ],
    },
    false,
  ],
};

const canaryAdmissionExpression = {
  $or: [
    { $eq: [{ $type: "$canary" }, "missing"] },
    openBoundedCanaryExpression,
    openTimedTrialCanaryExpression,
  ],
};

const nextCanaryConsumedExpression = {
  $add: ["$canary.consumedAdmissions", 1],
};

const finalCanaryAdmissionExpression = {
  $gte: [nextCanaryConsumedExpression, "$canary.maxAdmissions"],
};

const terminalCanaryExpression = {
  $cond: [
    validCanaryAccountingExpression,
    { $eq: [{ $type: "$canary.endedBy" }, "missing"] },
    false,
  ],
};

function projectProtractorStopState(row: any, now: Date): ProtractorOperatorStopState {
  const state = row?.operatorStop;
  const projectCanary = (canary: any): ProtractorCanaryState => {
    let endedBy = canary?.endedBy as "time" | "budget" | "operator" | undefined;
    if (!endedBy && canary) {
      if (state?.active === true && canary === row?.canary) endedBy = "operator";
      else if (
        canary.mode !== "timed_trial" &&
        typeof canary.maxAdmissions === "number" &&
        typeof canary.consumedAdmissions === "number" &&
        canary.consumedAdmissions >= canary.maxAdmissions
      ) endedBy = "budget";
      else if (canary.expiresAt instanceof Date && canary.expiresAt.getTime() <= now.getTime()) endedBy = "time";
    }
    const timedTrial = canary?.mode === "timed_trial";
    return {
      generation: canary.generation,
      mode: canary.mode,
      startedAt: canary.startedAt,
      expiresAt: canary.expiresAt,
      maxAdmissions: timedTrial ? null : canary.maxAdmissions,
      consumedAdmissions: canary.consumedAdmissions ?? 0,
      remainingAdmissions: timedTrial
        ? null
        : Math.max(0, (canary.maxAdmissions ?? 0) - (canary.consumedAdmissions ?? 0)),
      scope: timedTrial ? canary.scope ?? "callbacks" : undefined,
      requiresCallback: canary.requiresCallback,
      endedBy,
      endedAt: canary.endedAt ?? (endedBy === "time" ? canary.expiresAt : undefined),
      auditTruncatedAdmissions: canary.auditTruncatedAdmissions,
      audit: Array.isArray(canary.audit) ? canary.audit : [],
    };
  };
  const canary = row?.canary;
  let endedBy = canary?.endedBy as "time" | "budget" | "operator" | undefined;
  if (!endedBy && canary) {
    if (state?.active === true) endedBy = "operator";
    else if (
      canary.mode !== "timed_trial" &&
      typeof canary.maxAdmissions === "number" &&
      typeof canary.consumedAdmissions === "number" &&
      canary.consumedAdmissions >= canary.maxAdmissions
    ) endedBy = "budget";
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

const AUDIT_LIMIT = 100;

function appendCanaryAudit(events: unknown[]): Document {
  const existing = { $ifNull: ["$canary.audit", []] };
  const appended = { $concatArrays: [existing, ...events] };
  return {
    $cond: [
      { $gt: [{ $size: appended }, AUDIT_LIMIT] },
      {
        $concatArrays: [
          { $slice: [existing, 0, 1] },
          { $slice: [appended, -(AUDIT_LIMIT - 1)] },
        ],
      },
      appended,
    ],
  };
}

function auditTruncationIncrement(events: unknown[]): Document {
  const existing = { $ifNull: ["$canary.audit", []] };
  const appended = { $concatArrays: [existing, ...events] };
  return {
    $max: [
      0,
      { $subtract: [{ $size: appended }, AUDIT_LIMIT] },
    ],
  };
}

async function finalizeProtractorCanaryTerminalState(
  col: Collection<any>,
): Promise<any | null> {
  return col.findOneAndUpdate(
    {
      _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
      "operatorStop.active": { $ne: true },
      $expr: {
        $cond: [
          terminalCanaryExpression,
            {
              $cond: [
                validTimedTrialCanaryAccountingExpression,
                { $lte: ["$canary.expiresAt", "$$NOW"] },
                {
                  $or: [
                    { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
                    { $lte: ["$canary.expiresAt", "$$NOW"] },
                  ],
                },
              ],
            },
          false,
        ],
      },
    },
    [{
      $set: {
        "canary.endedBy": {
          $cond: [
            validCanaryAccountingExpression,
            {
              $cond: [
                validTimedTrialCanaryAccountingExpression,
                "time",
                {
                  $cond: [
                    { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
                    "budget",
                    "time",
                  ],
                },
              ],
            },
            "$canary.endedBy",
          ],
        },
        "canary.endedAt": {
          $cond: [
            validCanaryAccountingExpression,
            {
              $cond: [
                validTimedTrialCanaryAccountingExpression,
                "$canary.expiresAt",
                {
                  $cond: [
                    { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
                    "$$NOW",
                    "$canary.expiresAt",
                  ],
                },
              ],
            },
            "$canary.endedAt",
          ],
        },
        "canary.audit": {
          $cond: [
            validCanaryAccountingExpression,
            appendCanaryAudit([[{
                  event: "ended",
                  at: {
                    $cond: [
                      validTimedTrialCanaryAccountingExpression,
                      "$canary.expiresAt",
                      {
                        $cond: [
                          { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
                          "$$NOW",
                          "$canary.expiresAt",
                        ],
                      },
                    ],
                  },
                  generation: "$canary.generation",
                  consumedAdmissions: "$canary.consumedAdmissions",
                  remainingAdmissions: {
                    $cond: [
                      validTimedTrialCanaryAccountingExpression,
                      null,
                      {
                        $max: [
                          0,
                          { $subtract: ["$canary.maxAdmissions", "$canary.consumedAdmissions"] },
                        ],
                      },
                    ],
                  },
                  endedBy: {
                    $cond: [
                      validTimedTrialCanaryAccountingExpression,
                      "time",
                      {
                        $cond: [
                          { $gte: ["$canary.consumedAdmissions", "$canary.maxAdmissions"] },
                          "budget",
                          "time",
                        ],
                      },
                    ],
                  },
                }]]),
                "$canary.audit",
              ],
            },
        "canary.auditTruncatedAdmissions": {
          $cond: [
            validCanaryAccountingExpression,
            {
              $add: [
                { $ifNull: ["$canary.auditTruncatedAdmissions", 0] },
                auditTruncationIncrement([[{
                  event: "ended",
                  at: "$$NOW",
                  generation: "$canary.generation",
                  consumedAdmissions: "$canary.consumedAdmissions",
                  remainingAdmissions: null,
                  endedBy: "time",
                }]]),
              ],
            },
            "$canary.auditTruncatedAdmissions",
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
            canaryAdmissionExpression,
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
    if (hasCanary) {
      const canary = state?.canary;
      const timedTrial = canary?.mode === "timed_trial";
      const malformed = timedTrial
        ? (
          canary?.endedBy ||
          typeof canary?.generation !== "string" ||
          !(canary?.startedAt instanceof Date) ||
          !(canary?.expiresAt instanceof Date) ||
          canary.startedAt.getTime() > Date.now() ||
          canary.expiresAt.getTime() - canary.startedAt.getTime() !== 1_800_000 ||
          canary?.maxAdmissions !== null ||
          canary?.remainingAdmissions !== null ||
          !isSafeAdmissionCounter(canary?.consumedAdmissions) ||
          (canary?.audit !== undefined && !Array.isArray(canary.audit)) ||
          canary.expiresAt.getTime() <= Date.now()
        )
        : (
          canary?.endedBy ||
          typeof canary?.generation !== "string" ||
          !(canary?.expiresAt instanceof Date) ||
          !Number.isInteger(canary?.maxAdmissions) ||
          canary.maxAdmissions < 1 ||
          canary.maxAdmissions > 3 ||
          !isSafeAdmissionCounter(canary?.consumedAdmissions) ||
          canary.consumedAdmissions > canary.maxAdmissions ||
          (canary?.audit !== undefined && !Array.isArray(canary.audit)) ||
          canary.expiresAt.getTime() <= Date.now()
        );
      if (canary?.mode !== undefined && !timedTrial && canary.mode !== "bounded") return null;
      const validTimedScopePair =
        (canary?.scope === undefined &&
          (canary?.requiresCallback === undefined || canary?.requiresCallback === true)) ||
        (canary?.scope === "callbacks" && canary?.requiresCallback === true) ||
        (canary?.scope === "callbacks_and_interactive" && canary?.requiresCallback === false);
      if (malformed) return null;
      if (timedTrial && !validTimedScopePair) return null;
      if (!timedTrial && canary.consumedAdmissions >= canary.maxAdmissions) return null;
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return null;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
  }
  return null;
}

export interface ProtractorPhysicalTransportConfirmationContext {
  requireTimedTrial?: boolean;
  callbackReceivedAt?: Date;
  interactiveShopId?: number;
}

export async function confirmProtractorPhysicalTransportLease(
  ownerToken: string,
  context: ProtractorPhysicalTransportConfirmationContext = {},
): Promise<boolean> {
  const db = await __protractorPhysicalTransportTestHooks.getDb();
  const col = db.collection<any>(RATE_LIMIT_COLLECTION);
  const callbackReceivedAtIsValid =
    context.callbackReceivedAt instanceof Date &&
    Number.isFinite(context.callbackReceivedAt.getTime());
  const callbackReceivedAt = callbackReceivedAtIsValid
    ? { $literal: context.callbackReceivedAt }
    : null;
  const interactiveShopIdIsValid =
    typeof context.interactiveShopId === "number" &&
    Number.isSafeInteger(context.interactiveShopId) &&
    context.interactiveShopId > 0;
  const interactiveShopId = interactiveShopIdIsValid
    ? { $literal: context.interactiveShopId }
    : null;
  const timedTrialAdmissionExpression = {
    $cond: [
      validTimedTrialCanaryAccountingExpression,
      {
        $and: [
          { $eq: [{ $type: "$canary.endedBy" }, "missing"] },
          { $gt: ["$canary.expiresAt", "$$NOW"] },
          { $lt: ["$canary.consumedAdmissions", MAX_SAFE_ADMISSIONS] },
          { $eq: ["$ownerCanaryGeneration", "$canary.generation"] },
          {
            $or: [
              {
                $and: [
                  { $gte: [callbackReceivedAt, "$canary.startedAt"] },
                  { $lte: [callbackReceivedAt, "$$NOW"] },
                ],
              },
              {
                $and: [
                  { $eq: ["$canary.scope", "callbacks_and_interactive"] },
                  { $gt: [interactiveShopId, 0] },
                ],
              },
            ],
          },
        ],
      },
      false,
    ],
  };
  const canaryConfirmationExpression = context.requireTimedTrial === true
    ? timedTrialAdmissionExpression
    : {
      $or: [
        { $eq: [{ $type: "$canary" }, "missing"] },
        {
          $cond: [
            openBoundedCanaryExpression,
            { $eq: ["$ownerCanaryGeneration", "$canary.generation"] },
            false,
          ],
        },
        timedTrialAdmissionExpression,
      ],
    };
  const finalBoundedAdmissionExpression = {
    $cond: [
      validBoundedCanaryAccountingExpression,
      finalCanaryAdmissionExpression,
      false,
    ],
  };
  const admissionAuditEvents = [
    [{
      event: "admitted",
      at: "$$NOW",
      generation: "$canary.generation",
      consumedAdmissions: nextCanaryConsumedExpression,
      remainingAdmissions: {
        $cond: [
          validTimedTrialCanaryAccountingExpression,
          null,
          {
            $subtract: [
              "$canary.maxAdmissions",
              nextCanaryConsumedExpression,
            ],
          },
        ],
      },
    }],
    {
      $cond: [
        finalBoundedAdmissionExpression,
        [{
          event: "ended",
          at: "$$NOW",
          generation: "$canary.generation",
          consumedAdmissions: nextCanaryConsumedExpression,
          remainingAdmissions: 0,
          endedBy: "budget",
        }],
        [],
      ],
    },
  ];
  // This update is the atomic physical-admission boundary. Operator activation
  // and dispatch contend on the same document: whichever commits first wins.
  // If dispatch wins, activation still blocks every subsequent lease/dispatch.
  const row = await col.findOneAndUpdate(
    {
      _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
      ownerToken,
      "operatorStop.active": { $ne: true },
      physicalAdmissionOwnerToken: { $ne: ownerToken },
      $expr: {
        $and: [
          { $gt: ["$leaseExpiresAt", "$$NOW"] },
          canaryConfirmationExpression,
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
            {
              $cond: [
                validCanaryAccountingExpression,
                nextCanaryConsumedExpression,
                "$canary.consumedAdmissions",
              ],
            },
          ],
        },
        "canary.remainingAdmissions": {
          $cond: [
            { $eq: [{ $type: "$canary" }, "missing"] },
            "$$REMOVE",
            {
              $cond: [
                validTimedTrialCanaryAccountingExpression,
                null,
                {
                  $cond: [
                    validBoundedCanaryAccountingExpression,
                    {
                      $subtract: [
                        "$canary.maxAdmissions",
                        nextCanaryConsumedExpression,
                      ],
                    },
                    "$canary.remainingAdmissions",
                  ],
                },
              ],
            },
          ],
        },
        "canary.endedBy": {
          $cond: [
            { $eq: [{ $type: "$canary" }, "missing"] },
            "$$REMOVE",
            {
              $cond: [
                validTimedTrialCanaryAccountingExpression,
                "$canary.endedBy",
                {
                  $cond: [
                    validBoundedCanaryAccountingExpression,
                    {
                      $cond: [
                        finalCanaryAdmissionExpression,
                        "budget",
                        "$$REMOVE",
                      ],
                    },
                    "$canary.endedBy",
                  ],
                },
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
                validTimedTrialCanaryAccountingExpression,
                "$canary.endedAt",
                {
                  $cond: [
                    validBoundedCanaryAccountingExpression,
                    {
                      $cond: [
                        finalCanaryAdmissionExpression,
                        "$$NOW",
                        "$$REMOVE",
                      ],
                    },
                    "$canary.endedAt",
                  ],
                },
              ],
            },
          ],
        },
        "canary.audit": {
          $cond: [
            { $eq: [{ $type: "$canary" }, "missing"] },
            "$$REMOVE",
            {
              $cond: [
                validCanaryAccountingExpression,
                appendCanaryAudit(admissionAuditEvents),
                "$canary.audit",
              ],
            },
          ],
        },
        "canary.auditTruncatedAdmissions": {
          $cond: [
            validCanaryAccountingExpression,
            {
              $add: [
                { $ifNull: ["$canary.auditTruncatedAdmissions", 0] },
                auditTruncationIncrement(admissionAuditEvents),
              ],
            },
            "$canary.auditTruncatedAdmissions",
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
            { $eq: [{ $type: "$canary" }, "missing"] },
            "$$REMOVE",
            {
              $cond: [
                validCanaryAccountingExpression,
                {
                  $mergeObjects: [
                    "$canary",
                    {
                      endedBy: {
                        $cond: [
                          validTimedTrialCanaryAccountingExpression,
                          {
                            $ifNull: [
                              "$canary.endedBy",
                              { $cond: [{ $lte: ["$canary.expiresAt", pipelineNow] }, "time", "operator"] },
                            ],
                          },
                          {
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
                        ],
                      },
                      endedAt: {
                        $cond: [
                          validTimedTrialCanaryAccountingExpression,
                          {
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
                          {
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
                        ],
                      },
                      audit: {
                        $cond: [
                          validTimedTrialCanaryAccountingExpression,
                          appendCanaryAudit([[{
                            event: "operator_stop",
                            at: pipelineNow,
                            generation: "$canary.generation",
                            consumedAdmissions: "$canary.consumedAdmissions",
                            remainingAdmissions: null,
                            endedBy: {
                              $ifNull: [
                                "$canary.endedBy",
                                {
                                  $cond: [
                                    { $lte: ["$canary.expiresAt", pipelineNow] },
                                    "time",
                                    "operator",
                                  ],
                                },
                              ],
                            },
                          }]]),
                          appendCanaryAudit([[{
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
                          }]]),
                        ],
                      },
                      auditTruncatedAdmissions: {
                        $add: [
                          { $ifNull: ["$canary.auditTruncatedAdmissions", 0] },
                          {
                            $cond: [
                              validTimedTrialCanaryAccountingExpression,
                              auditTruncationIncrement([[{ event: "operator_stop" }]]),
                              auditTruncationIncrement([[{ event: "operator_stop" }]]),
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
                "$canary",
              ],
            },
          ],
        },
        expiresAt: "$$REMOVE",
      },
    }],
    { returnDocument: "after", maxTimeMS: 1000 },
  );
  return projectProtractorStopState(row, now);
}

// Verify the returned write result, not a later read that could belong to a
// different generation. Failure is ambiguous: never retry/clear/refund here.
function assertFreshProtractorGeneration(
  row: any,
  generation: string,
  stopId: string,
  mode: "timed_trial" | "bounded",
  expectedScope?: ProtractorTimedTrialScope,
): void {
  const canary = row?.canary;
  if (
    row?.operatorStop?.active !== false ||
    row?.operatorStop?.stopId !== stopId ||
    canary?.generation !== generation ||
    canary?.mode !== mode ||
    canary?.consumedAdmissions !== 0 ||
    canary?.endedBy !== undefined ||
    canary?.endedAt !== undefined ||
    canary?.auditTruncatedAdmissions !== undefined ||
    !(canary?.startedAt instanceof Date) ||
    !Number.isFinite(canary.startedAt.getTime()) ||
    !(canary?.expiresAt instanceof Date) ||
    !Number.isFinite(canary.expiresAt.getTime()) ||
    !Array.isArray(canary?.audit) ||
    canary.audit.length !== 1 ||
    canary.audit[0]?.event !== "opened" ||
    canary.audit[0]?.generation !== generation ||
    (mode === "timed_trial" && (
      canary.scope !== expectedScope ||
      canary.requiresCallback !== (expectedScope === "callbacks") ||
      canary.maxAdmissions !== null ||
      canary.remainingAdmissions !== null ||
      canary.expiresAt.getTime() - canary.startedAt.getTime() !== 1_800_000
    )) ||
    (mode === "bounded" && (
      !Number.isInteger(canary.maxAdmissions) ||
      canary.maxAdmissions < 1 ||
      canary.maxAdmissions > 3 ||
      canary.remainingAdmissions !== canary.maxAdmissions ||
      canary.requiresCallback !== undefined ||
      canary.scope !== undefined ||
      canary.expiresAt.getTime() <= canary.startedAt.getTime()
    ))
  ) {
    throw new Error("New Protractor generation could not be verified; refresh status before retrying");
  }
}

export async function startProtractorTimedTrial(input: {
  changedBy: string;
  reason: string;
  expectedStopId: string;
  scope?: ProtractorTimedTrialScope;
  now?: Date;
}): Promise<ProtractorOperatorStopState> {
  const changedBy = input.changedBy.trim();
  const reason = input.reason.trim();
  const expectedStopId = input.expectedStopId.trim();
  const scope = input.scope === undefined ? "callbacks" : input.scope;
  if (!changedBy || !reason || !expectedStopId) {
    throw new Error("changedBy, reason, and expectedStopId are required");
  }
  if (scope !== "callbacks" && scope !== "callbacks_and_interactive") {
    throw new Error("scope must be callbacks or callbacks_and_interactive");
  }
  await initializeTransportLease(
    PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
    __protractorPhysicalTransportTestHooks.getDb,
  );
  const db = await __protractorPhysicalTransportTestHooks.getDb();
  const now = input.now ?? new Date();
  const pipelineNow = input.now ?? "$$NOW";
  const generation = __protractorPhysicalTransportTestHooks.randomUUID();
  const expiresAt = {
    $add: [pipelineNow, 1_800_000],
  };
  const row = await db.collection<any>(RATE_LIMIT_COLLECTION).findOneAndUpdate(
    {
      _id: PROTRACTOR_PHYSICAL_TRANSPORT_KEY,
      "operatorStop.active": true,
      "operatorStop.stopId": expectedStopId,
    },
    [{
      $set: {
        canaryHistory: {
          $cond: [
            {
              $and: [
                validCanaryAccountingExpression,
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
      },
    },
    // Aggregation $set merges object-shaped assignments into existing objects.
    // Archive first, then remove old state before creating this generation.
    // All stages remain one atomic, stop-ID-fenced update; $$NOW is unchanged.
    { $unset: ["canary", "operatorStop"] },
    {
      $set: {
        operatorStop: {
          active: false,
          stopId: { $literal: expectedStopId },
          reason: { $literal: reason },
          changedBy: { $literal: changedBy },
          clearedAt: pipelineNow,
          updatedAt: pipelineNow,
        },
        canary: {
          generation,
          mode: "timed_trial",
          scope,
          requiresCallback: scope === "callbacks",
          startedAt: pipelineNow,
          expiresAt,
          maxAdmissions: null,
          remainingAdmissions: null,
          consumedAdmissions: 0,
          audit: [{
            event: "opened",
            at: pipelineNow,
            generation,
            consumedAdmissions: 0,
            remainingAdmissions: null,
          }],
        },
        expiresAt: "$$REMOVE",
      },
    }],
    { returnDocument: "after", maxTimeMS: 1000 },
  );
  if (!row) throw new Error("operator stop changed; refresh state before starting trial");
  assertFreshProtractorGeneration(row, generation, expectedStopId, "timed_trial", scope);
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
        canaryHistory: {
          $cond: [
            {
              $and: [
                  validCanaryAccountingExpression,
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
      },
    },
    { $unset: ["canary", "operatorStop"] },
    {
      $set: {
        operatorStop: {
          active: false,
          stopId: { $literal: expectedStopId },
          reason: { $literal: reason },
          changedBy: { $literal: changedBy },
          clearedAt: now,
          updatedAt: now,
        },
        canary: {
          generation,
          mode: "bounded",
          expiresAt: input.expiresAt,
          maxAdmissions: input.maxAdmissions,
          remainingAdmissions: input.maxAdmissions,
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
  assertFreshProtractorGeneration(row, generation, expectedStopId, "bounded");
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
