/**
 * Client-safe status presentation for the dashboard's bounded current-RO
 * audit reads. Keep provider identity separate from the normalized audit id.
 */
export type DashboardAuditStatus = {
  status: "pending" | "stale" | "unavailable" | "partial" | "complete";
  report?: { summary?: { critical?: number; warnings?: number } };
  reason?: string;
};

export type DashboardAuditContext = { provider: string; workOrderId: string };

const SUPPORTED_PROVIDERS = new Set(["tekmetric", "protractor", "shopware", "shopmonkey"]);

/**
 * Finds the stable, primary provider id stored by normalized ingestion.
 * Display RO numbers are deliberately excluded: estimate-audit state is keyed
 * by the provider's primary key, not by a human-facing number.
 */
export function dashboardAuditWorkOrderIdFromProvenance(
  provenance: unknown,
  provider: unknown,
): string | undefined {
  const sourceSystem = String(provider ?? "").trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(sourceSystem)) return undefined;
  const sourceIds = (provenance as any)?.sourceIds;
  if (!Array.isArray(sourceIds)) return undefined;
  const primary = sourceIds.find((sourceId: any) =>
    String(sourceId?.system ?? "").trim().toLowerCase() === sourceSystem &&
    sourceId?.isPrimary === true &&
    String(sourceId?.idValue ?? "").trim(),
  );
  const id = String(primary?.idValue ?? "").trim();
  return id || undefined;
}

export function dashboardAuditContext(row: any): DashboardAuditContext | null {
  // Rows must project both values explicitly. In particular, do not infer the
  // provider from shop configuration or use displayRo as a status id: either
  // shortcut can look up a different durable audit-state key.
  const provider = String(row?.source || "").trim().toLowerCase();
  const workOrderId = String(row?.auditWorkOrderId || "").trim();
  return SUPPORTED_PROVIDERS.has(provider) && workOrderId ? { provider, workOrderId } : null;
}

export function dashboardAuditStatusKey(context: DashboardAuditContext): string {
  return `${context.provider}|${context.workOrderId}`;
}

export function dashboardAuditStatusVisual(status?: DashboardAuditStatus): {
  symbol: string;
  label: string;
  className: string;
} | null {
  if (!status) return null;
  const critical = Number(status.report?.summary?.critical || 0);
  const warnings = Number(status.report?.summary?.warnings || 0);
  if (status.status === "complete" && critical > 0) {
    return { symbol: "⛔", label: `${critical} critical finding${critical === 1 ? " needs" : "s need"} review`, className: "bg-red-600 text-white" };
  }
  if (status.status === "complete" && warnings > 0) {
    return { symbol: "⚠", label: `${warnings} warning${warnings === 1 ? " needs" : "s need"} review`, className: "bg-amber-500 text-white" };
  }
  if (status.status === "complete") return { symbol: "✓", label: "Completed with no warning or critical findings", className: "bg-green-600 text-white" };
  const labels = {
    pending: ["…", "Audit is queued", "bg-blue-600 text-white"],
    stale: ["↻", "Latest audit is stale", "bg-gray-600 text-white"],
    partial: ["◐", "Audit completed with some checks unavailable", "bg-gray-600 text-white"],
    unavailable: ["?", `Automatic audit is unavailable${status.reason ? `: ${status.reason}` : ""}`, "bg-gray-500 text-white"],
  } as const;
  const [symbol, label, className] = labels[status.status];
  return { symbol, label, className };
}