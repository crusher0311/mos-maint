import { randomBytes, createHash } from "crypto";
import * as repo from "@/lib/data/repositories/api-keys";

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
  _id?: any;
  shopId: number;
  keyHash: string;
  keyPrefix: string;
  name: string;
  permissions: string[];
  rateLimit: number;
  rateLimitTier?: RateLimitTier;
  isActive: boolean;
  revoked?: boolean;
  lastUsedAt?: Date;
  usageCount: number;
  createdAt: Date;
  createdBy: string;
  expiresAt?: Date;
  isPartner?: boolean;
  partnerId?: string;
  partnerName?: string;
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
  "shops:read",
  "print:agent",
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

  const apiKey: ApiKey = {
    shopId,
    keyHash,
    keyPrefix,
    name,
    permissions,
    rateLimit,
    rateLimitTier: tier,
    isActive: true,
    usageCount: 0,
    createdAt: new Date(),
    createdBy,
    expiresAt: options?.expiresAt,
  };

  const keyId = await repo.insertApiKey(apiKey);

  return { key: rawKey, keyPrefix, keyId };
}

export async function generatePartnerApiKey(
  partnerId: string,
  partnerName: string,
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

  const rawKey = `mos_partner_${randomBytes(32).toString("hex")}`;
  const keyPrefix = rawKey.substring(0, 16);
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const tier = options?.rateLimitTier || "enterprise";
  const rateLimit = options?.rateLimit || getRateLimitFromTier(tier);

  const apiKey: ApiKey = {
    shopId: 0,
    keyHash,
    keyPrefix,
    name: `Partner: ${partnerName}`,
    permissions,
    rateLimit,
    rateLimitTier: tier,
    isActive: true,
    usageCount: 0,
    createdAt: new Date(),
    createdBy,
    expiresAt: options?.expiresAt,
    isPartner: true,
    partnerId,
    partnerName,
  };

  const keyId = await repo.insertApiKey(apiKey);

  return { key: rawKey, keyPrefix, keyId };
}

export async function validateApiKey(
  rawKey: string
): Promise<{ valid: boolean; apiKey?: ApiKey; error?: string }> {
  if (!rawKey || !rawKey.startsWith("mos_")) {
    return { valid: false, error: "Invalid API key format" };
  }

  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const apiKey = (await repo.findApiKeyByHash(keyHash)) as ApiKey | null;

  if (!apiKey) {
    return { valid: false, error: "API key not found" };
  }

  if (!apiKey.isActive) {
    return { valid: false, error: "API key is disabled" };
  }

  if (apiKey.revoked) {
    return { valid: false, error: "API key has been revoked" };
  }

  if (apiKey.expiresAt && new Date() > new Date(apiKey.expiresAt)) {
    return { valid: false, error: "API key has expired" };
  }

  return { valid: true, apiKey };
}

export async function updateApiKeyUsage(keyHash: string): Promise<void> {
  await repo.recordApiKeyUsage(keyHash);
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
  return repo.deactivateApiKey(keyId);
}

export async function getApiKeysForShop(shopId: number): Promise<ApiKey[]> {
  const keys = await repo.listApiKeysForShop(shopId);
  return keys as unknown as ApiKey[];
}

export async function logApiUsage(log: ApiKeyUsageLog): Promise<void> {
  await repo.logApiUsage(log);
}

export async function checkRateLimit(
  keyHash: string,
  rateLimit: number
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const windowStart = new Date();
  windowStart.setMinutes(windowStart.getMinutes() - 1);

  const count = await repo.countApiUsageInWindow(keyHash, windowStart);

  const resetAt = new Date();
  resetAt.setMinutes(resetAt.getMinutes() + 1);

  return {
    allowed: count < rateLimit,
    remaining: Math.max(0, rateLimit - count),
    resetAt,
  };
}

export async function getApiKeyById(keyId: string): Promise<ApiKey | null> {
  const key = await repo.findApiKeyById(keyId);
  return key as ApiKey | null;
}

export async function updateApiKey(
  keyId: string,
  updates: Partial<Pick<ApiKey, "name" | "permissions" | "rateLimit" | "rateLimitTier" | "isActive" | "expiresAt">>
): Promise<boolean> {
  if (updates.rateLimitTier && !updates.rateLimit) {
    updates.rateLimit = getRateLimitFromTier(updates.rateLimitTier);
  }
  return repo.updateApiKey(keyId, updates);
}
