/**
 * Pure marker state helpers shared by the dashboard poller and offline tests.
 * A failed reload deliberately leaves the previous marker untouched so the
 * next bounded poll retries the same durable change.
 */
export function dashboardMarkerChanged(
  previous: string | null,
  incoming: string,
): boolean {
  return previous === null || previous !== incoming;
}

export function dashboardMarkerAfterRefresh(
  previous: string | null,
  incoming: string,
  refreshed: boolean,
  responseMarker?: string,
): string | null {
  if (!refreshed) return previous;
  return responseMarker ?? incoming;
}