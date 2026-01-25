import { getDb } from "@/lib/mongo";

interface UsageRecord {
  timestamp: Date;
  shopId?: number;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  is429: boolean;
  minuteBucket: string;
}

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
const BURST_LIMIT_PER_SECOND = 10;

let inMemoryBuffer: UsageRecord[] = [];
let lastFlush = Date.now();
const FLUSH_INTERVAL_MS = 10000;

function getMinuteBucket(date: Date): string {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d.toISOString();
}

export async function trackTekmetricRequest(
  endpoint: string,
  method: string,
  statusCode: number,
  latencyMs: number,
  shopId?: number
): Promise<void> {
  const now = new Date();
  const record: UsageRecord = {
    timestamp: now,
    shopId,
    endpoint,
    method,
    statusCode,
    latencyMs,
    is429: statusCode === 429,
    minuteBucket: getMinuteBucket(now)
  };

  inMemoryBuffer.push(record);

  if (Date.now() - lastFlush > FLUSH_INTERVAL_MS || inMemoryBuffer.length > 50) {
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
    await db.collection("tekmetric_api_usage").insertMany(toFlush);
  } catch (err) {
    console.error("[TekmetricUsageTracker] Failed to flush:", err);
    inMemoryBuffer = [...toFlush, ...inMemoryBuffer];
  }
}

export async function getTekmetricUsageStats(): Promise<UsageStats> {
  const db = await getDb();
  const now = new Date();
  
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const sixtyMinutesAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const inMemoryCurrent = inMemoryBuffer.filter(r => r.timestamp >= oneMinuteAgo).length;
  const inMemory5Min = inMemoryBuffer.filter(r => r.timestamp >= fiveMinutesAgo).length;
  const inMemory60Min = inMemoryBuffer.filter(r => r.timestamp >= sixtyMinutesAgo).length;

  const [currentMinute, last5Minutes, last60Minutes, errors429, topShopsAgg] = await Promise.all([
    db.collection("tekmetric_api_usage").countDocuments({ timestamp: { $gte: oneMinuteAgo } }),
    db.collection("tekmetric_api_usage").countDocuments({ timestamp: { $gte: fiveMinutesAgo } }),
    db.collection("tekmetric_api_usage").countDocuments({ timestamp: { $gte: sixtyMinutesAgo } }),
    db.collection("tekmetric_api_usage").find({ 
      is429: true, 
      timestamp: { $gte: sixtyMinutesAgo } 
    }).sort({ timestamp: -1 }).limit(10).toArray(),
    db.collection("tekmetric_api_usage").aggregate([
      { $match: { timestamp: { $gte: sixtyMinutesAgo }, shopId: { $exists: true } } },
      { $group: { _id: "$shopId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray()
  ]);

  const currentMinuteRequests = currentMinute + inMemoryCurrent;
  const last5MinutesRequests = last5Minutes + inMemory5Min;
  const last60MinutesRequests = last60Minutes + inMemory60Min;

  return {
    currentMinuteRequests,
    last5MinutesRequests,
    last60MinutesRequests,
    requestsPerMinuteLimit: REQUEST_LIMIT_PER_MINUTE,
    usagePercent: Math.round((currentMinuteRequests / REQUEST_LIMIT_PER_MINUTE) * 100),
    is429Count: errors429.length,
    topShops: topShopsAgg.map(s => ({ shopId: s._id, count: s.count })),
    recentErrors: errors429.map(e => ({ 
      timestamp: e.timestamp, 
      endpoint: e.endpoint, 
      shopId: e.shopId 
    }))
  };
}

export function shouldThrottle(): { throttle: boolean; reason?: string } {
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  const oneSecondAgo = now - 1000;

  const requestsLastMinute = inMemoryBuffer.filter(r => r.timestamp.getTime() >= oneMinuteAgo).length;
  const requestsLastSecond = inMemoryBuffer.filter(r => r.timestamp.getTime() >= oneSecondAgo).length;

  if (requestsLastSecond >= BURST_LIMIT_PER_SECOND) {
    return { throttle: true, reason: `Burst limit: ${requestsLastSecond}/${BURST_LIMIT_PER_SECOND} req/s` };
  }

  if (requestsLastMinute >= REQUEST_LIMIT_PER_MINUTE * 0.85) {
    return { throttle: true, reason: `Near limit: ${requestsLastMinute}/${REQUEST_LIMIT_PER_MINUTE} req/min (85%)` };
  }

  return { throttle: false };
}

export async function getUsageWarningLevel(): Promise<'ok' | 'warning' | 'critical' | 'stopped'> {
  const stats = await getTekmetricUsageStats();
  
  if (stats.usagePercent >= 95) return 'stopped';
  if (stats.usagePercent >= 85) return 'critical';
  if (stats.usagePercent >= 75) return 'warning';
  return 'ok';
}
