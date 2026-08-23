export interface MaintenanceScheduleResult {
  ok: boolean;
  error?: string;
}

export function classifyMaintenanceScheduleFailure(
  result: MaintenanceScheduleResult,
): { status: 404 | 502; error: string } | null {
  if (result.ok) return null;

  const upstreamError = result.error?.trim() || "Maintenance schedule lookup failed";
  const notFound = /(?:no maintenance data|vin not found|not found.*vin)/i.test(
    upstreamError,
  );

  return {
    status: notFound ? 404 : 502,
    error: upstreamError,
  };
}