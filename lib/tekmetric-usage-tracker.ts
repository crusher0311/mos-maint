import sql from "@/lib/db/postgres";

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
  topShops: { shopId: string; count: number }[];
  recentErrors: { timestamp: Date; endpoint: string; shopId?: string }[];
}

const REQUEST_LIMIT_PER_MINUTE = 600;
const BURST_LIMIT_PER_SECOND = 10;

let inMemoryBuffer: UsageRecord[] = [];
let lastFlush = Date.now();
const FLUSH_INTERVAL_MS = 10000;

function getMinuteBucket(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
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
    minuteBucket: getMinuteBucket(now).toISOString()
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
    for (const record of toFlush) {
      const shopIdStr = record.shopId ? String(record.shopId) : null;
      
      await sql`
        INSERT INTO tekmetric_api_usage (shop_id, endpoint, is_429, response_time, timestamp)
        VALUES (
          ${shopIdStr ? sql`(SELECT id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1)` : sql`NULL`},
          ${record.endpoint},
          ${record.is429},
          ${record.latencyMs},
          ${record.timestamp}
        )
      `;
    }
  } catch (err) {
    console.error("[TekmetricUsageTracker] Failed to flush:", err);
    inMemoryBuffer = [...toFlush, ...inMemoryBuffer];
  }
}

export async function getTekmetricUsageStats(): Promise<UsageStats> {
  const now = new Date();
  
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const sixtyMinutesAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const inMemoryCurrent = inMemoryBuffer.filter(r => r.timestamp >= oneMinuteAgo).length;
  const inMemory5Min = inMemoryBuffer.filter(r => r.timestamp >= fiveMinutesAgo).length;
  const inMemory60Min = inMemoryBuffer.filter(r => r.timestamp >= sixtyMinutesAgo).length;

  const [currentMinuteRows, last5MinutesRows, last60MinutesRows, errors429Rows, topShopsRows] = await Promise.all([
    sql`SELECT COUNT(*) as count FROM tekmetric_api_usage WHERE timestamp >= ${oneMinuteAgo}`,
    sql`SELECT COUNT(*) as count FROM tekmetric_api_usage WHERE timestamp >= ${fiveMinutesAgo}`,
    sql`SELECT COUNT(*) as count FROM tekmetric_api_usage WHERE timestamp >= ${sixtyMinutesAgo}`,
    sql`
      SELECT timestamp, endpoint, s.shop_id
      FROM tekmetric_api_usage u
      LEFT JOIN shops s ON u.shop_id = s.id
      WHERE u.is_429 = true AND u.timestamp >= ${sixtyMinutesAgo}
      ORDER BY u.timestamp DESC
      LIMIT 10
    `,
    sql`
      SELECT s.shop_id, COUNT(*) as count
      FROM tekmetric_api_usage u
      JOIN shops s ON u.shop_id = s.id
      WHERE u.timestamp >= ${sixtyMinutesAgo}
      GROUP BY s.shop_id
      ORDER BY count DESC
      LIMIT 10
    `
  ]);

  const currentMinute = Number(currentMinuteRows[0]?.count || 0);
  const last5Minutes = Number(last5MinutesRows[0]?.count || 0);
  const last60Minutes = Number(last60MinutesRows[0]?.count || 0);

  const currentMinuteRequests = currentMinute + inMemoryCurrent;
  const last5MinutesRequests = last5Minutes + inMemory5Min;
  const last60MinutesRequests = last60Minutes + inMemory60Min;

  return {
    currentMinuteRequests,
    last5MinutesRequests,
    last60MinutesRequests,
    requestsPerMinuteLimit: REQUEST_LIMIT_PER_MINUTE,
    usagePercent: Math.round((currentMinuteRequests / REQUEST_LIMIT_PER_MINUTE) * 100),
    is429Count: errors429Rows.length,
    topShops: topShopsRows.map(s => ({ shopId: s.shop_id as string, count: Number(s.count) })),
    recentErrors: errors429Rows.map(e => ({ 
      timestamp: new Date(e.timestamp as string), 
      endpoint: e.endpoint as string, 
      shopId: e.shop_id as string | undefined
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
