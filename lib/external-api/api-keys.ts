import sql from "@/lib/db/postgres";
import { randomBytes, createHash } from "crypto";

export type RateLimitTier = "standard" | "professional" | "enterprise";

export interface RateLimitConfig {
  requestsPerMinute: number;
  requestsPerDay: number;
  burstLimit: number;
}

export const RATE_LIMIT_TIERS: Record<RateLimitTier, RateLimitConfig> = {
  standard: {
    requestsPerMinute: 60,
    requestsPerDay: 10000,
    burstLimit: 10,
  },
  professional: {
    requestsPerMinute: 300,
    requestsPerDay: 50000,
    burstLimit: 25,
  },
  enterprise: {
    requestsPerMinute: 1000,
    requestsPerDay: -1,
    burstLimit: 100,
  },
};

export interface ApiKey {
  id?: number;
  shopId: number;
  keyHash: string;
  keyPrefix: string;
  name: string;
  permissions: string[];
  rateLimit: number;
  rateLimitTier?: RateLimitTier;
  isActive: boolean;
  lastUsedAt?: Date;
  usageCount: number;
  createdAt: Date;
  createdBy: string;
  expiresAt?: Date;
}

export interface ApiKeyUsageLog {
  keyHash: string;
  shopId: number;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  timestamp: Date;
  ip?: string;
}

const AVAILABLE_PERMISSIONS = [
  "appointments:create",
  "appointments:read",
  "stickers:generate",
  "keytags:generate",
  "vehicles:read",
  "recommendations:read",
  "customers:read",
  "maintenance:read",
] as const;

export type ApiPermission = typeof AVAILABLE_PERMISSIONS[number];

export function getAvailablePermissions(): readonly string[] {
  return AVAILABLE_PERMISSIONS;
}

export function validatePermissions(permissions: string[]): { valid: boolean; invalid: string[] } {
  const validPerms = new Set<string>(AVAILABLE_PERMISSIONS);
  validPerms.add("*");
  const invalid = permissions.filter(p => !validPerms.has(p));
  return { valid: invalid.length === 0, invalid };
}

export function getRateLimitFromTier(tier: RateLimitTier): number {
  return RATE_LIMIT_TIERS[tier].requestsPerMinute;
}

export function getTierConfig(tier: RateLimitTier): RateLimitConfig {
  return RATE_LIMIT_TIERS[tier];
}

export async function getDefaultTierForShop(shopId: number): Promise<RateLimitTier> {
  return "standard";
}

export async function canShopUseTier(shopId: number, tier: RateLimitTier): Promise<boolean> {
  if (tier === "standard") {
    return true;
  }
  return false;
}

export async function generateApiKey(
  shopId: number,
  name: string,
  permissions: string[],
  createdBy: string,
  options?: {
    rateLimitTier?: RateLimitTier;
    rateLimit?: number;
    expiresAt?: Date;
  }
): Promise<{ key: string; keyPrefix: string; keyId: string }> {
  const permValidation = validatePermissions(permissions);
  if (!permValidation.valid) {
    throw new Error(`Invalid permissions: ${permValidation.invalid.join(", ")}`);
  }
  
  const rawKey = `mos_${randomBytes(32).toString("hex")}`;
  const keyPrefix = rawKey.substring(0, 12);
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  
  const tier = options?.rateLimitTier || "standard";
  const rateLimit = options?.rateLimit || getRateLimitFromTier(tier);
  
  const rows = await sql`
    INSERT INTO api_keys (shop_id, key_hash, key_prefix, name, permissions, rate_limit, is_active, usage_count, created_by, expires_at, created_at)
    VALUES (
      ${String(shopId)},
      ${keyHash},
      ${keyPrefix},
      ${name},
      ${JSON.stringify(permissions)}::jsonb,
      ${rateLimit},
      true,
      0,
      ${createdBy},
      ${options?.expiresAt || null},
      NOW()
    )
    RETURNING id
  `;
  
  return {
    key: rawKey,
    keyPrefix,
    keyId: String(rows[0].id),
  };
}

export async function validateApiKey(
  rawKey: string
): Promise<{ valid: boolean; apiKey?: ApiKey; error?: string }> {
  if (!rawKey || !rawKey.startsWith("mos_")) {
    return { valid: false, error: "Invalid API key format" };
  }
  
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  
  const rows = await sql`
    SELECT id, shop_id, key_hash, key_prefix, name, permissions, rate_limit, is_active, last_used_at, usage_count, created_by, expires_at, created_at
    FROM api_keys
    WHERE key_hash = ${keyHash}
    LIMIT 1
  `;
  
  const row = rows[0];
  if (!row) {
    return { valid: false, error: "API key not found" };
  }
  
  if (!row.is_active) {
    return { valid: false, error: "API key is disabled" };
  }
  
  if (row.expires_at && new Date() > new Date(row.expires_at as string)) {
    return { valid: false, error: "API key has expired" };
  }
  
  const apiKey: ApiKey = {
    id: row.id as number,
    shopId: parseInt(row.shop_id as string),
    keyHash: row.key_hash as string,
    keyPrefix: row.key_prefix as string,
    name: row.name as string,
    permissions: row.permissions as string[],
    rateLimit: row.rate_limit as number,
    isActive: row.is_active as boolean,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : undefined,
    usageCount: row.usage_count as number,
    createdBy: row.created_by as string,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
  };
  
  return { valid: true, apiKey };
}

export async function updateApiKeyUsage(keyHash: string): Promise<void> {
  await sql`
    UPDATE api_keys
    SET last_used_at = NOW(), usage_count = usage_count + 1
    WHERE key_hash = ${keyHash}
  `;
}

export async function checkPermission(
  apiKey: ApiKey,
  requiredPermission: string
): Promise<boolean> {
  if (apiKey.permissions.includes("*")) {
    return true;
  }
  return apiKey.permissions.includes(requiredPermission);
}

export async function revokeApiKey(keyId: string): Promise<boolean> {
  const result = await sql`
    UPDATE api_keys
    SET is_active = false
    WHERE id = ${parseInt(keyId)}
  `;
  
  return result.count > 0;
}

export async function getApiKeysForShop(shopId: number): Promise<ApiKey[]> {
  const rows = await sql`
    SELECT id, shop_id, key_hash, key_prefix, name, permissions, rate_limit, is_active, last_used_at, usage_count, created_by, expires_at, created_at
    FROM api_keys
    WHERE shop_id = ${String(shopId)}
    ORDER BY created_at DESC
  `;
  
  return rows.map(row => ({
    id: row.id as number,
    shopId: parseInt(row.shop_id as string),
    keyHash: row.key_hash as string,
    keyPrefix: row.key_prefix as string,
    name: row.name as string,
    permissions: row.permissions as string[],
    rateLimit: row.rate_limit as number,
    isActive: row.is_active as boolean,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : undefined,
    usageCount: row.usage_count as number,
    createdBy: row.created_by as string,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
  }));
}

export async function logApiUsage(log: ApiKeyUsageLog): Promise<void> {
  const shopIdStr = String(log.shopId);
  
  await sql`
    INSERT INTO api_usage_logs (shop_id, endpoint, method, status_code, response_time_ms, ip_address, created_at)
    VALUES (
      (SELECT id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1),
      ${log.endpoint},
      ${log.method},
      ${log.statusCode},
      ${log.responseTime},
      ${log.ip || null},
      ${log.timestamp}
    )
  `;
}

export async function checkRateLimit(
  keyHash: string,
  rateLimit: number
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const windowStart = new Date();
  windowStart.setMinutes(windowStart.getMinutes() - 1);
  
  const rows = await sql`
    SELECT COUNT(*) as count
    FROM api_usage_logs
    WHERE created_at >= ${windowStart}
  `;
  
  const count = Number(rows[0]?.count || 0);
  
  const resetAt = new Date();
  resetAt.setMinutes(resetAt.getMinutes() + 1);
  
  return {
    allowed: count < rateLimit,
    remaining: Math.max(0, rateLimit - count),
    resetAt
  };
}

export async function getApiKeyById(keyId: string): Promise<ApiKey | null> {
  const rows = await sql`
    SELECT id, shop_id, key_hash, key_prefix, name, permissions, rate_limit, is_active, last_used_at, usage_count, created_by, expires_at, created_at
    FROM api_keys
    WHERE id = ${parseInt(keyId)}
    LIMIT 1
  `;
  
  const row = rows[0];
  if (!row) return null;
  
  return {
    id: row.id as number,
    shopId: parseInt(row.shop_id as string),
    keyHash: row.key_hash as string,
    keyPrefix: row.key_prefix as string,
    name: row.name as string,
    permissions: row.permissions as string[],
    rateLimit: row.rate_limit as number,
    isActive: row.is_active as boolean,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : undefined,
    usageCount: row.usage_count as number,
    createdBy: row.created_by as string,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
  };
}

export async function updateApiKey(
  keyId: string,
  updates: Partial<Pick<ApiKey, "name" | "permissions" | "rateLimit" | "rateLimitTier" | "isActive" | "expiresAt">>
): Promise<boolean> {
  if (updates.rateLimitTier && !updates.rateLimit) {
    updates.rateLimit = getRateLimitFromTier(updates.rateLimitTier);
  }
  
  const setClauses: string[] = [];
  const values: unknown[] = [];
  
  if (updates.name !== undefined) {
    await sql`UPDATE api_keys SET name = ${updates.name} WHERE id = ${parseInt(keyId)}`;
  }
  if (updates.permissions !== undefined) {
    await sql`UPDATE api_keys SET permissions = ${JSON.stringify(updates.permissions)}::jsonb WHERE id = ${parseInt(keyId)}`;
  }
  if (updates.rateLimit !== undefined) {
    await sql`UPDATE api_keys SET rate_limit = ${updates.rateLimit} WHERE id = ${parseInt(keyId)}`;
  }
  if (updates.isActive !== undefined) {
    await sql`UPDATE api_keys SET is_active = ${updates.isActive} WHERE id = ${parseInt(keyId)}`;
  }
  if (updates.expiresAt !== undefined) {
    await sql`UPDATE api_keys SET expires_at = ${updates.expiresAt} WHERE id = ${parseInt(keyId)}`;
  }
  
  return true;
}
