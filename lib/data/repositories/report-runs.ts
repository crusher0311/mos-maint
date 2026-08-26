import { createHash } from "node:crypto";
import type { Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import type { DeclarativeReportResult, ReportDefinitionV1 } from "@/lib/report-definition-contract";
import type { CustomReportScopeRequest } from "@/lib/data/repositories/custom-reports";

const COLLECTION = "report_runs";
export const REPORT_RUN_EXECUTION_VERSION = 1;
export const REPORT_RUN_FRESH_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;

export type ReportRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ReportRunDocument extends Document {
  _id: string;
  cacheKey: string;
  requestedBy: string;
  reportId?: string;
  reportVersion?: number;
  definition: ReportDefinitionV1;
  scopeRequest: CustomReportScopeRequest;
  authorizedShopIds: number[];
  status: ReportRunStatus;
  stage: string;
  attempts: number;
  createdAt: Date;
  queuedAt: Date;
  startedAt?: Date;
  heartbeatAt?: Date;
  completedAt?: Date;
  generatedAt?: Date;
  lastViewedAt: Date;
  refreshEnabled: boolean;
  result?: DeclarativeReportResult;
  error?: { message: string; retryable: boolean; stage?: string };
}

async function collection() {
  return (await getDb()).collection<ReportRunDocument>(COLLECTION);
}

export function reportRunCacheKey(input: {
  requestedBy?: string;
  reportId?: string;
  reportVersion?: number;
  definition: ReportDefinitionV1;
  scopeRequest: CustomReportScopeRequest;
  authorizedShopIds: number[];
}) {
  return createHash("sha256").update(JSON.stringify({
    executionVersion: REPORT_RUN_EXECUTION_VERSION,
    reportId: input.reportId || null,
    reportVersion: input.reportVersion || null,
    requester: input.reportId ? null : input.requestedBy?.trim().toLowerCase() || null,
    definition: input.definition,
    scope: input.scopeRequest,
    shopIds: [...input.authorizedShopIds].sort((a, b) => a - b),
  })).digest("hex");
}

export function classifyReportRunCache(
  existing: Pick<ReportRunDocument, "status" | "generatedAt" | "result"> | null,
  now = new Date(),
) {
  const active = existing?.status === "queued" || existing?.status === "running";
  const fresh = existing?.status === "succeeded" && existing.generatedAt &&
    now.getTime() - existing.generatedAt.getTime() < REPORT_RUN_FRESH_MS;
  return {
    active,
    fresh: Boolean(fresh),
    readable: Boolean(existing?.result),
    cache: fresh ? "hit" as const : existing?.result ? "stale" as const : "miss" as const,
  };
}

export async function enqueueReportRun(input: {
  requestedBy: string;
  reportId?: string;
  reportVersion?: number;
  definition: ReportDefinitionV1;
  scopeRequest: CustomReportScopeRequest;
  authorizedShopIds: number[];
  force?: boolean;
  refreshEnabled?: boolean;
  now?: Date;
}) {
  const now = input.now || new Date();
  const cacheKey = reportRunCacheKey(input);
  const runs = await collection();
  const next: ReportRunDocument = {
    _id: cacheKey,
    cacheKey,
    requestedBy: input.requestedBy.trim().toLowerCase(),
    ...(input.reportId ? { reportId: input.reportId } : {}),
    ...(input.reportVersion ? { reportVersion: input.reportVersion } : {}),
    definition: input.definition,
    scopeRequest: input.scopeRequest,
    authorizedShopIds: [...input.authorizedShopIds].sort((a, b) => a - b),
    status: "queued",
    stage: "queued",
    attempts: 0,
    createdAt: now,
    queuedAt: now,
    lastViewedAt: now,
    refreshEnabled: input.refreshEnabled ?? false,
  };
  try {
    await runs.insertOne(next);
    return { run: next, cache: "miss" as const, deduplicated: false };
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
  }
  const existing = await runs.findOne({ _id: cacheKey });
  if (!existing) throw new Error("Report run contention could not be resolved");
  const state = classifyReportRunCache(existing, now);
  if (state.active || (state.fresh && !input.force)) {
    await runs.updateOne({ _id: cacheKey }, {
      $set: { lastViewedAt: now, ...(input.refreshEnabled ? { refreshEnabled: true } : {}) },
    });
    return { run: { ...existing, lastViewedAt: now }, cache: state.fresh ? "hit" as const : "refreshing" as const, deduplicated: state.active };
  }
  const refreshed = await runs.findOneAndUpdate(
    { _id: cacheKey, status: existing.status },
    {
      $set: {
        requestedBy: input.requestedBy.trim().toLowerCase(),
        status: "queued", stage: "queued", attempts: 0, queuedAt: now, lastViewedAt: now,
        refreshEnabled: input.refreshEnabled ?? existing.refreshEnabled ?? false,
      },
      $unset: { error: "", startedAt: "", heartbeatAt: "" },
    },
    { returnDocument: "after" },
  );
  if (refreshed) {
    return { run: refreshed, cache: existing.result ? "stale" as const : "miss" as const, deduplicated: false };
  }
  const winner = await runs.findOne({ _id: cacheKey });
  if (!winner) throw new Error("Report run contention could not be resolved");
  return { run: winner, cache: winner.result ? "stale" as const : "refreshing" as const, deduplicated: true };
}

export async function findReportRun(id: string) {
  return (await collection()).findOne({ _id: id });
}

export async function findReportRunByKey(input: Parameters<typeof reportRunCacheKey>[0]) {
  return findReportRun(reportRunCacheKey(input));
}

export async function touchReportRun(id: string, now = new Date()) {
  await (await collection()).updateOne({ _id: id }, { $set: { lastViewedAt: now } });
}

export async function claimNextReportRun(now = new Date()) {
  const stale = new Date(now.getTime() - 10 * 60_000);
  return (await collection()).findOneAndUpdate(
    {
      attempts: { $lt: MAX_ATTEMPTS },
      $or: [
        { status: "queued", queuedAt: { $lte: now } },
        { status: "running", heartbeatAt: { $lt: stale } },
      ],
    },
    {
      $set: { status: "running", stage: "authorization", startedAt: now, heartbeatAt: now },
      $inc: { attempts: 1 },
      $unset: { error: "" },
    },
    { sort: { queuedAt: 1 }, returnDocument: "after" },
  );
}

export async function updateReportRunStage(id: string, stage: string) {
  await (await collection()).updateOne(
    { _id: id, status: "running" },
    { $set: { stage, heartbeatAt: new Date() } },
  );
}

export async function completeReportRun(id: string, result: DeclarativeReportResult) {
  const now = new Date();
  await (await collection()).updateOne(
    { _id: id, status: "running" },
    {
      $set: {
        status: "succeeded", stage: "complete", result,
        generatedAt: new Date(result.generatedAt), completedAt: now, heartbeatAt: now,
      },
      $unset: { error: "" },
    },
  );
}

export async function failReportRun(id: string, error: { message: string; retryable: boolean; stage?: string }) {
  const run = await findReportRun(id);
  const retry = error.retryable && (run?.attempts || 0) < MAX_ATTEMPTS;
  await (await collection()).updateOne(
    { _id: id, status: "running" },
    {
      $set: {
        status: retry ? "queued" : "failed",
        stage: retry ? "retry_queued" : "failed",
        queuedAt: retry ? new Date(Date.now() + Math.min(5 * 60_000, 30_000 * (run?.attempts || 1))) : run?.queuedAt,
        completedAt: new Date(),
        error,
      },
    },
  );
}

export async function cancelReportRun(id: string, requestedBy: string) {
  return (await collection()).findOneAndUpdate(
    { _id: id, requestedBy: requestedBy.toLowerCase(), status: "queued" },
    { $set: { status: "cancelled", stage: "cancelled", completedAt: new Date() } },
    { returnDocument: "after" },
  );
}

export async function enqueueActiveReportRefreshes(now = new Date(), limit = 10) {
  const staleBefore = new Date(now.getTime() - REPORT_RUN_FRESH_MS);
  const activeSince = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  const candidates = await (await collection()).find({
    status: "succeeded",
    refreshEnabled: true,
    lastViewedAt: { $gte: activeSince },
    generatedAt: { $lt: staleBefore },
  }).sort({ lastViewedAt: -1 }).limit(limit).toArray();
  for (const run of candidates) {
    await (await collection()).updateOne(
      { _id: run._id, status: "succeeded", generatedAt: run.generatedAt },
      { $set: { status: "queued", stage: "refresh_queued", queuedAt: now } },
    );
  }
  return candidates.length;
}