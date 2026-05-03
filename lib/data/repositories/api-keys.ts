// Repository for the `api_keys` and `api_usage_logs` collections.
import type { Collection, ObjectId as ObjectIdType } from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

const KEYS_COLLECTION = "api_keys";
const LOGS_COLLECTION = "api_usage_logs";

export interface ApiKeyDoc {
  _id?: ObjectIdType;
  shopId: number;
  keyHash: string;
  keyPrefix: string;
  name: string;
  permissions: string[];
  rateLimit: number;
  rateLimitTier?: string;
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

export type ApiKeyUpdate = Partial<
  Pick<
    ApiKeyDoc,
    | "name"
    | "permissions"
    | "rateLimit"
    | "rateLimitTier"
    | "isActive"
    | "expiresAt"
  >
>;

export interface ApiUsageLogDoc {
  keyHash: string;
  shopId: number;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  timestamp: Date;
  ip?: string;
}

async function keysCollection(): Promise<Collection<ApiKeyDoc>> {
  const db = await getDb();
  return db.collection<ApiKeyDoc>(KEYS_COLLECTION);
}

async function logsCollection(): Promise<Collection<ApiUsageLogDoc>> {
  const db = await getDb();
  return db.collection<ApiUsageLogDoc>(LOGS_COLLECTION);
}

export async function insertApiKey(doc: Omit<ApiKeyDoc, "_id">): Promise<string> {
  const col = await keysCollection();
  const res = await col.insertOne(doc);
  return res.insertedId.toString();
}

export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyDoc | null> {
  const col = await keysCollection();
  return col.findOne({ keyHash });
}

export async function findApiKeyById(keyId: string): Promise<ApiKeyDoc | null> {
  const col = await keysCollection();
  return col.findOne({ _id: new ObjectId(keyId) });
}

export async function listApiKeysForShop(shopId: number): Promise<ApiKeyDoc[]> {
  const col = await keysCollection();
  return col.find({ shopId }).sort({ createdAt: -1 }).toArray();
}

export async function recordApiKeyUsage(keyHash: string): Promise<void> {
  const col = await keysCollection();
  await col.updateOne(
    { keyHash },
    { $set: { lastUsedAt: new Date() }, $inc: { usageCount: 1 } },
  );
}

export async function deactivateApiKey(keyId: string): Promise<boolean> {
  const col = await keysCollection();
  const res = await col.updateOne(
    { _id: new ObjectId(keyId) },
    { $set: { isActive: false } },
  );
  return res.modifiedCount > 0;
}

export async function updateApiKey(
  keyId: string,
  updates: ApiKeyUpdate,
): Promise<boolean> {
  const col = await keysCollection();
  const res = await col.updateOne({ _id: new ObjectId(keyId) }, { $set: updates });
  return res.modifiedCount > 0;
}

export async function logApiUsage(entry: ApiUsageLogDoc): Promise<void> {
  const col = await logsCollection();
  await col.insertOne(entry);
}

export async function countApiUsageInWindow(
  keyHash: string,
  windowStart: Date,
): Promise<number> {
  const col = await logsCollection();
  return col.countDocuments({ keyHash, timestamp: { $gte: windowStart } });
}
