import { getDb } from "@/lib/mongo";
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
  _id?: any;
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
  const db = await getDb();
  
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
  
  const result = await db.collection("api_keys").insertOne(apiKey);
  
  return {
    key: rawKey,
    keyPrefix,
    keyId: result.insertedId.toString(),
  };
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
  const db = await getDb();

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

  const result = await db.collection("api_keys").insertOne(apiKey);

  return {
    key: rawKey,
    keyPrefix,
    keyId: result.insertedId.toString(),
  };
}

export async function validateApiKey(
  rawKey: string
): Promise<{ valid: boolean; apiKey?: ApiKey; error?: string }> {
  const db = await getDb();
  
  if (!rawKey || !rawKey.startsWith("mos_")) {
    return { valid: false, error: "Invalid API key format" };
  }
  
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  
  const apiKey = await db.collection("api_keys").findOne({ keyHash }) as ApiKey | null;
  
  if (!apiKey) {
    return { valid: false, error: "API key not found" };
  }
  
  if (!apiKey.isActive) {
    return { valid: false, error: "API key is disabled" };
  }
  
  if (apiKey.expiresAt && new Date() > new Date(apiKey.expiresAt)) {
    return { valid: false, error: "API key has expired" };
  }
  
  return { valid: true, apiKey };
}

export async function updateApiKeyUsage(keyHash: string): Promise<void> {
  const db = await getDb();
  await db.collection("api_keys").updateOne(
    { keyHash },
    { 
      $set: { lastUsedAt: new Date() },
      $inc: { usageCount: 1 }
    }
  );
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
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  
  const result = await db.collection("api_keys").updateOne(
    { _id: new ObjectId(keyId) },
    { $set: { isActive: false } }
  );
  
  return result.modifiedCount > 0;
}

export async function getApiKeysForShop(shopId: number): Promise<ApiKey[]> {
  const db = await getDb();
  
  const keys = await db.collection("api_keys")
    .find({ shopId })
    .sort({ createdAt: -1 })
    .toArray();
  
  return keys as unknown as ApiKey[];
}

export async function logApiUsage(log: ApiKeyUsageLog): Promise<void> {
  const db = await getDb();
  await db.collection("api_usage_logs").insertOne(log);
}

export async function checkRateLimit(
  keyHash: string,
  rateLimit: number
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const db = await getDb();
  
  const windowStart = new Date();
  windowStart.setMinutes(windowStart.getMinutes() - 1);
  
  const count = await db.collection("api_usage_logs").countDocuments({
    keyHash,
    timestamp: { $gte: windowStart }
  });
  
  const resetAt = new Date();
  resetAt.setMinutes(resetAt.getMinutes() + 1);
  
  return {
    allowed: count < rateLimit,
    remaining: Math.max(0, rateLimit - count),
    resetAt
  };
}

export async function getApiKeyById(keyId: string): Promise<ApiKey | null> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  
  const key = await db.collection("api_keys").findOne({ _id: new ObjectId(keyId) });
  return key as ApiKey | null;
}

export async function updateApiKey(
  keyId: string,
  updates: Partial<Pick<ApiKey, "name" | "permissions" | "rateLimit" | "rateLimitTier" | "isActive" | "expiresAt">>
): Promise<boolean> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  
  if (updates.rateLimitTier && !updates.rateLimit) {
    updates.rateLimit = getRateLimitFromTier(updates.rateLimitTier);
  }
  
  const result = await db.collection("api_keys").updateOne(
    { _id: new ObjectId(keyId) },
    { $set: updates }
  );
  
  return result.modifiedCount > 0;
}
