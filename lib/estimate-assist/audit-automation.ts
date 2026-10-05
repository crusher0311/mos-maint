import { createHash } from "crypto";
import type { AuditLineItem, AuditReport, AuditVehicleMetadata } from "./audit-engine";
import { enqueueEstimateAudit } from "@/lib/queue/producer";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";
import { createEstimateAuditStateRepository } from "@/lib/data/repositories/estimate-audit-state";

/**
 * Durable, receipt-driven audit state. This module deliberately does not
 * create indexes: this repository's development Mongo points at production.
 * Operators create the documented indexes before enabling the feature.
 */
export const AUDIT_AUTOMATION_COLLECTIONS = {
  states: "estimate_audit_states",
  // Existing history UI reads this collection. Automation rows are
  // distinguished by `automation: true` and revision-based ids.
  history: "estimate_audits",
  shopLocks: "estimate_audit_shop_locks",
  fleetLock: "estimate_audit_fleet_lock",
} as const;

export const AUDIT_EVALUATOR_VERSION = "audit-evaluator-v1";
export const AUDIT_FRESH_MS = 15 * 60 * 1000;
export const AUDIT_STALE_PENDING_MS = 5 * 60 * 1000;
export const AUDIT_RECEIPT_RETRY_LIMIT = 5;

export type AuditProvider = "tekmetric" | "protractor" | "shopware" | "shopmonkey";
export type AuditReceiptSource = "webhook" | "poll" | "live" | "backfill";
export type AuditStateStatus = "pending" | "running" | "complete" | "partial" | "failed";

export type AuditAutomationInput = {
  shopId: number;
  provider: AuditProvider;
  /** Stable provider-side primary key, never an MOS display number. */
  workOrderId: string;
  workOrderNumber?: string;
  smsWorkOrderId?: string;
  lineItems: AuditLineItem[];
  vehicleInfo?: AuditVehicleMetadata & { mileage?: number; drivetrain?: string };
  vehicleVin?: string | null;
  canUseMaintenance: boolean;
  /** Complete tickets may legitimately have zero jobs; partial ones never run. */
  completeTicket: boolean;
  source: AuditReceiptSource;
  /** Provider revision/date used to reject a reordered older receipt. */
  upstreamRevision?: string | null;
  upstreamUpdatedAt?: string | Date | null;
};

export type AuditState = {
  _id: string;
  shopId: number;
  provider: AuditProvider;
  workOrderId: string;
  workOrderNumber?: string;
  smsWorkOrderId?: string;
  revision: number;
  inputFingerprint: string;
  evaluatorVersion: string;
  status: AuditStateStatus;
  completeness: "complete" | "partial";
  pendingInput?: Omit<AuditAutomationInput, "shopId" | "provider" | "workOrderId" | "source">;
  report?: AuditReport;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  lastReceiptAt?: Date;
  lastError?: string;
  upstreamRevision?: string;
  upstreamUpdatedAt?: Date;
  runToken?: string;
  runLeaseUntil?: Date;
  historyPending?: boolean;
  lineItemCount?: number;
  failureCount?: number;
};

export type AuditAutomationDeps = {
  getFeatureEntitlements?: typeof getFeatureEntitlements;
  canAccessShopFeature?: typeof canAccessShopFeature;
  enqueue?: typeof enqueueEstimateAudit;
  now?: () => Date;
};

export function auditStateId(shopId: number, provider: AuditProvider, workOrderId: string): string {
  // _id is the uniqueness constraint even before the operator-created index.
  // Do not use ":" in BullMQ job ids; this value is only a Mongo key.
  return `${shopId}:${provider}:${workOrderId}`;
}

function enabledShopSet(): Set<number> {
  return new Set(
    (process.env.ESTIMATE_AUDIT_AUTOMATION_SHOPS || "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0),
  );
}

export function auditAutomationEnabled(shopId: number): boolean {
  if (process.env.ESTIMATE_AUDIT_AUTOMATION_DISABLED === "true") return false;
  return process.env.ESTIMATE_AUDIT_AUTOMATION_ENABLED === "true" || enabledShopSet().has(shopId);
}

export function auditAutomationUnavailableReason(shopId: number): string | undefined {
  if (!auditAutomationEnabled(shopId)) return "automatic_audits_disabled";
  if (!process.env.REDIS_URL) return "audit_queue_unavailable";
  if (process.env.ESTIMATE_AUDIT_WORKER_ENABLED !== "true") return "audit_worker_unavailable";
  return undefined;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

/**
 * Ignores display-only formatting/order differences while preserving changes
 * that can change rule, VHI, or AI output. Item order is intentionally sorted.
 */
export function fingerprintAuditInput(input: AuditAutomationInput): string {
  const lineItems = input.lineItems
    .map((item) => ({
      title: normalizedText(item.title),
      description: normalizedText(item.description),
      type: normalizedText(item.type),
      laborHours: normalizedNumber(item.laborHours),
      laborTotal: normalizedNumber(item.laborTotal),
      partsTotal: normalizedNumber(item.partsTotal),
      total: normalizedNumber(item.total),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const vehicle = input.vehicleInfo || {};
  const stable = {
    version: AUDIT_EVALUATOR_VERSION,
    provider: input.provider,
    workOrderId: String(input.workOrderId),
    completeTicket: input.completeTicket,
    lineItems,
    vehicle: {
      vin: normalizedText(input.vehicleVin || vehicle.vin).toUpperCase(),
      year: normalizedNumber(vehicle.year),
      make: normalizedText(vehicle.make),
      model: normalizedText(vehicle.model),
      mileage: normalizedNumber(vehicle.mileage),
      drivetrain: normalizedText(vehicle.drivetrain),
    },
    canUseMaintenance: input.canUseMaintenance,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function receiptTime(input: AuditAutomationInput): Date | null {
  if (!input.upstreamUpdatedAt) return null;
  const date = new Date(input.upstreamUpdatedAt);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isOlderReceipt(current: AuditState, input: AuditAutomationInput): boolean {
  const incoming = receiptTime(input);
  const currentAt = current.upstreamUpdatedAt ? new Date(current.upstreamUpdatedAt) : null;
  // Once a provider has supplied authoritative ordering metadata, a later
  // sparse receipt without it is never permitted to replace that snapshot.
  if (currentAt && !incoming) return true;
  if (incoming && currentAt && incoming.getTime() < currentAt.getTime()) return true;
  // Provider revision is an equality/version guard, not an ordering mechanism:
  // opaque ids are not reliably lexical across all four SMS providers.
  return Boolean(
    incoming && currentAt && incoming.getTime() === currentAt.getTime() &&
    input.upstreamRevision && current.upstreamRevision &&
    input.upstreamRevision !== current.upstreamRevision &&
    current.inputFingerprint !== fingerprintAuditInput(input),
  );
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 240);
}

/**
 * Lightweight receipt handoff. It never invokes the evaluator or makes an
 * upstream request. Backfill receipts are explicitly excluded. Repeated
 * receipts for the same fingerprint only re-drive an already-pending job.
 */
export async function scheduleAuditFromReceipt(
  db: any,
  input: AuditAutomationInput,
  deps: AuditAutomationDeps = {},
  receiptCasRetries = 0,
): Promise<{ scheduled: boolean; reason: string; revision?: number }> {
  if (input.source === "backfill") return { scheduled: false, reason: "backfill_excluded" };
  if (!auditAutomationEnabled(input.shopId)) return { scheduled: false, reason: "disabled" };
  if (!input.completeTicket) return { scheduled: false, reason: "partial_ticket" };
  if (!input.provider || !input.workOrderId) return { scheduled: false, reason: "missing_identity" };
  if (!["tekmetric", "protractor", "shopware", "shopmonkey"].includes(input.provider)) {
    return { scheduled: false, reason: "unsupported_provider" };
  }
  // Gate at admission as well as in the worker. This prevents an entitlement
  // change from accumulating jobs, while the worker recheck closes the race.
  try {
    const entitlements = await (deps.getFeatureEntitlements || getFeatureEntitlements)(input.shopId);
    const hasFeature = deps.canAccessShopFeature || canAccessShopFeature;
    if (!hasFeature({}, entitlements, "estimate_assist")) {
      return { scheduled: false, reason: "estimate_assist_not_entitled" };
    }
  } catch (error) {
    return { scheduled: false, reason: `entitlement_unavailable:${safeError(error)}` };
  }

  const now = deps.now ? deps.now() : new Date();
  const _id = auditStateId(input.shopId, input.provider, String(input.workOrderId));
  const fingerprint = fingerprintAuditInput(input);
  const repository = createEstimateAuditStateRepository(db);
  let current = await repository.findState(_id);

  if (current && isOlderReceipt(current, input)) {
    return { scheduled: false, reason: "older_receipt", revision: current.revision };
  }

  // A fresh completed revision remains valid; a pending/failed revision is
  // re-driven so a transient Redis outage heals on a later duplicate receipt.
  if (
    current &&
    current.inputFingerprint === fingerprint &&
    current.evaluatorVersion === AUDIT_EVALUATOR_VERSION
  ) {
    const watermark = {
      upstreamRevision: input.upstreamRevision ? String(input.upstreamRevision) : undefined,
      upstreamUpdatedAt: receiptTime(input) || undefined,
    };
    const touched = await repository.touchReceipt(current, now, watermark);
    // A same-content duplicate may race a changed receipt. Re-read before
    // deciding: the winning receipt's watermark determines whether this
    // delivery is now older. Retrying once lets a newer same-content receipt
    // supersede a concurrently accepted older snapshot without regressions.
    if (!touched.modifiedCount) {
      if (receiptCasRetries < 1) {
        return scheduleAuditFromReceipt(db, input, deps, receiptCasRetries + 1);
      }
      const latest = await repository.findState(_id);
      if (latest && isOlderReceipt(latest, input)) {
        return { scheduled: false, reason: "older_receipt", revision: latest.revision };
      }
      return { scheduled: false, reason: "concurrent_receipt", revision: latest?.revision };
    }
    // The subsequent stale-completion replacement uses the same receipt CAS.
    // Keep its expected watermark aligned with the successful atomic touch.
    current = { ...current, ...watermark };
    if (
      (current.status === "pending" || current.status === "failed") &&
      (current.failureCount || 0) >= AUDIT_RECEIPT_RETRY_LIMIT
    ) {
      return { scheduled: false, reason: "retry_exhausted", revision: current.revision };
    }
    const completedAt = new Date(current.completedAt || current.updatedAt).getTime();
    const fresh = Date.now() - completedAt <= AUDIT_FRESH_MS;
    if ((current.status === "complete" || current.status === "partial") && fresh) {
      if (current.historyPending) {
        const repair = await (deps.enqueue || enqueueEstimateAudit)({
          shopId: input.shopId,
          provider: input.provider,
          workOrderId: String(input.workOrderId),
          revision: current.revision,
          enqueuedAt: now.toISOString(),
        });
        return {
          scheduled: repair.enqueued || repair.reason === "duplicate",
          reason: repair.enqueued ? "history_repair" : repair.reason,
          revision: current.revision,
        };
      }
      return { scheduled: false, reason: "unchanged", revision: current.revision };
    }
    // Freshness expiry must produce a new evaluation revision because VHI and
    // entitlement-dependent evidence can have changed without a RO edit.
    if ((current.status === "complete" || current.status === "partial") && !fresh) {
      current = { ...current, inputFingerprint: "__expired__" };
    } else if (
      current.status === "running" &&
      current.runLeaseUntil &&
      new Date(current.runLeaseUntil).getTime() <= now.getTime()
    ) {
      const reclaimed = await repository.reclaimRunning(_id, current.revision, now);
      if (reclaimed.modifiedCount) {
        const retry = await (deps.enqueue || enqueueEstimateAudit)({ shopId: input.shopId, provider: input.provider, workOrderId: String(input.workOrderId), revision: current.revision, enqueuedAt: now.toISOString() });
        return { scheduled: retry.enqueued || retry.reason === "duplicate", reason: retry.enqueued ? "reclaimed" : retry.reason, revision: current.revision };
      }
    }
    if (current.inputFingerprint !== "__expired__") {
      if (current.status === "failed") {
        if ((current.failureCount || 0) >= AUDIT_RECEIPT_RETRY_LIMIT) {
          return { scheduled: false, reason: "retry_exhausted", revision: current.revision };
        }
        const revived = await repository.reviveFailed(_id, current.revision, now);
        if (!revived.modifiedCount) return { scheduled: false, reason: "concurrent_receipt", revision: current.revision };
      }
      const retry = await (deps.enqueue || enqueueEstimateAudit)({
        shopId: input.shopId,
        provider: input.provider,
        workOrderId: String(input.workOrderId),
        revision: current.revision,
        enqueuedAt: now.toISOString(),
      });
      return { scheduled: retry.enqueued || retry.reason === "duplicate", reason: retry.enqueued ? "redriven" : retry.reason, revision: current.revision };
    }
  }

  // _id provides durable identity. CAS on revision prevents a late receipt
  // from replacing a newer revision; retry once if a concurrent receipt wins.
  const incomingUpdatedAt = receiptTime(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    const expectedRevision = current?.revision;
    const revision = (expectedRevision || 0) + 1;
    try {
      const result = await repository.writeReceiptRevision(
        _id,
        current || null,
        {
          $set: {
            shopId: input.shopId,
            provider: input.provider,
            workOrderId: String(input.workOrderId),
            workOrderNumber: input.workOrderNumber,
            smsWorkOrderId: input.smsWorkOrderId,
            revision,
            inputFingerprint: fingerprint,
            evaluatorVersion: AUDIT_EVALUATOR_VERSION,
            status: "pending",
            completeness: "complete",
            pendingInput: {
              workOrderNumber: input.workOrderNumber,
              smsWorkOrderId: input.smsWorkOrderId,
              lineItems: input.lineItems,
              vehicleInfo: input.vehicleInfo,
              vehicleVin: input.vehicleVin,
              canUseMaintenance: input.canUseMaintenance,
              completeTicket: true,
            },
            updatedAt: now,
            lastReceiptAt: now,
            lastError: undefined,
            failureCount: 0,
            ...(input.upstreamRevision
              ? { upstreamRevision: String(input.upstreamRevision) }
              : {}),
            ...(incomingUpdatedAt ? { upstreamUpdatedAt: incomingUpdatedAt } : {}),
          },
          $setOnInsert: { createdAt: now },
          $unset: {
            report: "",
            completedAt: "",
            ...(input.upstreamRevision ? {} : { upstreamRevision: "" }),
            ...(incomingUpdatedAt ? {} : { upstreamUpdatedAt: "" }),
          },
        },
      );
      if (result.matchedCount || result.upsertedCount) {
        const queued = await (deps.enqueue || enqueueEstimateAudit)({
          shopId: input.shopId,
          provider: input.provider,
          workOrderId: String(input.workOrderId),
          revision,
          enqueuedAt: now.toISOString(),
        });
        return { scheduled: queued.enqueued || queued.reason === "duplicate", reason: queued.enqueued ? "queued" : queued.reason, revision };
      }
    } catch (error: any) {
      if (error?.code !== 11000) return { scheduled: false, reason: `state_write_failed:${safeError(error)}` };
    }
    current = await repository.findState(_id);
    if (current && isOlderReceipt(current, input)) {
      return { scheduled: false, reason: "older_receipt", revision: current.revision };
    }
    if (current?.inputFingerprint === fingerprint) break;
  }
  return { scheduled: false, reason: "concurrent_receipt" };
}

export function statusFromAuditState(state: AuditState | null, now = Date.now()): {
  status: "pending" | "stale" | "unavailable" | "partial" | "complete";
  report?: AuditReport;
  reason?: string;
  updatedAt?: string;
} {
  if (!state) return { status: "unavailable", reason: "no_audit_for_work_order" };
  const updatedAt = state.updatedAt ? new Date(state.updatedAt).toISOString() : undefined;
  if (state.status === "complete") {
    if (now - new Date(state.completedAt || state.updatedAt).getTime() > AUDIT_FRESH_MS) {
      return { status: "stale", report: state.report, reason: "audit_expired", updatedAt };
    }
    return { status: "complete", report: state.report, updatedAt };
  }
  if (state.status === "partial") {
    if (now - new Date(state.completedAt || state.updatedAt).getTime() > AUDIT_FRESH_MS) {
      return { status: "stale", report: state.report, reason: "audit_expired", updatedAt };
    }
    return { status: "partial", report: state.report, updatedAt };
  }
  if (state.status === "failed") return { status: "unavailable", reason: state.lastError || "audit_failed", updatedAt };
  if (
    state.status === "running" &&
    state.runLeaseUntil &&
    now > new Date(state.runLeaseUntil).getTime()
  ) {
    return { status: "stale", reason: "worker_lease_expired", updatedAt };
  }
  if (now - new Date(state.updatedAt).getTime() > AUDIT_STALE_PENDING_MS) {
    return { status: "stale", reason: "audit_queue_delayed", updatedAt };
  }
  return { status: "pending", updatedAt };
}