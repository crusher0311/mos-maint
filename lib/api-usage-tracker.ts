import sql from "@/lib/db/postgres";

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
    rateLimit: { perMinute: 300, perSecond: 5 },
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

let inMemoryBuffer: ApiUsageRecord[] = [];
let lastFlush = Date.now();
const FLUSH_INTERVAL_MS = 10000;

const circuitBreakerState: Record<ApiProvider, {
  consecutiveFailures: number;
  openUntil: number;
  isOpen: boolean;
}> = {} as Record<ApiProvider, { consecutiveFailures: number; openUntil: number; isOpen: boolean }>;

function getMinuteBucket(date: Date): string {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d.toISOString();
}

function isCircuitBreakerOpen(provider: ApiProvider): boolean {
  const state = circuitBreakerState[provider];
  if (!state) return false;
  
  if (state.isOpen && Date.now() > state.openUntil) {
    state.isOpen = false;
    state.consecutiveFailures = 0;
    console.log(`[CircuitBreaker] ${provider} circuit closed, resuming requests`);
  }
  
  return state.isOpen;
}

function recordRateLimitFailure(provider: ApiProvider): void {
  if (!circuitBreakerState[provider]) {
    circuitBreakerState[provider] = { consecutiveFailures: 0, openUntil: 0, isOpen: false };
  }
  
  const state = circuitBreakerState[provider];
  state.consecutiveFailures++;
  
  if (state.consecutiveFailures >= 10) {
    state.isOpen = true;
    state.openUntil = Date.now() + 60000;
    console.warn(`[CircuitBreaker] ${provider} circuit OPEN - pausing requests for 60s after ${state.consecutiveFailures} consecutive failures`);
  }
}

function recordRateLimitSuccess(provider: ApiProvider): void {
  if (circuitBreakerState[provider]) {
    circuitBreakerState[provider].consecutiveFailures = 0;
  }
}

export async function acquireDistributedRateLimitSlot(
  provider: ApiProvider,
  maxRetries: number = 8
): Promise<{ acquired: boolean; waitedMs: number; currentCount: number; circuitOpen?: boolean }> {
  const config = API_PROVIDER_CONFIGS[provider];
  const limitPerMinute = config.rateLimit?.perMinute;
  
  if (!limitPerMinute) {
    return { acquired: true, waitedMs: 0, currentCount: 0 };
  }
  
  if (isCircuitBreakerOpen(provider)) {
    const state = circuitBreakerState[provider];
    const remainingMs = state.openUntil - Date.now();
    console.log(`[CircuitBreaker] ${provider} circuit open, skipping request (${Math.round(remainingMs/1000)}s remaining)`);
    return { acquired: false, waitedMs: 0, currentCount: limitPerMinute, circuitOpen: true };
  }
  
  let totalWaitedMs = 0;
  const baseWaitMs = 2000;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const now = new Date();
    const minuteBucket = getMinuteBucket(now);
    const key = `${provider}:${minuteBucket}`;
    
    const result = await sql`
      INSERT INTO api_rate_limits (key, count, created_at, expires_at)
      VALUES (${key}, 1, NOW(), ${new Date(now.getTime() + 120000)})
      ON CONFLICT (key) DO UPDATE SET count = api_rate_limits.count + 1
      RETURNING count
    `;
    
    const currentCount = Number(result[0]?.count || 1);
    
    if (currentCount <= limitPerMinute) {
      recordRateLimitSuccess(provider);
      return { acquired: true, waitedMs: totalWaitedMs, currentCount };
    }
    
    await sql`
      UPDATE api_rate_limits SET count = count - 1 WHERE key = ${key}
    `;
    
    const exponentialWait = baseWaitMs * Math.pow(2, attempt);
    const jitter = Math.random() * 1000;
    const secondsUntilNextMinute = 60 - now.getSeconds();
    const waitMs = Math.min(
      exponentialWait + jitter,
      (secondsUntilNextMinute * 1000) + 500,
      30000
    );
    
    console.log(`[RateLimit] ${provider} at ${currentCount}/${limitPerMinute}, waiting ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${maxRetries}, exponential backoff)`);
    
    await new Promise(r => setTimeout(r, waitMs));
    totalWaitedMs += waitMs;
  }
  
  recordRateLimitFailure(provider);
  console.warn(`[RateLimit] ${provider} failed to acquire slot after ${maxRetries} attempts (circuit breaker: ${circuitBreakerState[provider]?.consecutiveFailures || 0}/10)`);
  return { acquired: false, waitedMs: totalWaitedMs, currentCount: limitPerMinute };
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
    for (const record of toFlush) {
      await sql`
        INSERT INTO api_usage (
          timestamp, provider, shop_id, shop_name, endpoint, method, status_code,
          latency_ms, is_error, is_rate_limited, minute_bucket, error_message,
          error_code, request_id, retry_count, source_worker
        )
        VALUES (
          ${record.timestamp}, ${record.provider}, ${record.shopId || null}, ${record.shopName || null},
          ${record.endpoint}, ${record.method}, ${record.statusCode}, ${record.latencyMs},
          ${record.isError}, ${record.isRateLimited}, ${record.minuteBucket},
          ${record.errorMessage || null}, ${record.errorCode || null}, ${record.requestId || null},
          ${record.retryCount || null}, ${record.sourceWorker || null}
        )
      `;
    }
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

    const [currentMinuteResult, last5MinutesResult, last60MinutesResult, errorCountResult, rateLimitCountResult, avgLatencyResult, topShopsResult] = await Promise.all([
      sql`SELECT COUNT(*) as count FROM api_usage WHERE provider = ${p} AND timestamp >= ${oneMinuteAgo}`,
      sql`SELECT COUNT(*) as count FROM api_usage WHERE provider = ${p} AND timestamp >= ${fiveMinutesAgo}`,
      sql`SELECT COUNT(*) as count FROM api_usage WHERE provider = ${p} AND timestamp >= ${sixtyMinutesAgo}`,
      sql`SELECT COUNT(*) as count FROM api_usage WHERE provider = ${p} AND is_error = TRUE AND timestamp >= ${sixtyMinutesAgo}`,
      sql`SELECT COUNT(*) as count FROM api_usage WHERE provider = ${p} AND is_rate_limited = TRUE AND timestamp >= ${sixtyMinutesAgo}`,
      sql`SELECT AVG(latency_ms) as avg FROM api_usage WHERE provider = ${p} AND timestamp >= ${sixtyMinutesAgo}`,
      sql`SELECT shop_id as "shopId", COUNT(*) as count FROM api_usage WHERE provider = ${p} AND timestamp >= ${sixtyMinutesAgo} AND shop_id IS NOT NULL GROUP BY shop_id ORDER BY count DESC LIMIT 5`
    ]);

    const currentMinute = Number(currentMinuteResult[0]?.count || 0);
    const last5Minutes = Number(last5MinutesResult[0]?.count || 0);
    const last60Minutes = Number(last60MinutesResult[0]?.count || 0);
    const errorCount = Number(errorCountResult[0]?.count || 0);
    const rateLimitCount = Number(rateLimitCountResult[0]?.count || 0);

    const totalCurrentMinute = currentMinute + inMemoryCurrent;
    const total60Min = last60Minutes + inMemory60Min;
    
    let usagePercent: number | undefined;
    let warningLevel: 'ok' | 'warning' | 'critical' | 'stopped' = 'ok';
    
    if (config.rateLimit?.perMinute) {
      usagePercent = Math.round((totalCurrentMinute / config.rateLimit.perMinute) * 100);
      if (usagePercent >= 95) warningLevel = 'stopped';
      else if (usagePercent >= config.criticalThreshold * 100) warningLevel = 'critical';
      else if (usagePercent >= config.warningThreshold * 100) warningLevel = 'warning';
    }
    
    if (total60Min > 0) {
      const errorRate = errorCount / total60Min;
      if (errorRate >= 0.9) {
        warningLevel = 'critical';
      } else if (errorRate >= 0.5 && warningLevel === 'ok') {
        warningLevel = 'warning';
      }
    } else if (errorCount > 0) {
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
      avgLatencyMs: Math.round(Number(avgLatencyResult[0]?.avg) || 0),
      rateLimit: config.rateLimit,
      usagePercent,
      warningLevel,
      topShops: topShopsResult.map((s: Record<string, unknown>) => ({ shopId: Number(s.shopId), count: Number(s.count) }))
    });
  }

  const allShopIds = new Set<number>();
  for (const r of results) {
    for (const s of r.topShops) {
      if (s.shopId) allShopIds.add(s.shopId);
    }
  }

  if (allShopIds.size > 0) {
    const shopIdArray = Array.from(allShopIds).map(String);
    
    const shops = await sql`
      SELECT shop_id, name, location_identifier, tekmetric_config->>'shopId' as tekmetric_shop_id
      FROM shops
      WHERE shop_id = ANY(${shopIdArray})
         OR tekmetric_config->>'shopId' = ANY(${shopIdArray})
    `;
    
    const shopNameMap = new Map<number, string>();
    for (const shop of shops) {
      const displayName = shop.location_identifier 
        ? `${shop.name} (${shop.location_identifier})`
        : shop.name;
      
      if (shop.shop_id) {
        shopNameMap.set(Number(shop.shop_id), displayName);
      }
      if (shop.tekmetric_shop_id) {
        shopNameMap.set(Number(shop.tekmetric_shop_id), displayName);
      }
    }

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
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const hourly = await sql`
    SELECT 
      to_char(timestamp, 'YYYY-MM-DD"T"HH24":00:00Z"') as hour,
      COUNT(*) as count,
      SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors,
      AVG(latency_ms) as avg_latency
    FROM api_usage
    WHERE provider = ${provider} AND timestamp >= ${since}
    GROUP BY to_char(timestamp, 'YYYY-MM-DD"T"HH24":00:00Z"')
    ORDER BY hour ASC
  `;

  return hourly.map((h: Record<string, unknown>) => ({
    hour: h.hour as string,
    requests: Number(h.count),
    errors: Number(h.errors),
    avgLatencyMs: Math.round(Number(h.avg_latency) || 0)
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

export async function shouldThrottleProviderShared(provider: ApiProvider): Promise<{ throttle: boolean; reason?: string; currentMinute?: number; lastSecond?: number }> {
  const config = API_PROVIDER_CONFIGS[provider];
  
  const localCheck = shouldThrottleProvider(provider);
  if (localCheck.throttle) {
    return localCheck;
  }
  
  if (!config.rateLimit?.perMinute && !config.rateLimit?.perSecond) {
    return { throttle: false };
  }

  try {
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
    const fiveSecondsAgo = new Date(now.getTime() - 5 * 1000);

    const [minuteResult, recentResult] = await Promise.all([
      config.rateLimit?.perMinute 
        ? sql`SELECT COUNT(*) as count FROM api_usage WHERE provider = ${provider} AND timestamp >= ${oneMinuteAgo}`
        : Promise.resolve([{ count: 0 }]),
      config.rateLimit?.perSecond 
        ? sql`SELECT COUNT(*) as count FROM api_usage WHERE provider = ${provider} AND timestamp >= ${fiveSecondsAgo}`
        : Promise.resolve([{ count: 0 }])
    ]);

    const minuteCount = Number(minuteResult[0]?.count || 0);
    const recentCount = Number(recentResult[0]?.count || 0);

    const inMemoryMinute = inMemoryBuffer.filter(
      r => r.provider === provider && r.timestamp >= oneMinuteAgo
    ).length;
    const inMemoryRecent = inMemoryBuffer.filter(
      r => r.provider === provider && r.timestamp >= fiveSecondsAgo
    ).length;

    const totalMinute = minuteCount + inMemoryMinute;
    const totalRecent = recentCount + inMemoryRecent;

    if (config.rateLimit?.perSecond) {
      const avgPerSecond = totalRecent / 5;
      if (avgPerSecond >= config.rateLimit.perSecond) {
        return { 
          throttle: true, 
          reason: `Shared burst limit: ${avgPerSecond.toFixed(1)}/${config.rateLimit.perSecond} req/s (5s avg)`,
          currentMinute: totalMinute,
          lastSecond: totalRecent
        };
      }
    }

    if (config.rateLimit?.perMinute) {
      const usage = totalMinute / config.rateLimit.perMinute;
      if (usage >= config.criticalThreshold) {
        return { 
          throttle: true, 
          reason: `Shared limit: ${totalMinute}/${config.rateLimit.perMinute} req/min (${Math.round(usage * 100)}%)`,
          currentMinute: totalMinute,
          lastSecond: totalRecent
        };
      }
    }

    return { throttle: false, currentMinute: totalMinute, lastSecond: totalRecent };
  } catch (err) {
    console.error('[ApiUsageTracker] Shared throttle check failed:', err);
    return { throttle: false };
  }
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
  const limit = Math.min(query.limit || 50, 100);
  const since = query.since || new Date(Date.now() - 60 * 60 * 1000);

  let errors;
  let totalResult;
  
  if (query.provider && query.cursor) {
    const cursorId = Number(query.cursor);
    errors = await sql`
      SELECT id, timestamp, provider, shop_id as "shopId", shop_name as "shopName", 
             endpoint, method, status_code as "statusCode", error_message as "errorMessage",
             error_code as "errorCode", latency_ms as "latencyMs", request_id as "requestId",
             source_worker as "sourceWorker"
      FROM api_usage
      WHERE is_error = TRUE AND timestamp >= ${since} AND provider = ${query.provider} AND id < ${cursorId}
      ORDER BY id DESC LIMIT ${limit + 1}
    `;
    totalResult = await sql`
      SELECT COUNT(*) as count FROM api_usage WHERE is_error = TRUE AND timestamp >= ${since} AND provider = ${query.provider}
    `;
  } else if (query.provider) {
    errors = await sql`
      SELECT id, timestamp, provider, shop_id as "shopId", shop_name as "shopName", 
             endpoint, method, status_code as "statusCode", error_message as "errorMessage",
             error_code as "errorCode", latency_ms as "latencyMs", request_id as "requestId",
             source_worker as "sourceWorker"
      FROM api_usage
      WHERE is_error = TRUE AND timestamp >= ${since} AND provider = ${query.provider}
      ORDER BY id DESC LIMIT ${limit + 1}
    `;
    totalResult = await sql`
      SELECT COUNT(*) as count FROM api_usage WHERE is_error = TRUE AND timestamp >= ${since} AND provider = ${query.provider}
    `;
  } else if (query.cursor) {
    const cursorId = Number(query.cursor);
    errors = await sql`
      SELECT id, timestamp, provider, shop_id as "shopId", shop_name as "shopName", 
             endpoint, method, status_code as "statusCode", error_message as "errorMessage",
             error_code as "errorCode", latency_ms as "latencyMs", request_id as "requestId",
             source_worker as "sourceWorker"
      FROM api_usage
      WHERE is_error = TRUE AND timestamp >= ${since} AND id < ${cursorId}
      ORDER BY id DESC LIMIT ${limit + 1}
    `;
    totalResult = await sql`
      SELECT COUNT(*) as count FROM api_usage WHERE is_error = TRUE AND timestamp >= ${since}
    `;
  } else {
    errors = await sql`
      SELECT id, timestamp, provider, shop_id as "shopId", shop_name as "shopName", 
             endpoint, method, status_code as "statusCode", error_message as "errorMessage",
             error_code as "errorCode", latency_ms as "latencyMs", request_id as "requestId",
             source_worker as "sourceWorker"
      FROM api_usage
      WHERE is_error = TRUE AND timestamp >= ${since}
      ORDER BY id DESC LIMIT ${limit + 1}
    `;
    totalResult = await sql`
      SELECT COUNT(*) as count FROM api_usage WHERE is_error = TRUE AND timestamp >= ${since}
    `;
  }

  const total = Number(totalResult[0]?.count || 0);
  const hasMore = errors.length > limit;
  if (hasMore) errors.pop();

  const lastError = errors[errors.length - 1];

  return {
    errors: errors.map((e: Record<string, unknown>) => ({
      _id: String(e.id),
      timestamp: e.timestamp as Date,
      provider: e.provider as ApiProvider,
      shopId: e.shopId as number | undefined,
      shopName: e.shopName as string | undefined,
      endpoint: e.endpoint as string,
      method: e.method as string,
      statusCode: e.statusCode as number,
      errorMessage: e.errorMessage as string | undefined,
      errorCode: e.errorCode as string | undefined,
      latencyMs: e.latencyMs as number,
      requestId: e.requestId as string | undefined,
      sourceWorker: e.sourceWorker as string | undefined
    })),
    total,
    hasMore,
    nextCursor: hasMore && lastError ? String(lastError.id) : undefined
  };
}

export async function getShopRequests(
  shopId: number | null,
  query: { provider?: ApiProvider; since?: Date; limit?: number; cursor?: string }
): Promise<{
  requests: ErrorRecord[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
  stats: { total: number; errors: number; avgLatency: number };
}> {
  const limit = Math.min(query.limit || 50, 100);
  const since = query.since || new Date(Date.now() - 60 * 60 * 1000);

  let requests;
  let totalResult;
  let statsResult;
  
  if (query.provider && query.cursor) {
    const cursorId = Number(query.cursor);
    requests = await sql`
      SELECT id, timestamp, provider, shop_id as "shopId", shop_name as "shopName", 
             endpoint, method, status_code as "statusCode", error_message as "errorMessage",
             error_code as "errorCode", latency_ms as "latencyMs", request_id as "requestId",
             source_worker as "sourceWorker"
      FROM api_usage
      WHERE shop_id = ${String(shopId)} AND timestamp >= ${since} AND provider = ${query.provider} AND id < ${cursorId}
      ORDER BY id DESC LIMIT ${limit + 1}
    `;
    totalResult = await sql`
      SELECT COUNT(*) as count FROM api_usage WHERE shop_id = ${String(shopId)} AND timestamp >= ${since} AND provider = ${query.provider}
    `;
    statsResult = await sql`
      SELECT COUNT(*) as total, SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors, AVG(latency_ms) as avg_latency
      FROM api_usage WHERE shop_id = ${String(shopId)} AND timestamp >= ${since} AND provider = ${query.provider}
    `;
  } else if (query.provider) {
    requests = await sql`
      SELECT id, timestamp, provider, shop_id as "shopId", shop_name as "shopName", 
             endpoint, method, status_code as "statusCode", error_message as "errorMessage",
             error_code as "errorCode", latency_ms as "latencyMs", request_id as "requestId",
             source_worker as "sourceWorker"
      FROM api_usage
      WHERE shop_id = ${String(shopId)} AND timestamp >= ${since} AND provider = ${query.provider}
      ORDER BY id DESC LIMIT ${limit + 1}
    `;
    totalResult = await sql`
      SELECT COUNT(*) as count FROM api_usage WHERE shop_id = ${String(shopId)} AND timestamp >= ${since} AND provider = ${query.provider}
    `;
    statsResult = await sql`
      SELECT COUNT(*) as total, SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors, AVG(latency_ms) as avg_latency
      FROM api_usage WHERE shop_id = ${String(shopId)} AND timestamp >= ${since} AND provider = ${query.provider}
    `;
  } else if (query.cursor) {
    const cursorId = Number(query.cursor);
    requests = await sql`
      SELECT id, timestamp, provider, shop_id as "shopId", shop_name as "shopName", 
             endpoint, method, status_code as "statusCode", error_message as "errorMessage",
             error_code as "errorCode", latency_ms as "latencyMs", request_id as "requestId",
             source_worker as "sourceWorker"
      FROM api_usage
      WHERE shop_id = ${String(shopId)} AND timestamp >= ${since} AND id < ${cursorId}
      ORDER BY id DESC LIMIT ${limit + 1}
    `;
    totalResult = await sql`
      SELECT COUNT(*) as count FROM api_usage WHERE shop_id = ${String(shopId)} AND timestamp >= ${since}
    `;
    statsResult = await sql`
      SELECT COUNT(*) as total, SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors, AVG(latency_ms) as avg_latency
      FROM api_usage WHERE shop_id = ${String(shopId)} AND timestamp >= ${since}
    `;
  } else {
    requests = await sql`
      SELECT id, timestamp, provider, shop_id as "shopId", shop_name as "shopName", 
             endpoint, method, status_code as "statusCode", error_message as "errorMessage",
             error_code as "errorCode", latency_ms as "latencyMs", request_id as "requestId",
             source_worker as "sourceWorker"
      FROM api_usage
      WHERE shop_id = ${String(shopId)} AND timestamp >= ${since}
      ORDER BY id DESC LIMIT ${limit + 1}
    `;
    totalResult = await sql`
      SELECT COUNT(*) as count FROM api_usage WHERE shop_id = ${String(shopId)} AND timestamp >= ${since}
    `;
    statsResult = await sql`
      SELECT COUNT(*) as total, SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as errors, AVG(latency_ms) as avg_latency
      FROM api_usage WHERE shop_id = ${String(shopId)} AND timestamp >= ${since}
    `;
  }

  const total = Number(totalResult[0]?.count || 0);
  const hasMore = requests.length > limit;
  if (hasMore) requests.pop();

  const lastRequest = requests[requests.length - 1];

  return {
    requests: requests.map((e: Record<string, unknown>) => ({
      _id: String(e.id),
      timestamp: e.timestamp as Date,
      provider: e.provider as ApiProvider,
      shopId: e.shopId as number | undefined,
      shopName: e.shopName as string | undefined,
      endpoint: e.endpoint as string,
      method: e.method as string,
      statusCode: e.statusCode as number,
      errorMessage: e.errorMessage as string | undefined,
      errorCode: e.errorCode as string | undefined,
      latencyMs: e.latencyMs as number,
      requestId: e.requestId as string | undefined,
      sourceWorker: e.sourceWorker as string | undefined
    })),
    total,
    hasMore,
    nextCursor: hasMore && lastRequest ? String(lastRequest.id) : undefined,
    stats: {
      total: Number(statsResult[0]?.total || 0),
      errors: Number(statsResult[0]?.errors || 0),
      avgLatency: Math.round(Number(statsResult[0]?.avg_latency) || 0)
    }
  };
}
