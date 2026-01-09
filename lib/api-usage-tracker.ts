import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export type ApiProvider = 'tekmetric' | 'carfax' | 'dataone' | 'openai' | 'protractor' | 'autoflow' | 'hovercode';

interface ApiUsageRecord {
  timestamp: Date;
  provider: ApiProvider;
  shopId?: number;
  shopName?: string;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  isError: boolean;
  isRateLimited: boolean;
  minuteBucket: string;
  errorMessage?: string;
  errorCode?: string;
  requestId?: string;
  retryCount?: number;
  sourceWorker?: string;
}

export interface TrackingOptions {
  shopName?: string;
  errorMessage?: string;
  errorCode?: string;
  requestId?: string;
  retryCount?: number;
  sourceWorker?: string;
}

interface ProviderConfig {
  name: string;
  rateLimit?: { perMinute?: number; perSecond?: number };
  warningThreshold: number;
  criticalThreshold: number;
}

export const API_PROVIDER_CONFIGS: Record<ApiProvider, ProviderConfig> = {
  tekmetric: { 
    name: 'Tekmetric', 
    rateLimit: { perMinute: 600, perSecond: 10 },
    warningThreshold: 0.75,
    criticalThreshold: 0.85
  },
  carfax: { 
    name: 'CARFAX',
    warningThreshold: 0.75,
    criticalThreshold: 0.85
  },
  dataone: { 
    name: 'DataOne',
    warningThreshold: 0.75,
    criticalThreshold: 0.85
  },
  openai: { 
    name: 'OpenAI',
    warningThreshold: 0.75,
    criticalThreshold: 0.85
  },
  protractor: { 
    name: 'Protractor',
    rateLimit: { perSecond: 5 },
    warningThreshold: 0.75,
    criticalThreshold: 0.85
  },
  autoflow: { 
    name: 'AutoFlow',
    warningThreshold: 0.75,
    criticalThreshold: 0.85
  },
  hovercode: { 
    name: 'HoverCode',
    warningThreshold: 0.75,
    criticalThreshold: 0.85
  }
};

const COLLECTION_NAME = 'api_usage';

let inMemoryBuffer: ApiUsageRecord[] = [];
let lastFlush = Date.now();
const FLUSH_INTERVAL_MS = 10000;

function getMinuteBucket(date: Date): string {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d.toISOString();
}

export async function trackApiRequest(
  provider: ApiProvider,
  endpoint: string,
  method: string,
  statusCode: number,
  latencyMs: number,
  shopId?: number,
  options?: TrackingOptions
): Promise<void> {
  const now = new Date();
  const record: ApiUsageRecord = {
    timestamp: now,
    provider,
    shopId,
    shopName: options?.shopName,
    endpoint,
    method,
    statusCode,
    latencyMs,
    isError: statusCode >= 400,
    isRateLimited: statusCode === 429,
    minuteBucket: getMinuteBucket(now),
    errorMessage: options?.errorMessage ? truncateMessage(options.errorMessage, 500) : undefined,
    errorCode: options?.errorCode,
    requestId: options?.requestId || generateRequestId(),
    retryCount: options?.retryCount,
    sourceWorker: options?.sourceWorker
  };

  inMemoryBuffer.push(record);

  if (Date.now() - lastFlush > FLUSH_INTERVAL_MS || inMemoryBuffer.length > 100) {
    await flushToDb();
  }
}

function truncateMessage(msg: string, maxLength: number): string {
  if (msg.length <= maxLength) return msg;
  return msg.substring(0, maxLength - 3) + '...';
}

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}

async function flushToDb(): Promise<void> {
  if (inMemoryBuffer.length === 0) return;
  
  const toFlush = [...inMemoryBuffer];
  inMemoryBuffer = [];
  lastFlush = Date.now();

  try {
    const db = await getDb();
    await db.collection(COLLECTION_NAME).insertMany(toFlush);
  } catch (err) {
    console.error("[ApiUsageTracker] Failed to flush:", err);
    inMemoryBuffer = [...toFlush, ...inMemoryBuffer];
  }
}

export interface ProviderStats {
  provider: ApiProvider;
  name: string;
  currentMinute: number;
  last5Minutes: number;
  last60Minutes: number;
  errorCount: number;
  rateLimitCount: number;
  avgLatencyMs: number;
  rateLimit?: { perMinute?: number; perSecond?: number };
  usagePercent?: number;
  warningLevel: 'ok' | 'warning' | 'critical' | 'stopped';
  topShops: { shopId: number; shopName?: string; count: number }[];
}

export async function getApiUsageStats(provider?: ApiProvider): Promise<ProviderStats[]> {
  const db = await getDb();
  const now = new Date();
  
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const sixtyMinutesAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const providers = provider ? [provider] : Object.keys(API_PROVIDER_CONFIGS) as ApiProvider[];
  const results: ProviderStats[] = [];

  for (const p of providers) {
    const config = API_PROVIDER_CONFIGS[p];
    
    const inMemoryCurrent = inMemoryBuffer.filter(r => r.provider === p && r.timestamp >= oneMinuteAgo).length;
    const inMemory5Min = inMemoryBuffer.filter(r => r.provider === p && r.timestamp >= fiveMinutesAgo).length;
    const inMemory60Min = inMemoryBuffer.filter(r => r.provider === p && r.timestamp >= sixtyMinutesAgo).length;

    const [currentMinute, last5Minutes, last60Minutes, errorCount, rateLimitCount, avgLatency, topShops] = await Promise.all([
      db.collection(COLLECTION_NAME).countDocuments({ provider: p, timestamp: { $gte: oneMinuteAgo } }),
      db.collection(COLLECTION_NAME).countDocuments({ provider: p, timestamp: { $gte: fiveMinutesAgo } }),
      db.collection(COLLECTION_NAME).countDocuments({ provider: p, timestamp: { $gte: sixtyMinutesAgo } }),
      db.collection(COLLECTION_NAME).countDocuments({ provider: p, isError: true, timestamp: { $gte: sixtyMinutesAgo } }),
      db.collection(COLLECTION_NAME).countDocuments({ provider: p, isRateLimited: true, timestamp: { $gte: sixtyMinutesAgo } }),
      db.collection(COLLECTION_NAME).aggregate([
        { $match: { provider: p, timestamp: { $gte: sixtyMinutesAgo } } },
        { $group: { _id: null, avg: { $avg: "$latencyMs" } } }
      ]).toArray(),
      db.collection(COLLECTION_NAME).aggregate([
        { $match: { provider: p, timestamp: { $gte: sixtyMinutesAgo }, shopId: { $exists: true } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]).toArray()
    ]);

    const totalCurrentMinute = currentMinute + inMemoryCurrent;
    const total60Min = last60Minutes + inMemory60Min;
    
    let usagePercent: number | undefined;
    let warningLevel: 'ok' | 'warning' | 'critical' | 'stopped' = 'ok';
    
    // Check rate limit usage
    if (config.rateLimit?.perMinute) {
      usagePercent = Math.round((totalCurrentMinute / config.rateLimit.perMinute) * 100);
      if (usagePercent >= 95) warningLevel = 'stopped';
      else if (usagePercent >= config.criticalThreshold * 100) warningLevel = 'critical';
      else if (usagePercent >= config.warningThreshold * 100) warningLevel = 'warning';
    }
    
    // Check error rate - high error rates indicate problems
    if (total60Min > 0) {
      const errorRate = errorCount / total60Min;
      if (errorRate >= 0.9) {
        // 90%+ errors = critical
        warningLevel = 'critical';
      } else if (errorRate >= 0.5 && warningLevel === 'ok') {
        // 50%+ errors = warning (don't downgrade from rate limit issues)
        warningLevel = 'warning';
      }
    } else if (errorCount > 0) {
      // No successful requests but have errors = critical
      warningLevel = 'critical';
    }

    results.push({
      provider: p,
      name: config.name,
      currentMinute: totalCurrentMinute,
      last5Minutes: last5Minutes + inMemory5Min,
      last60Minutes: last60Minutes + inMemory60Min,
      errorCount,
      rateLimitCount,
      avgLatencyMs: Math.round(avgLatency[0]?.avg || 0),
      rateLimit: config.rateLimit,
      usagePercent,
      warningLevel,
      topShops: topShops.map(s => ({ shopId: s._id, count: s.count }))
    });
  }

  // Look up shop names for all unique shopIds across all providers
  const allShopIds = new Set<number>();
  for (const r of results) {
    for (const s of r.topShops) {
      if (s.shopId) allShopIds.add(s.shopId);
    }
  }

  if (allShopIds.size > 0) {
    const shopIdArray = Array.from(allShopIds);
    
    // Look up shops by multiple possible ID fields:
    // - shopId: MOS internal ID (used by Protractor)
    // - tekmetric.shopId or tekmetricShopId: Tekmetric's shop ID
    const shops = await db.collection("shops").find(
      { 
        $or: [
          { shopId: { $in: shopIdArray } },
          { "tekmetric.shopId": { $in: shopIdArray } },
          { tekmetricShopId: { $in: shopIdArray } }
        ]
      },
      { projection: { shopId: 1, name: 1, locationIdentifier: 1, "tekmetric.shopId": 1, tekmetricShopId: 1 } }
    ).toArray();
    
    const shopNameMap = new Map<number, string>();
    for (const shop of shops) {
      // Build display name: "Shop Name (Location)" or just "Shop Name"
      const displayName = shop.locationIdentifier 
        ? `${shop.name} (${shop.locationIdentifier})`
        : shop.name;
      
      // Map by MOS shopId
      if (shop.shopId) {
        shopNameMap.set(shop.shopId, displayName);
      }
      // Also map by Tekmetric shop ID
      const tekShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
      if (tekShopId) {
        shopNameMap.set(Number(tekShopId), displayName);
      }
    }

    // Enrich topShops with names
    for (const r of results) {
      for (const s of r.topShops) {
        s.shopName = shopNameMap.get(s.shopId);
      }
    }
  }

  return results;
}

export async function getHourlyUsage(provider: ApiProvider, hours: number = 24): Promise<{
  hour: string;
  requests: number;
  errors: number;
  avgLatencyMs: number;
}[]> {
  const db = await getDb();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const hourly = await db.collection(COLLECTION_NAME).aggregate([
    { $match: { provider, timestamp: { $gte: since } } },
    { 
      $group: { 
        _id: { $dateToString: { format: "%Y-%m-%dT%H:00:00Z", date: "$timestamp" } },
        count: { $sum: 1 },
        errors: { $sum: { $cond: ["$isError", 1, 0] } },
        avgLatency: { $avg: "$latencyMs" }
      } 
    },
    { $sort: { _id: 1 } }
  ]).toArray();

  return hourly.map(h => ({
    hour: h._id,
    requests: h.count,
    errors: h.errors,
    avgLatencyMs: Math.round(h.avgLatency || 0)
  }));
}

export function shouldThrottleProvider(provider: ApiProvider): { throttle: boolean; reason?: string } {
  const config = API_PROVIDER_CONFIGS[provider];
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  const oneSecondAgo = now - 1000;

  const recentRequests = inMemoryBuffer.filter(
    r => r.provider === provider && r.timestamp.getTime() >= oneMinuteAgo
  );

  if (config.rateLimit?.perSecond) {
    const lastSecond = recentRequests.filter(r => r.timestamp.getTime() >= oneSecondAgo).length;
    if (lastSecond >= config.rateLimit.perSecond) {
      return { throttle: true, reason: `Burst limit: ${lastSecond}/${config.rateLimit.perSecond} req/s` };
    }
  }

  if (config.rateLimit?.perMinute) {
    const usage = recentRequests.length / config.rateLimit.perMinute;
    if (usage >= config.criticalThreshold) {
      return { throttle: true, reason: `Near limit: ${recentRequests.length}/${config.rateLimit.perMinute} req/min (${Math.round(usage * 100)}%)` };
    }
  }

  return { throttle: false };
}

export interface ErrorRecord {
  _id?: string;
  timestamp: Date;
  provider: ApiProvider;
  shopId?: number;
  shopName?: string;
  endpoint: string;
  method: string;
  statusCode: number;
  errorMessage?: string;
  errorCode?: string;
  latencyMs: number;
  requestId?: string;
  sourceWorker?: string;
}

export interface DrillDownQuery {
  provider?: ApiProvider;
  shopId?: number;
  statusCode?: number;
  isError?: boolean;
  since?: Date;
  limit?: number;
  cursor?: string;
}

export async function getErrorDetails(query: DrillDownQuery): Promise<{
  errors: ErrorRecord[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}> {
  const db = await getDb();
  const limit = Math.min(query.limit || 50, 100);
  const since = query.since || new Date(Date.now() - 60 * 60 * 1000);

  const baseFilter: any = {
    isError: true,
    timestamp: { $gte: since }
  };
  
  if (query.provider) baseFilter.provider = query.provider;
  if (query.shopId) baseFilter.shopId = query.shopId;
  if (query.statusCode) baseFilter.statusCode = query.statusCode;

  const findFilter = { ...baseFilter };
  if (query.cursor) {
    try {
      findFilter._id = { $lt: new ObjectId(query.cursor) };
    } catch {
      findFilter._id = { $lt: query.cursor };
    }
  }

  const [errors, total] = await Promise.all([
    db.collection(COLLECTION_NAME)
      .find(findFilter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .toArray(),
    db.collection(COLLECTION_NAME).countDocuments(baseFilter)
  ]);

  const hasMore = errors.length > limit;
  if (hasMore) errors.pop();

  const lastError = errors[errors.length - 1];

  return {
    errors: errors.map(e => ({
      _id: e._id?.toString(),
      timestamp: e.timestamp,
      provider: e.provider,
      shopId: e.shopId,
      shopName: e.shopName,
      endpoint: e.endpoint,
      method: e.method,
      statusCode: e.statusCode,
      errorMessage: e.errorMessage,
      errorCode: e.errorCode,
      latencyMs: e.latencyMs,
      requestId: e.requestId,
      sourceWorker: e.sourceWorker
    })),
    total,
    hasMore,
    nextCursor: hasMore && lastError ? lastError._id?.toString() : undefined
  };
}

export async function getShopRequests(
  shopId: number,
  query: { provider?: ApiProvider; since?: Date; limit?: number; cursor?: string }
): Promise<{
  requests: ErrorRecord[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
  stats: { total: number; errors: number; avgLatency: number };
}> {
  const db = await getDb();
  const limit = Math.min(query.limit || 50, 100);
  const since = query.since || new Date(Date.now() - 60 * 60 * 1000);

  const baseFilter: any = {
    shopId,
    timestamp: { $gte: since }
  };
  
  if (query.provider) baseFilter.provider = query.provider;

  const findFilter = { ...baseFilter };
  if (query.cursor) {
    try {
      findFilter._id = { $lt: new ObjectId(query.cursor) };
    } catch {
      findFilter._id = { $lt: query.cursor };
    }
  }

  const [requests, total, statsResult] = await Promise.all([
    db.collection(COLLECTION_NAME)
      .find(findFilter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .toArray(),
    db.collection(COLLECTION_NAME).countDocuments(baseFilter),
    db.collection(COLLECTION_NAME).aggregate([
      { $match: baseFilter },
      { 
        $group: { 
          _id: null, 
          total: { $sum: 1 },
          errors: { $sum: { $cond: ["$isError", 1, 0] } },
          avgLatency: { $avg: "$latencyMs" }
        } 
      }
    ]).toArray()
  ]);

  const hasMore = requests.length > limit;
  if (hasMore) requests.pop();

  const stats = statsResult[0] || { total: 0, errors: 0, avgLatency: 0 };
  const lastRequest = requests[requests.length - 1];

  return {
    requests: requests.map(r => ({
      _id: r._id?.toString(),
      timestamp: r.timestamp,
      provider: r.provider,
      shopId: r.shopId,
      shopName: r.shopName,
      endpoint: r.endpoint,
      method: r.method,
      statusCode: r.statusCode,
      errorMessage: r.errorMessage,
      errorCode: r.errorCode,
      latencyMs: r.latencyMs,
      requestId: r.requestId,
      sourceWorker: r.sourceWorker
    })),
    total,
    hasMore,
    nextCursor: hasMore && lastRequest ? lastRequest._id?.toString() : undefined,
    stats: {
      total: stats.total,
      errors: stats.errors,
      avgLatency: Math.round(stats.avgLatency || 0)
    }
  };
}

export async function getRequestById(requestId: string): Promise<ErrorRecord | null> {
  const db = await getDb();
  const record = await db.collection(COLLECTION_NAME).findOne({ requestId });
  
  if (!record) return null;

  return {
    _id: record._id?.toString(),
    timestamp: record.timestamp,
    provider: record.provider,
    shopId: record.shopId,
    shopName: record.shopName,
    endpoint: record.endpoint,
    method: record.method,
    statusCode: record.statusCode,
    errorMessage: record.errorMessage,
    errorCode: record.errorCode,
    latencyMs: record.latencyMs,
    requestId: record.requestId,
    sourceWorker: record.sourceWorker
  };
}

export async function getErrorBreakdown(provider?: ApiProvider): Promise<{
  byStatusCode: { statusCode: number; count: number; label: string }[];
  byEndpoint: { endpoint: string; count: number }[];
}> {
  const db = await getDb();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  
  const filter: any = { isError: true, timestamp: { $gte: since } };
  if (provider) filter.provider = provider;

  const [byStatusCode, byEndpoint] = await Promise.all([
    db.collection(COLLECTION_NAME).aggregate([
      { $match: filter },
      { $group: { _id: "$statusCode", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray(),
    db.collection(COLLECTION_NAME).aggregate([
      { $match: filter },
      { $group: { _id: "$endpoint", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray()
  ]);

  const statusLabels: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Rate Limited',
    500: 'Internal Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
  };

  return {
    byStatusCode: byStatusCode.map(s => ({
      statusCode: s._id,
      count: s.count,
      label: statusLabels[s._id] || `HTTP ${s._id}`
    })),
    byEndpoint: byEndpoint.map(e => ({
      endpoint: e._id,
      count: e.count
    }))
  };
}

export async function ensureApiUsageIndexes(): Promise<void> {
  const db = await getDb();
  const collection = db.collection(COLLECTION_NAME);
  
  await Promise.all([
    collection.createIndex({ provider: 1, timestamp: -1 }),
    collection.createIndex({ provider: 1, isError: 1, timestamp: -1 }),
    collection.createIndex({ provider: 1, shopId: 1, timestamp: -1 }),
    collection.createIndex({ requestId: 1 }, { sparse: true }),
    collection.createIndex({ timestamp: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 })
  ]);
}
