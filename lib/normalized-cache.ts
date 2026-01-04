interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class NormalizedQueryCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private readonly defaultTTL = 60 * 1000;
  private readonly maxEntries = 1000;

  private generateKey(prefix: string, params: Record<string, any>): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map(k => `${k}=${JSON.stringify(params[k])}`)
      .join('&');
    return `${prefix}:${sortedParams}`;
  }

  get<T>(prefix: string, params: Record<string, any>): T | null {
    const key = this.generateKey(prefix, params);
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    return entry.data as T;
  }

  set<T>(prefix: string, params: Record<string, any>, data: T, ttlMs?: number): void {
    if (this.cache.size >= this.maxEntries) {
      this.evictExpired();
      if (this.cache.size >= this.maxEntries) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
    }

    const key = this.generateKey(prefix, params);
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + (ttlMs || this.defaultTTL),
    });
  }

  invalidate(prefix: string, params?: Record<string, any>): void {
    if (params) {
      const key = this.generateKey(prefix, params);
      this.cache.delete(key);
    } else {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${prefix}:`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  invalidateByShop(shopId: number): void {
    const shopIdPattern = `"shopId":${shopId},`;
    const shopIdPatternEnd = `"shopId":${shopId}}`;
    const shopIdPatternAlone = `shopId=${shopId}&`;
    
    for (const key of this.cache.keys()) {
      if (
        key.includes(shopIdPattern) || 
        key.includes(shopIdPatternEnd) ||
        key.includes(shopIdPatternAlone) ||
        key.endsWith(`shopId=${shopId}`)
      ) {
        this.cache.delete(key);
      }
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  getStats(): { size: number; maxEntries: number } {
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
    };
  }
}

declare global {
  var _normalizedQueryCache: NormalizedQueryCache | undefined;
}

export function getNormalizedCache(): NormalizedQueryCache {
  if (!global._normalizedQueryCache) {
    global._normalizedQueryCache = new NormalizedQueryCache();
  }
  return global._normalizedQueryCache;
}

export const CACHE_KEYS = {
  VEHICLE_JOBS: 'vehicle_jobs',
  SEARCH_RESULTS: 'search_results',
  ENTERPRISE_SHOPS: 'enterprise_shops',
  JOB_AUTOCOMPLETE: 'job_autocomplete',
} as const;

export const CACHE_TTL = {
  SHORT: 30 * 1000,
  MEDIUM: 60 * 1000,
  LONG: 5 * 60 * 1000,
} as const;
