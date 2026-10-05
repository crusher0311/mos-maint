import type { Job } from "bullmq";
import { randomUUID } from "crypto";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";
import { enforceAiBudget } from "@/lib/ai-budget";
import {
  AUDIT_AUTOMATION_COLLECTIONS,
  auditAutomationEnabled,
  type AuditState,
  type AuditProvider,
} from "@/lib/estimate-assist/audit-automation";
import {
  getEstimateAuditStateRepository,
} from "@/lib/data/repositories/estimate-audit-state";

type AuditJob = { shopId: number; provider: AuditProvider; workOrderId: string; revision: number; enqueuedAt: string };
const DEADLINE_MS = 30_000;
const LEASE_MS = DEADLINE_MS + 15_000;
const auditWorkerCounters = { claimed: 0, completed: 0, failures: 0, queueAgeTotalMs: 0 };

export function getEstimateAuditWorkerCounters() {
  return { ...auditWorkerCounters };
}

const processorDeps = {
  getRepository: getEstimateAuditStateRepository,
  getFeatureEntitlements,
  canAccessShopFeature,
  enforceAiBudget,
  evaluateAudit: undefined as undefined | ((input: any, opts?: any) => Promise<any>),
};

/** Injectable only for isolated fake-DB processor tests. */
export function configureEstimateAuditProcessorDeps(overrides: Partial<typeof processorDeps>): void {
  Object.assign(processorDeps, overrides);
}

async function bounded<T>(label: string, task: Promise<T>, ms = DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_deadline_exceeded`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lease(collection: string, key: string, token: string) {
  return { collection, key, token };
}

export async function processEstimateAudit(job: Job<AuditJob>): Promise<void> {
  const data = job.data;
  const id = `${data.shopId}:${data.provider}:${data.workOrderId}`;
  const token = `${job.id || "job"}-${data.revision}-${randomUUID()}`;
  const repo = await bounded("audit_repository", processorDeps.getRepository());
  const shopLease = lease(AUDIT_AUTOMATION_COLLECTIONS.shopLocks, String(data.shopId), token);
  const fleetLease = lease(AUDIT_AUTOMATION_COLLECTIONS.fleetLock, "fleet", token);
  let shopHeld = false;
  let fleetHeld = false;
  let timedOut = false;
  const abort = new AbortController();
  const totalTimer = setTimeout(() => { timedOut = true; abort.abort(); }, DEADLINE_MS);
  try {
    const repair = await bounded("audit_history_repair_lookup", repo.findHistoryRepair(id, data.revision));
    if (repair?.report) {
      await bounded("audit_history_repair", repo.upsertHistory(repair, repair.report, repair.completedAt || repair.updatedAt));
      await bounded("audit_history_repair_mark", repo.update(
        { _id: repair._id, revision: repair.revision, historyPending: true },
        { $unset: { historyPending: "" } },
      ));
      return;
    }
    if (!auditAutomationEnabled(data.shopId)) throw new Error("automatic_audits_disabled");
    if (!(await bounded("audit_provider_route", repo.isProviderRoutedForShop(data.shopId, data.provider)))) {
      throw new Error("provider_not_routed_for_shop");
    }
    shopHeld = await repo.acquireLease(shopLease, new Date(Date.now() + LEASE_MS));
    if (!shopHeld) throw new Error("per_shop_audit_limit");
    fleetHeld = await repo.acquireLease(fleetLease, new Date(Date.now() + LEASE_MS));
    if (!fleetHeld) throw new Error("fleet_audit_limit");
    const state = await repo.claim(id, data.revision, token, new Date(Date.now() + LEASE_MS));
    if (!state?.pendingInput) return;
    const queueAgeMs = Number.isFinite(new Date(data.enqueuedAt).getTime())
      ? Math.max(0, Date.now() - new Date(data.enqueuedAt).getTime())
      : undefined;
    auditWorkerCounters.claimed++;
    auditWorkerCounters.queueAgeTotalMs += queueAgeMs || 0;
    console.info(JSON.stringify({
      event: "estimate_audit_claimed",
      shopId: data.shopId,
      provider: data.provider,
      revision: data.revision,
      queueAgeMs,
      claimedCount: auditWorkerCounters.claimed,
      meanQueueAgeMs: Math.round(auditWorkerCounters.queueAgeTotalMs / auditWorkerCounters.claimed),
    }));
    if ((state.failureCount || 0) >= 5) {
      await repo.update(
        { _id: state._id, revision: data.revision, status: "running", runToken: token },
        { $set: { status: "failed", lastError: "audit_retry_exhausted", updatedAt: new Date() }, $unset: { runToken: "", runLeaseUntil: "" } },
      );
      return;
    }

    const entitlements = await bounded("audit_entitlements", processorDeps.getFeatureEntitlements(data.shopId));
    if (!processorDeps.canAccessShopFeature({}, entitlements, "estimate_assist")) {
      await repo.update({ _id: state._id, revision: data.revision, status: "running", runToken: token },
        { $set: { status: "failed", lastError: "estimate_assist_not_entitled", updatedAt: new Date() }, $inc: { failureCount: 1 }, $unset: { runToken: "", runLeaseUntil: "" } });
      return;
    }
    const blocked = await bounded("audit_budget", processorDeps.enforceAiBudget({ shopId: data.shopId, route: "/worker/estimate-audit" }));
    if (blocked) {
      await repo.update({ _id: state._id, revision: data.revision, status: "running", runToken: token },
        { $set: { status: "failed", lastError: "ai_budget_exhausted", updatedAt: new Date() }, $inc: { failureCount: 1 }, $unset: { runToken: "", runLeaseUntil: "" } });
      return;
    }
    const evaluateAudit = processorDeps.evaluateAudit || (await import("@/lib/estimate-assist/audit-evaluator")).evaluateAudit;
    const input = state.pendingInput;
    const report = await bounded("audit_evaluation", evaluateAudit({
      shopId: data.shopId, workOrderId: data.workOrderId, workOrderNumber: input.workOrderNumber,
      provider: data.provider, smsWorkOrderId: input.smsWorkOrderId, lineItems: input.lineItems,
      vehicleInfo: input.vehicleInfo, vehicleVin: input.vehicleVin,
      canUseMaintenance: processorDeps.canAccessShopFeature({}, entitlements, "maintenance"),
    }, { signal: abort.signal }));
    if (timedOut || abort.signal.aborted) throw new Error("audit_deadline_exceeded");
    const completedAt = new Date();
    const completed = await repo.update(
      { _id: state._id, revision: data.revision, status: "running", runToken: token },
      { $set: { status: (report.evaluation?.completeness || report.completeness) === "partial" ? "partial" : "complete", report, completedAt, updatedAt: completedAt, historyPending: true, lineItemCount: input.lineItems.length }, $unset: { pendingInput: "", runToken: "", runLeaseUntil: "" } },
    );
    if (completed.modifiedCount) {
      await bounded("audit_history_write", repo.upsertHistory({ ...state, lineItemCount: input.lineItems.length, report }, report, completedAt));
      await repo.update({ _id: state._id, revision: data.revision, historyPending: true }, { $unset: { historyPending: "" } });
      auditWorkerCounters.completed++;
      console.info(JSON.stringify({
        event: "estimate_audit_completed",
        shopId: data.shopId,
        provider: data.provider,
        revision: data.revision,
        status: (report.evaluation?.completeness || report.completeness) === "partial" ? "partial" : "complete",
        findings: report.findings.length,
        completedCount: auditWorkerCounters.completed,
      }));
    }
  } catch (error: any) {
    await repo.update(
      { _id: id, revision: data.revision, status: "running", runToken: token },
      { $set: { status: "pending", lastError: String(error?.message || error).slice(0, 240), updatedAt: new Date() }, $inc: { failureCount: 1 }, $unset: { runToken: "", runLeaseUntil: "" } },
    );
    auditWorkerCounters.failures++;
    const message = String(error?.message || error);
    const reason =
      /deadline|timeout|abort/i.test(message) ? "deadline" :
      /budget/i.test(message) ? "budget" :
      /provider.*route/i.test(message) ? "provider_route" :
      "evaluation_or_storage_failure";
    console.warn(JSON.stringify({
      event: "estimate_audit_retryable_failure",
      shopId: data.shopId,
      provider: data.provider,
      revision: data.revision,
      failureCount: auditWorkerCounters.failures,
      // Categorized operational signal only; never raw receipt/report text.
      reason,
    }));
    throw error;
  } finally {
    clearTimeout(totalTimer);
    if (fleetHeld) await repo.releaseLease(fleetLease);
    if (shopHeld) await repo.releaseLease(shopLease);
  }
}

export const __auditWorkerTest = { bounded };