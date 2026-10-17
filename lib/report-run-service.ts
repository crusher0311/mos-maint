import { canReadCustomReport } from "@/lib/custom-report-access";
import { scopeRequest } from "@/lib/custom-report-api";
import { findCustomReport } from "@/lib/data/repositories/custom-reports";
import {
  claimNextReportRun,
  completeReportRun,
  enqueueActiveReportRefreshes,
  enqueueReportRun,
  failReportRun,
  findReportRun,
  findReportRunByKey,
  updateReportRunStage,
} from "@/lib/data/repositories/report-runs";
import { findReportingRecipient } from "@/lib/data/repositories/reporting-subscriptions";
import { executeReportDefinition, compileReportDefinition, ReportDefinitionError } from "@/lib/report-definition-compiler";
import type { ReportDefinitionV1 } from "@/lib/report-definition-contract";
import { classifyReportFailure, redactedReportCause, reportRunDiagnostics } from "@/lib/report-run-diagnostics";
import { resolveReportingScope } from "@/lib/reporting-scope";
import { randomUUID } from "node:crypto";

type SessionLike = { email: string; shopId?: number; role?: string; isPlatformAdmin?: boolean; enterpriseId?: string | null };

export async function authorizeReportRunInput(session: SessionLike, input: {
  definition?: unknown;
  scope?: { kind?: unknown; shopId?: unknown; enterpriseId?: unknown };
  reportId?: string;
  reportVersion?: number;
}) {
  let definition = input.definition;
  let reportId: string | undefined;
  let reportVersion: number | undefined;
  let request = input.scope || {};
  if (input.reportId) {
    const report = await findCustomReport(input.reportId);
    if (!report) throw new Error("Report not found");
    const version = input.reportVersion
      ? report.versions.find((item) => item.version === input.reportVersion)
      : report.versions.find((item) => item.version === report.currentVersion);
    if (!version) throw new Error("Report version not found");
    request = scopeRequest(report.scope);
    const scope = await resolveReportingScope(session as any, request as any);
    if (!canReadCustomReport({
      email: session.email,
      isPlatformAdmin: Boolean(session.isPlatformAdmin || session.role === "platform_admin"),
    }, report, scope)) throw new Error("Forbidden");
    definition = version.definition;
    reportId = report._id.toString();
    reportVersion = version.version;
  }
  const scope = await resolveReportingScope(session as any, {
    kind: request.kind == null ? null : String(request.kind),
    shopId: request.shopId == null ? null : String(request.shopId),
    enterpriseId: request.enterpriseId == null ? null : String(request.enterpriseId),
  });
  const plan = compileReportDefinition(definition, scope);
  return {
    definition: plan.definition,
    scope,
    executionShopIds: plan.executionShopIds,
    scopeRequest: {
      kind: scope.kind,
      ...(scope.kind === "shop" ? { shopId: scope.shopIds[0] } : {}),
      ...(scope.enterpriseId ? { enterpriseId: scope.enterpriseId } : {}),
    },
    reportId,
    reportVersion,
  };
}

export async function requestReportRun(session: SessionLike, input: {
  definition?: unknown;
  scope?: { kind?: unknown; shopId?: unknown; enterpriseId?: unknown };
  reportId?: string;
  reportVersion?: number;
  force?: boolean;
  refreshEnabled?: boolean;
}) {
  const authorized = await authorizeReportRunInput(session, input);
  if (!authorized.executionShopIds.length) {
    throw new ReportDefinitionError("Select at least one location matching the location filters", "locationIds");
  }
  return enqueueReportRun({
    requestedBy: session.email,
    reportId: authorized.reportId,
    reportVersion: authorized.reportVersion,
    definition: authorized.definition,
    scopeRequest: authorized.scopeRequest,
    authorizedShopIds: authorized.executionShopIds,
    force: input.force,
    refreshEnabled: input.refreshEnabled,
  });
}

export async function lookupReportRun(session: SessionLike, input: {
  definition?: unknown;
  scope?: { kind?: unknown; shopId?: unknown; enterpriseId?: unknown };
  reportId?: string;
  reportVersion?: number;
}) {
  const authorized = await authorizeReportRunInput(session, input);
  const key = {
    requestedBy: session.email,
    reportId: authorized.reportId,
    reportVersion: authorized.reportVersion,
    definition: authorized.definition,
    scopeRequest: authorized.scopeRequest,
    authorizedShopIds: authorized.executionShopIds,
  };
  const current = await findReportRunByKey(key);
  if (current) return current;
  // Historical filtered runs keyed the original full authorization set.
  // Never execute that wider scope, but preserve access to its saved snapshot.
  const legacy = await findReportRunByKey({ ...key, authorizedShopIds: authorized.scope.shopIds });
  return legacy && legacy.status === "succeeded" ? readableRunFor(session, legacy._id) : null;
}

async function requesterSession(email: string): Promise<SessionLike | null> {
  const user = await findReportingRecipient(email);
  if (!user || user.status === "inactive" || user.active === false) return null;
  return {
    email,
    shopId: user.shopId,
    role: user.role,
    isPlatformAdmin: Boolean(user.isPlatformAdmin || user.role === "platform_admin"),
    enterpriseId: user.enterpriseId,
  };
}

export async function processNextReportRun() {
  const run = await claimNextReportRun();
  if (!run) return { claimed: 0, status: "idle" };
  const queueDelayMs = Date.now() - run.queuedAt.getTime();
  console.info("[report-run] claimed", { runId: run._id, queueDelayMs, attempts: run.attempts });
  let stage = "authorization";
  const correlationId = randomUUID();
  try {
    const session = await requesterSession(run.requestedBy);
    if (!session) throw new Error("Requester access is no longer active");
    const authorized = await authorizeReportRunInput(session, {
      definition: run.definition,
      scope: run.scopeRequest,
      reportId: run.reportId,
      reportVersion: run.reportVersion,
    });
    const currentIds = [...authorized.executionShopIds].sort((a, b) => a - b);
    if (JSON.stringify(currentIds) !== JSON.stringify(run.authorizedShopIds)) {
      throw new Error("Authorized reporting scope changed; run the report again");
    }
    await updateReportRunStage(run._id, "query");
    stage = "query";
    const result = await reportRunDiagnostics.run({ correlationId }, () => executeReportDefinition(run.definition, authorized.scope, {
      serviceOptions: { deadlineMs: 5 * 60_000 },
      maxDeadlineMs: 5 * 60_000,
    }));
    stage = "persist";
    await updateReportRunStage(run._id, "persist");
    await completeReportRun(run._id, result);
    console.info("[report-run] complete", { runId: run._id, queueDelayMs, durationMs: Date.now() - (run.startedAt?.getTime() || Date.now()) });
    return { claimed: 1, status: "succeeded", runId: run._id };
  } catch (cause) {
    const error = classifyReportFailure(cause, stage, correlationId);
    await failReportRun(run._id, error);
    console.error("[report-run] failed", JSON.stringify({ runId: run._id, ...error, causes: redactedReportCause(cause) }));
    return { claimed: 1, status: "failed", runId: run._id };
  }
}

export async function refreshActiveReports() {
  return enqueueActiveReportRefreshes();
}

export async function readableRunFor(session: SessionLike, id: string) {
  const run = await findReportRun(id);
  if (!run) return null;
  if (!run.reportId && run.requestedBy !== session.email.toLowerCase()) return null;
  const authorized = await authorizeReportRunInput(session, {
    definition: run.definition,
    scope: run.scopeRequest,
    reportId: run.reportId,
    reportVersion: run.reportVersion,
  });
  if (run.authorizedShopIds.some(id => !authorized.scope.shopIds.includes(id))) {
    throw new Error("Authorized reporting scope changed; run the report again");
  }
  return run;
}