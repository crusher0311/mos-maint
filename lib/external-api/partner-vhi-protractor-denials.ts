const DENIAL_TTL_MS = 2 * 60 * 1000;
const MAX_DENIALS = 500;

export type ProtractorDirectOperation = "vehicle" | "deferred";
type Denial = { statusCode: 401 | 403; expiresAt: number };
const denials = new Map<string, Denial>();

function key(shopId: number, vin: string, operation: ProtractorDirectOperation): string {
  return `${shopId}:${vin.toUpperCase()}:${operation}`;
}

function sweep(now = Date.now()): void {
  for (const [entryKey, denial] of denials) {
    if (denial.expiresAt <= now && denials.get(entryKey) === denial) denials.delete(entryKey);
  }
}

const timer = setInterval(sweep, 30_000);
timer.unref?.();

export async function withProtractorDirectDenialCache<T extends {
  ok: boolean;
  statusCode?: number;
  error?: string;
}>(input: {
  shopId: number;
  vin: string;
  operation: ProtractorDirectOperation;
  fetch: () => Promise<T>;
}): Promise<T | {
  ok: false;
  statusCode: 401 | 403;
  error: string;
  denialCacheHit: true;
}> {
  const now = Date.now();
  sweep(now);
  const cacheKey = key(input.shopId, input.vin, input.operation);
  const cached = denials.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return {
      ok: false,
      statusCode: cached.statusCode,
      error: `Protractor ${cached.statusCode} recently returned for this vehicle`,
      denialCacheHit: true,
    };
  }

  // Rejections and every status except explicit HTTP 401/403 pass through and
  // never populate this cache.
  const result = await input.fetch();
  if (!result.ok && (result.statusCode === 401 || result.statusCode === 403)) {
    while (denials.size >= MAX_DENIALS) {
      const oldest = denials.keys().next().value as string | undefined;
      if (!oldest) break;
      denials.delete(oldest);
    }
    denials.set(cacheKey, {
      statusCode: result.statusCode,
      expiresAt: now + DENIAL_TTL_MS,
    });
  }
  return result;
}

export const __protractorDenialTest = {
  clear: () => denials.clear(),
  size: () => denials.size,
  sweep,
  ttlMs: DENIAL_TTL_MS,
  seed: (
    shopId: number,
    vin: string,
    operation: ProtractorDirectOperation,
    statusCode: 401 | 403,
    expiresAt: number,
  ) => denials.set(key(shopId, vin, operation), { statusCode, expiresAt }),
};