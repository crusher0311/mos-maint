import { getDb } from "@/lib/mongo";

export type ApiProvider = 'tekmetric' | 'carfax' | 'dataone' | 'openai' | 'protractor' | 'autoflow' | 'hovercode';

interface ApiUsageRecord {
  timestamp: Date;
  provider: ApiProvider;
  shopId?: number;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  isError: boolean;
  isRateLimited: boolean;
  minuteBucket: string;
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
  shopId?: number
): Promise<void> {
  const now = new Date();
  const record: ApiUsageRecord = {
    timestamp: now,
    provider,
    shopId,
    endpoint,
    method,
    statusCode,
    latencyMs,
    isError: statusCode >= 400,
    isRateLimited: statusCode === 429,
    minuteBucket: getMinuteBucket(now)
  };

  inMemoryBuffer.push(record);

  if (Date.now() - lastFlush > FLUSH_INTERVAL_MS || inMemoryBuffer.length > 100) {
    await flushToDb();
  }
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
  topShops: { shopId: number; count: number }[];
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
