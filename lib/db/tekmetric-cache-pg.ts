import sql from "@/lib/db/postgres";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CacheEntry {
  id: string;
  cache_key: string;
  data: Record<string, unknown>;
  created_at: Date;
  expires_at: Date;
}

export async function getCachedData<T = unknown>(cacheKey: string): Promise<T | null> {
  const entries = await sql<CacheEntry[]>`
    SELECT * FROM tekmetric_cache
    WHERE cache_key = ${cacheKey}
    AND expires_at > NOW()
    LIMIT 1
  `;
  
  if (!entries[0]) return null;
  return entries[0].data as T;
}

export async function setCachedData(
  cacheKey: string,
  data: Record<string, unknown>,
  ttlMs: number = CACHE_TTL_MS
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  
  await sql`
    INSERT INTO tekmetric_cache (id, cache_key, data, created_at, expires_at)
    VALUES (gen_random_uuid(), ${cacheKey}, ${JSON.stringify(data)}::jsonb, ${now}, ${expiresAt})
    ON CONFLICT (cache_key)
    DO UPDATE SET
      data = ${JSON.stringify(data)}::jsonb,
      created_at = ${now},
      expires_at = ${expiresAt}
  `;
}

export async function deleteCachedData(cacheKey: string): Promise<void> {
  await sql`DELETE FROM tekmetric_cache WHERE cache_key = ${cacheKey}`;
}

export async function getCachedVehicle(vehicleId: number): Promise<unknown | null> {
  return getCachedData(`vehicle:${vehicleId}`);
}

export async function setCachedVehicle(vehicleId: number, vehicleData: Record<string, unknown>): Promise<void> {
  return setCachedData(`vehicle:${vehicleId}`, vehicleData, CACHE_TTL_MS);
}

export async function getCachedCustomer(customerId: number): Promise<unknown | null> {
  return getCachedData(`customer:${customerId}`);
}

export async function setCachedCustomer(customerId: number, customerData: Record<string, unknown>): Promise<void> {
  return setCachedData(`customer:${customerId}`, customerData, CACHE_TTL_MS);
}

export async function cleanExpiredCache(): Promise<number> {
  const result = await sql`
    DELETE FROM tekmetric_cache WHERE expires_at < NOW()
  `;
  return result.count || 0;
}
