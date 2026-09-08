import { getAppFueledDirectVhiContext } from "./appfueled-direct-vhi-context";

const MAX_IN_FLIGHT_AGE_MS = 60_000;
const MAX_IN_FLIGHT_BUILDS = 100;
const inFlight = new Map<string, { startedAt: number; promise: Promise<unknown> }>();

function sweepExpired(now = Date.now()): void {
  for (const [key, entry] of inFlight) {
    if (now - entry.startedAt >= MAX_IN_FLIGHT_AGE_MS &&
        inFlight.get(key) === entry) {
      inFlight.delete(key);
    }
  }
}

const sweepTimer = setInterval(sweepExpired, 15_000);
sweepTimer.unref?.();

function reportRevision(report: unknown): string {
  if (!report || typeof report !== "object") return "unknown";
  const value = report as Record<string, any>;
  return String(
    value.sourceRetrievedAt ??
    value.retrievedAt ??
    value.reportDate ??
    value.updatedAt ??
    "accepted",
  );
}

/**
 * Coalesces only trusted AppFueled cold builds. Resolved and rejected promises
 * are removed immediately; the age guard prevents an abandoned promise from
 * retaining the key forever.
 */
export async function runCoalescedAppFueledBuild<T>(
  shopId: number,
  vin: string,
  mileage: number,
  build: () => Promise<T>,
): Promise<T> {
  const context = getAppFueledDirectVhiContext();
  if (context?.shopId !== shopId || context.vin !== vin.toUpperCase()) return build();

  const revision = context.reportRevision || reportRevision(context.carfaxReport);
  const key = `${shopId}:${vin.toUpperCase()}:${revision}:${mileage}`;
  const now = Date.now();
  sweepExpired(now);
  const existing = inFlight.get(key);
  if (existing && now - existing.startedAt < MAX_IN_FLIGHT_AGE_MS) {
    console.log(JSON.stringify({
      event: "appfueled_direct_vhi_stage",
      stage: "build_coalesced",
      shopId,
      vin: vin.toUpperCase(),
      elapsedMs: now - existing.startedAt,
    }));
    return existing.promise as Promise<T>;
  }
  if (existing) inFlight.delete(key);
  while (inFlight.size >= MAX_IN_FLIGHT_BUILDS) {
    const oldestKey = inFlight.keys().next().value as string | undefined;
    if (!oldestKey) break;
    inFlight.delete(oldestKey);
  }

  const startedAt = now;
  const promise = build();
  inFlight.set(key, { startedAt, promise });
  try {
    const result = await promise;
    console.log(JSON.stringify({
      event: "appfueled_direct_vhi_stage",
      stage: "cold_build_complete",
      shopId,
      vin: vin.toUpperCase(),
      elapsedMs: Date.now() - startedAt,
    }));
    return result;
  } finally {
    if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
  }
}

export const __partnerBuildTest = {
  inFlightSize: () => inFlight.size,
  clear: () => inFlight.clear(),
  sweepExpired,
  seed: (key: string, startedAt: number, promise: Promise<unknown>) => {
    inFlight.set(key, { startedAt, promise });
  },
  maxAgeMs: MAX_IN_FLIGHT_AGE_MS,
};