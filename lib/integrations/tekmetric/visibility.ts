export const DASHBOARD_ACTIVE_STATUSES = ["Estimate", "Estimates", "Work-In-Progress", "Complete", "Completed"];
export function tekmetricDashboardMatch(shopId: number | string, labels: string[] = []) {
  return { shopId: { $in: [String(shopId), Number(shopId)] },
    vin: { $ne: null, $type: "string" }, status: { $in: DASHBOARD_ACTIVE_STATUSES },
    ...(labels.length ? { label: { $in: labels } } : {}) };
}
export function explainVisibility(row: any, preferences: any = {}) {
  if (!row) return "not_received";
  if (["invoice", "invoiced", "posted", "deleted", "void", "closed"].includes(String(row.status).toLowerCase())) return "terminal";
  if (!DASHBOARD_ACTIVE_STATUSES.includes(row.status)) return "filtered_status";
  if (preferences.tekmetricLabels?.length && !preferences.tekmetricLabels.includes(row.label)) return "filtered_label";
  if (typeof row.vin !== "string") return row.contextRecoveryNeeded ? "awaiting_recovery" : "incomplete_vin";
  if (preferences.showOnlyWithMileage !== false && !(row.odometer > 0)) return row.contextRecoveryNeeded ? "awaiting_recovery" : "missing_mileage_fallback_unknown";
  return "eligible_snapshot";
}
