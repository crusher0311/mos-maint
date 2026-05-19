import { getDb } from "@/lib/mongo";

// Tekmetric usage stats reader.
//
// Background (task #449 / diagnosis #443): historically this module both
// tracked and read from a Tekmetric-specific `tekmetric_api_usage`
// collection. The actual write path moved to the unified `api_usage`
// collection (provider="tekmetric") in `lib/api-usage-tracker.ts` —
// `lib/integrations/tekmetric/client.ts` calls `trackApiRequest('tekmetric', ...)`,
// not `trackTekmetricRequest`. The `tekmetric_api_usage` collection has
// been empty fleet-wide since that migration, so the admin Tekmetric
// usage view rendered as all-zeroes. This module now reads from
// `api_usage` filtered by `provider: 'tekmetric'` so the view reflects
// real call volume and 429 rates.
//
// `trackTekmetricRequest` and `shouldThrottle` are retained as no-op
// shims because they're referenced by older call sites; the real
// tracking and per-process throttling now lives in `lib/api-usage-tracker.ts`
// and `lib/integrations/tekmetric/shared-rate-limiter.ts`.

interface UsageStats {
  currentMinuteRequests: number;
  last5MinutesRequests: number;
  last60MinutesRequests: number;
  requestsPerMinuteLimit: number;
  usagePercent: number;
  is429Count: number;
  topShops: { shopId: number; count: number }[];
  recentErrors: { timestamp: Date; endpoint: string; shopId?: number }[];
}

const REQUEST_LIMIT_PER_MINUTE = 600;
const USAGE_COLLECTION = "api_usage";
const TEKMETRIC_FILTER = { provider: "tekmetric" } as const;

export async function trackTekmetricRequest(
  _endpoint: string,
  _method: string,
  _statusCode: number,
  _latencyMs: number,
  _shopId?: number,
): Promise<void> {
  // No-op shim — real tracking goes through `trackApiRequest('tekmetric',...)`
  // in `lib/api-usage-tracker.ts`, called from
  // `lib/integrations/tekmetric/client.ts`. Kept exported to avoid breaking
  // any older call sites.
}

export async function getTekmetricUsageStats(): Promise<UsageStats> {
  const db = await getDb();
  const now = new Date();

  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const sixtyMinutesAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const [currentMinute, last5Minutes, last60Minutes, errors429, topShopsAgg] = await Promise.all([
    db.collection(USAGE_COLLECTION).countDocuments({ ...TEKMETRIC_FILTER, timestamp: { $gte: oneMinuteAgo } }),
    db.collection(USAGE_COLLECTION).countDocuments({ ...TEKMETRIC_FILTER, timestamp: { $gte: fiveMinutesAgo } }),
    db.collection(USAGE_COLLECTION).countDocuments({ ...TEKMETRIC_FILTER, timestamp: { $gte: sixtyMinutesAgo } }),
    db.collection(USAGE_COLLECTION).find({
      ...TEKMETRIC_FILTER,
      $or: [{ isRateLimited: true }, { statusCode: 429 }],
      timestamp: { $gte: sixtyMinutesAgo },
    }).sort({ timestamp: -1 }).limit(10).toArray(),
    db.collection(USAGE_COLLECTION).aggregate([
      { $match: { ...TEKMETRIC_FILTER, timestamp: { $gte: sixtyMinutesAgo }, shopId: { $exists: true, $ne: null } } },
      { $group: { _id: "$shopId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray()
  ]);

  return {
    currentMinuteRequests: currentMinute,
    last5MinutesRequests: last5Minutes,
    last60MinutesRequests: last60Minutes,
    requestsPerMinuteLimit: REQUEST_LIMIT_PER_MINUTE,
    usagePercent: Math.round((currentMinute / REQUEST_LIMIT_PER_MINUTE) * 100),
    is429Count: errors429.length,
    topShops: topShopsAgg.map(s => ({ shopId: s._id as number, count: s.count as number })),
    recentErrors: errors429.map(e => ({
      timestamp: e.timestamp as Date,
      endpoint: e.endpoint as string,
      shopId: e.shopId as number | undefined,
    }))
  };
}

export function shouldThrottle(): { throttle: boolean; reason?: string } {
  // Real throttling lives in `lib/api-usage-tracker.ts#shouldThrottleProvider`
  // and the cross-process limiter in `shared-rate-limiter.ts`. This shim is
  // retained as a permissive default for any straggling caller.
  return { throttle: false };
}

export async function getUsageWarningLevel(): Promise<'ok' | 'warning' | 'critical' | 'stopped'> {
  const stats = await getTekmetricUsageStats();
  if (stats.usagePercent >= 95) return 'stopped';
  if (stats.usagePercent >= 85) return 'critical';
  if (stats.usagePercent >= 75) return 'warning';
  return 'ok';
}
