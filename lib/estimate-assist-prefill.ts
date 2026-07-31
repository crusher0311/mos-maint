/**
 * Estimate Assist prefill / identifier-preference logic (Task #979).
 *
 * Prod incident: legacy /api/dashboard/data rows carry `displayRo` as a
 * NUMBER for Protractor shops, and the Estimate Assist modal prefill called
 * `.trim()` on it — crashing the whole dashboard. Everything here coerces
 * through `String()` before any string method, and this module is the single
 * shared home for the identifier preference order so the dashboard call site
 * and the panel prefill can't drift apart.
 *
 * Preference order (most → least resolvable by the estimate-audit API):
 *   normalizedId → workOrderGuid → workOrderId → roId → displayRo
 * Open Protractor ROs only carry a GUID in normalized data; the human RO
 * number appears at close — so the RO number is the last resort.
 */

/** Loose dashboard row shape: legacy /api/dashboard/data and data-v2 rows. */
export interface EstimateAssistRowLike {
  normalizedId?: unknown;
  workOrderGuid?: unknown;
  workOrderId?: unknown;
  roId?: unknown;
  displayRo?: unknown;
}

/** Coerce any candidate id to a trimmed string; null/undefined/'' → "". */
function coerceId(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return s;
}

/**
 * Pick the audit identifier + human RO display for a dashboard row.
 * Returns empty-string workOrderId when the row has nothing auditable.
 */
export function pickEstimateAssistIdentifier(row: EstimateAssistRowLike): {
  workOrderId: string;
  roDisplay: string | undefined;
} {
  const workOrderId =
    coerceId(row.normalizedId) ||
    coerceId(row.workOrderGuid) ||
    coerceId(row.workOrderId) ||
    coerceId(row.roId) ||
    coerceId(row.displayRo);
  const roDisplay = coerceId(row.displayRo) || undefined;
  return { workOrderId, roDisplay };
}

/** Whether the row has any identifier the Estimate Assist button can use. */
export function hasAuditableIdentifier(row: EstimateAssistRowLike): boolean {
  return pickEstimateAssistIdentifier(row).workOrderId !== "";
}

/**
 * Mirror of the panel's mount-time prefill effect: given the (possibly
 * numeric / missing) props, decide the audit id to run and the value to show
 * in the input. `auditId === ""` means "don't auto-run".
 */
export function resolvePrefill(
  initialWorkOrderId: unknown,
  initialRoDisplay: unknown,
): { auditId: string; inputDisplay: string } {
  const auditId = coerceId(initialWorkOrderId);
  if (!auditId) return { auditId: "", inputDisplay: "" };
  const inputDisplay = coerceId(initialRoDisplay) || auditId;
  return { auditId, inputDisplay };
}
