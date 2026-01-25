import NodeCache from 'node-cache';
import { createLogger } from './logger';

const logger = createLogger('cache');

interface CacheConfig {
  stdTTL: number;
  checkperiod: number;
  maxKeys: number;
}

const defaultConfig: CacheConfig = {
  stdTTL: 3600,
  checkperiod: 600,
  maxKeys: 10000,
};

const vinDecodeCache = new NodeCache({
  ...defaultConfig,
  stdTTL: 86400 * 7,
  maxKeys: 50000,
});

const maintenanceScheduleCache = new NodeCache({
  ...defaultConfig,
  stdTTL: 86400,
  maxKeys: 20000,
});

const shopConfigCache = new NodeCache({
  ...defaultConfig,
  stdTTL: 300,
  maxKeys: 1000,
});

const apiResponseCache = new NodeCache({
  ...defaultConfig,
  stdTTL: 60,
  maxKeys: 5000,
});

export type CacheType = 'vinDecode' | 'maintenanceSchedule' | 'shopConfig' | 'apiResponse';

function getCache(type: CacheType): NodeCache {
  switch (type) {
    case 'vinDecode':
      return vinDecodeCache;
    case 'maintenanceSchedule':
      return maintenanceScheduleCache;
    case 'shopConfig':
      return shopConfigCache;
    case 'apiResponse':
      return apiResponseCache;
    default:
      return apiResponseCache;
  }
}

export function cacheGet<T>(type: CacheType, key: string): T | undefined {
  const cache = getCache(type);
  const value = cache.get<T>(key);
  if (value !== undefined) {
    logger.debug('Cache hit', { type, key });
  }
  return value;
}

export function cacheSet<T>(type: CacheType, key: string, value: T, ttl?: number): boolean {
  const cache = getCache(type);
  const result = ttl ? cache.set(key, value, ttl) : cache.set(key, value);
  logger.debug('Cache set', { type, key, ttl });
  return result;
}

export function cacheDel(type: CacheType, key: string): number {
  const cache = getCache(type);
  return cache.del(key);
}

export function cacheFlush(type: CacheType): void {
  const cache = getCache(type);
  cache.flushAll();
  logger.info('Cache flushed', { type });
}

export function cacheStats(type: CacheType): NodeCache.Stats {
  return getCache(type).getStats();
}

export function getAllCacheStats(): Record<CacheType, NodeCache.Stats> {
  return {
    vinDecode: vinDecodeCache.getStats(),
    maintenanceSchedule: maintenanceScheduleCache.getStats(),
    shopConfig: shopConfigCache.getStats(),
    apiResponse: apiResponseCache.getStats(),
  };
}

export async function withCache<T>(
  type: CacheType,
  key: string,
  fetchFn: () => Promise<T>,
  ttl?: number
): Promise<T> {
  const cached = cacheGet<T>(type, key);
  if (cached !== undefined) {
    return cached;
  }

  const value = await fetchFn();
  cacheSet(type, key, value, ttl);
  return value;
}

export { vinDecodeCache, maintenanceScheduleCache, shopConfigCache, apiResponseCache };
