import type { MissedOpportunityReport, MissedOppWindow } from "@/lib/missed-opportunities";

type RefreshWork = () => Promise<MissedOpportunityReport>;

const inFlight = new Map<string, Promise<MissedOpportunityReport>>();

export function classifyMissedOpportunityLoad(input: {
  hasUsableCache: boolean;
  cacheIsFresh: boolean;
  forceRefresh: boolean;
}): "fresh_hit" | "stale_hit" | "compute" {
  if (input.hasUsableCache && input.cacheIsFresh && !input.forceRefresh) return "fresh_hit";
  if (input.hasUsableCache && !input.forceRefresh) return "stale_hit";
  return "compute";
}

export function missedOpportunityRefreshKey(shopId: number, windowDays: MissedOppWindow) {
  return `${shopId}:${windowDays}`;
}

/** Process-local single-flight. Rejections are removed so a later request retries. */
export function runMissedOpportunityRefresh(
  shopId: number,
  windowDays: MissedOppWindow,
  work: RefreshWork,
): { promise: Promise<MissedOpportunityReport>; joined: boolean } {
  const key = missedOpportunityRefreshKey(shopId, windowDays);
  const existing = inFlight.get(key);
  if (existing) return { promise: existing, joined: true };
  const promise = Promise.resolve().then(work).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return { promise, joined: false };
}

export function isMissedOpportunityRefreshPending(
  shopId: number,
  windowDays: MissedOppWindow,
): boolean {
  return inFlight.has(missedOpportunityRefreshKey(shopId, windowDays));
}