import {
  RECONCILIATION_LIMITS as limits, reconciliationHash, reconciliationWindow,
  validateReconciliationDetail, type ReconciliationScope,
} from "./reconciliation-policy";

export type ReconciliationCandidate = {
  id: string; shopId: number; providerShopId: number; roId: number;
  expectedRevision: string; attempt: number;
};
export type ReconciliationOutcome = "unchanged" | "corrected" | "conflict" | "exception";
export interface ReconciliationTransaction {
  /** Must lock the current source and every affected projection until commit. */
  source(): Promise<{ revision: string; raw: unknown }>;
  /** Replace complete invoice-owned children, never shared customers/vehicles.
   * All writes, publication invalidation, and completion must commit atomically. */
  replace(raw: unknown): Promise<void>;
  complete(outcome: ReconciliationOutcome, evidenceHash: string): Promise<void>;
}
export interface ReconciliationDependencies {
  now(): Date;
  scope(shopId: number): Promise<ReconciliationScope | null>;
  /** Distributed, fenced claim. Null includes busy, cooldown, and no work. */
  claim(): Promise<ReconciliationCandidate | null>;
  /** False must also cover disabled/fallback/fail-open limiter responses. */
  acquireBackgroundSlot(): Promise<boolean>;
  detail(providerShopId: number, roId: number, signal: AbortSignal): Promise<unknown>;
  /** Fences claim ownership and runs one atomic transaction. Never autocommit. */
  transaction(candidate: ReconciliationCandidate,
    apply: (tx: ReconciliationTransaction) => Promise<void>): Promise<void>;
  defer(candidate: ReconciliationCandidate, reason: string, until: Date): Promise<void>;
  exception(candidate: ReconciliationCandidate, reason: string): Promise<void>;
}

/** No request-handler entry point. Intended only for a separately scheduled worker.
 * Storage/runtime adapters must satisfy the transaction contract before activation. */
export async function reconcileTick(deps: ReconciliationDependencies, signal?: AbortSignal) {
  const deadline = deps.now().getTime() + limits.tickMs;
  const summary = { checked: 0, corrected: 0, unchanged: 0, conflicts: 0,
    deferred: 0, exceptions: 0, requests: 0 };
  while (!signal?.aborted && deps.now().getTime() < deadline &&
      summary.requests < limits.requestsPerTick) {
    const candidate = await deps.claim();
    if (!candidate) break;
    const eligible = async () => {
      const scope = await deps.scope(candidate.shopId);
      return scope?.providerShopId === candidate.providerShopId &&
        reconciliationWindow(scope, deps.now()) ? scope : null;
    };
    const defer = async (reason: string) => {
      await deps.defer(candidate, reason, new Date(deps.now().getTime() + limits.cooldownMs));
      summary.deferred++;
    };
    if (!await eligible()) { await defer("scope_or_window"); break; }
    if (!await deps.acquireBackgroundSlot()) { await defer("capacity"); break; }
    // A limiter may wait until after closing time, cancellation, or revocation.
    const scope = await eligible();
    if (!scope || signal?.aborted || deps.now().getTime() >= deadline) {
      await defer("scope_window_or_deadline"); break;
    }
    let raw: unknown;
    try {
      summary.requests++;
      const timeout = AbortSignal.timeout(Math.min(15_000, deadline - deps.now().getTime()));
      raw = await deps.detail(candidate.providerShopId, candidate.roId,
        signal ? AbortSignal.any([timeout, signal]) : timeout);
    } catch (error: any) {
      // No automatic HTTP retry, including ambiguous transport failures.
      await defer(error?.status === 429 ? "provider_throttled" : "provider_unavailable");
      break;
    }
    try { validateReconciliationDetail(scope, candidate.roId, raw); }
    catch {
      await deps.exception(candidate, "incomplete_or_ambiguous_detail");
      summary.exceptions++; continue;
    }
    // Re-check authority after network I/O; do not apply daytime spillover.
    if (!await eligible() || signal?.aborted || deps.now().getTime() >= deadline) {
      await defer("scope_window_or_deadline"); break;
    }
    let outcome: ReconciliationOutcome = "exception";
    try {
      await deps.transaction(candidate, async tx => {
        const current = await tx.source();
        const hash = reconciliationHash(raw);
        if (current.revision !== candidate.expectedRevision) {
          outcome = "conflict";
        } else if (reconciliationHash(current.raw) === hash) {
          outcome = "unchanged";
        } else {
          await tx.replace(raw);
          outcome = "corrected";
        }
        await tx.complete(outcome, hash);
      });
      summary.checked++;
      if (outcome as ReconciliationOutcome === "corrected") summary.corrected++;
      if (outcome as ReconciliationOutcome === "unchanged") summary.unchanged++;
      if (outcome as ReconciliationOutcome === "conflict") summary.conflicts++;
    } catch {
      // Adapter must roll back the replacement and completion together.
      await defer("transaction_failed");
      break;
    }
  }
  return summary;
}
