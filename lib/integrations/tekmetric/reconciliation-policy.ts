import { createHash } from "node:crypto";

export type ReconciliationScope = {
  shopId: number; providerShopId: number; timezone: string;
  startHour: number; endHour: number; enabled: boolean;
};
export type ReconciliationLane = "changed" | "recent" | "historical";
export const RECONCILIATION_LIMITS = {
  requestsPerTick: 10, tickMs: 60_000, responseBytes: 3 * 1024 * 1024,
  pageSize: 20, overlapDays: 2, recentDays: 30, cooldownMs: 60 * 60_000,
} as const;

/** Object key order is immaterial; array order and repeated entries are evidence. */
export function reconciliationHash(value: unknown): string {
  const canonical = (v: any): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).sort()
      .filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Unlike historical backfill's permissive fallback, corrections fail closed. */
export function reconciliationWindow(scope: ReconciliationScope, now: Date): boolean {
  if (!scope.enabled || !Number.isSafeInteger(scope.shopId) || scope.shopId <= 0 ||
      !Number.isSafeInteger(scope.providerShopId) || scope.providerShopId <= 0 ||
      !Number.isInteger(scope.startHour) || !Number.isInteger(scope.endHour) ||
      scope.startHour < 0 || scope.startHour > 23 || scope.endHour < 0 ||
      scope.endHour > 23 || scope.startHour === scope.endHour) return false;
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: scope.timezone, hour: "2-digit", hourCycle: "h23",
    }).format(now));
    return scope.startHour < scope.endHour
      ? hour >= scope.startHour && hour < scope.endHour
      : hour >= scope.startHour || hour < scope.endHour;
  } catch { return false; }
}

function uniqueIds(rows: any[], label: string) {
  if (!Array.isArray(rows) || rows.length > 2000) throw new Error(`incomplete_${label}`);
  const ids = rows.map(r => r?.id);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length) throw new Error(`ambiguous_${label}`);
}

/** Missing child collections cannot authorize removal; explicit [] can. */
export function validateReconciliationDetail(scope: ReconciliationScope, id: number, raw: any) {
  if (!Number.isSafeInteger(id) || id <= 0 || raw?.id !== id ||
      raw?.shopId !== scope.providerShopId ||
      !Number.isSafeInteger(raw.repairOrderNumber) ||
      !Number.isFinite(Date.parse(raw.updatedDate))) throw new Error("invalid_invoice_identity");
  if (Buffer.byteLength(JSON.stringify(raw)) > RECONCILIATION_LIMITS.responseBytes)
    throw new Error("response_too_large");
  uniqueIds(raw.jobs, "jobs");
  for (const job of raw.jobs) {
    uniqueIds(job.parts, "parts");
    uniqueIds(job.labor, "labor");
  }
  // Payment omission is not proof that payments were removed.
  uniqueIds(raw.payments, "payments");
}

export function removedSourceIds(previous: any[], next: any[]): number[] {
  uniqueIds(previous, "previous"); uniqueIds(next, "next");
  const current = new Set(next.map(row => row.id));
  return previous.filter(row => !current.has(row.id)).map(row => row.id);
}
