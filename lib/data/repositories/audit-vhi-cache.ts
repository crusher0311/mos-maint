/**
 * Read-only cached-VHI access for the audit evaluator.
 *
 * Keep Mongo acquisition in the repository layer.  The timeout wraps both
 * acquiring the handle and querying the cache: a stalled database connection
 * must not consume the evaluator's whole deadline before VHI degradation can
 * be reported.
 */
import { getDb } from "@/lib/data/db";
import { getCachedPlan } from "@/lib/plan-cache";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";

export interface AuditVhiCacheLookup {
  shopId: number;
  vin: string;
  currentMiles?: number | null;
  timeoutMs: number;
}

export interface AuditVhiCacheDeps {
  getDb?: () => Promise<any>;
  getCachedPlan?: (
    db: any,
    vin: string,
    shopId: number,
    currentMiles?: number | null,
  ) => Promise<any>;
}

/**
 * Fetch an already-cached plan only.  This never builds/rebuilds VHI and
 * returns null on timeout, connection failure, or a cache miss.
 */
export async function getCachedAuditVhiPlan(
  lookup: AuditVhiCacheLookup,
  deps: AuditVhiCacheDeps = {},
): Promise<any | null> {
  const loadDb = deps.getDb || getDb;
  const loadPlan = deps.getCachedPlan || getCachedPlan;
  return withUpstreamTimeout(
    (async () => {
      const db = await loadDb();
      return loadPlan(
        db,
        lookup.vin.toUpperCase(),
        lookup.shopId,
        lookup.currentMiles ?? null,
      );
    })(),
    lookup.timeoutMs,
    "estimate-audit-vhi-lookup",
    null,
  );
}