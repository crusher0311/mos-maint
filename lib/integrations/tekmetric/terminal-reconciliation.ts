/** Tekmetric detail reads return status.code before status.name. */
export function canonicalTerminalStatus(status: unknown): string | null {
  if (typeof status !== "string") return null;
  const key = status.trim().toLowerCase();
  const terminal: Record<string, string> = {
    invoice: "Invoiced", invoiced: "Invoiced", posted: "Posted",
    deleted: "Deleted", void: "Void", closed: "Closed",
  };
  // Complete / Completed remain active dashboard states, not terminal evidence.
  return terminal[key] || null;
}

export function absentReconciliationCandidates<T extends Record<string, any>>(
  cached: T[], activeIds: Set<string>, listingComplete: boolean, limit = 50,
): T[] {
  if (!listingComplete) return [];
  return cached.filter(row => !activeIds.has(String(row.workOrderId))).slice(0, limit);
}
