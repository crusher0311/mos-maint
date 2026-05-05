// Repository for the `api_keys` and `api_usage_logs` collections.
//
// task #345 (W3b): Postgres is now canonical for `api_keys`,
// `api_usage_logs` (PG table `external_api_usage_logs` to avoid
// colliding with legacy rescue-rover state). Mongo is shadow-mirrored
// during the soak window via `WRITE_MONGO_API_KEYS` (default ON).
//
// The repository hides the storage swap from
// `lib/external-api/api-keys.ts` and the partner-keys admin route —
// the public function signatures are unchanged. The only contract
// shift is that `insertApiKey` now returns a string id derived from
// the Mongo ObjectId convention (a 24-char hex) so existing callers
// continue to round-trip through `findApiKeyById(keyId)`.
import type { Collection, ObjectId as ObjectIdType } from "mongodb";
import { ObjectId } from "mongodb";
import { eq, desc, and } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";
import { getDb } from "@/lib/data/db";
import { getDb as getPg } from "@/lib/db/drizzle";
import { apiKeys as pgApiKeys, externalApiUsageLogs as pgUsageLogs } from "@/lib/db/schema/wave3";
import {
  shadowWriteMongo,
  shouldShadowWriteMongoApiKeys,
} from "@/lib/db/wave3-write-mode";

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
  revokedAt?: Date;
  revokedBy?: string;
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

/* ------------------------------- helpers --------------------------------- */

function rowToDoc(row: any): ApiKeyDoc & { _id?: ObjectIdType } {
  return {
    _id: ObjectId.isValid(String(row.id)) ? new ObjectId(String(row.id)) : undefined,
    shopId: row.shopId,
    keyHash: row.keyHash,
    keyPrefix: row.keyPrefix,
    name: row.name,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    rateLimit: row.rateLimit,
    rateLimitTier: row.rateLimitTier ?? undefined,
    isActive: row.isActive,
    revoked: row.revoked ?? undefined,
    revokedAt: row.revokedAt ?? undefined,
    revokedBy: row.revokedBy ?? undefined,
    lastUsedAt: row.lastUsedAt ?? undefined,
    usageCount: row.usageCount,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt ?? undefined,
    isPartner: row.isPartner ?? undefined,
    partnerId: row.partnerId ?? undefined,
    partnerName: row.partnerName ?? undefined,
  };
}

/* ------------------------------- writes --------------------------------- */

export async function insertApiKey(doc: Omit<ApiKeyDoc, "_id">): Promise<string> {
  // Mint a Mongo-compatible 24-char hex id so existing callers can
  // continue to use the returned id with `findApiKeyById`. Same id is
  // written to both stores during shadow soak.
  const id = new ObjectId();
  const idHex = id.toHexString();

  const pg = getPg();
  await pg.insert(pgApiKeys).values({
    id: idHex,
    shopId: doc.shopId,
    keyHash: doc.keyHash,
    keyPrefix: doc.keyPrefix,
    name: doc.name,
    permissions: doc.permissions ?? [],
    rateLimit: doc.rateLimit,
    rateLimitTier: doc.rateLimitTier ?? null,
    isActive: doc.isActive,
    revoked: doc.revoked ?? false,
    lastUsedAt: doc.lastUsedAt ?? null,
    usageCount: doc.usageCount ?? 0,
    createdAt: doc.createdAt,
    createdBy: doc.createdBy,
    expiresAt: doc.expiresAt ?? null,
    isPartner: doc.isPartner ?? false,
    partnerId: doc.partnerId ?? null,
    partnerName: doc.partnerName ?? null,
  });

  await shadowWriteMongo(shouldShadowWriteMongoApiKeys, "api_keys.insert", async () => {
    const col = await keysCollection();
    await col.insertOne({ _id: id, ...doc });
  });

  return idHex;
}

export async function recordApiKeyUsage(keyHash: string): Promise<void> {
  const pg = getPg();
  await pg
    .update(pgApiKeys)
    .set({ lastUsedAt: new Date(), usageCount: dsql`${pgApiKeys.usageCount} + 1` })
    .where(eq(pgApiKeys.keyHash, keyHash));

  await shadowWriteMongo(shouldShadowWriteMongoApiKeys, "api_keys.recordUsage", async () => {
    const col = await keysCollection();
    await col.updateOne(
      { keyHash },
      { $set: { lastUsedAt: new Date() }, $inc: { usageCount: 1 } },
    );
  });
}

export async function deactivateApiKey(keyId: string): Promise<boolean> {
  const pg = getPg();
  const res = await pg
    .update(pgApiKeys)
    .set({ isActive: false })
    .where(eq(pgApiKeys.id, keyId))
    .returning({ id: pgApiKeys.id });
  const ok = res.length > 0;

  await shadowWriteMongo(shouldShadowWriteMongoApiKeys, "api_keys.deactivate", async () => {
    if (!ObjectId.isValid(keyId)) return;
    const col = await keysCollection();
    await col.updateOne({ _id: new ObjectId(keyId) }, { $set: { isActive: false } });
  });

  return ok;
}

export async function updateApiKey(
  keyId: string,
  updates: ApiKeyUpdate,
): Promise<boolean> {
  const pg = getPg();
  const set: Partial<typeof pgApiKeys.$inferInsert> = {};
  if (updates.name !== undefined) set.name = updates.name;
  if (updates.permissions !== undefined) set.permissions = updates.permissions;
  if (updates.rateLimit !== undefined) set.rateLimit = updates.rateLimit;
  if (updates.rateLimitTier !== undefined) set.rateLimitTier = updates.rateLimitTier;
  if (updates.isActive !== undefined) set.isActive = updates.isActive;
  if (updates.expiresAt !== undefined) set.expiresAt = updates.expiresAt;

  const res = await pg
    .update(pgApiKeys)
    .set(set)
    .where(eq(pgApiKeys.id, keyId))
    .returning({ id: pgApiKeys.id });
  const ok = res.length > 0;

  await shadowWriteMongo(shouldShadowWriteMongoApiKeys, "api_keys.update", async () => {
    if (!ObjectId.isValid(keyId)) return;
    const col = await keysCollection();
    await col.updateOne({ _id: new ObjectId(keyId) }, { $set: updates });
  });

  return ok;
}

/* -------------------------------- reads --------------------------------- */

export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyDoc | null> {
  const pg = getPg();
  const rows = await pg.select().from(pgApiKeys).where(eq(pgApiKeys.keyHash, keyHash)).limit(1);
  if (rows.length > 0) return rowToDoc(rows[0]);
  return null;
}

export async function findApiKeyById(keyId: string): Promise<ApiKeyDoc | null> {
  const pg = getPg();
  const rows = await pg.select().from(pgApiKeys).where(eq(pgApiKeys.id, keyId)).limit(1);
  if (rows.length > 0) return rowToDoc(rows[0]);
  return null;
}

export async function listApiKeysForShop(shopId: number): Promise<ApiKeyDoc[]> {
  const pg = getPg();
  const rows = await pg
    .select()
    .from(pgApiKeys)
    .where(eq(pgApiKeys.shopId, shopId))
    .orderBy(desc(pgApiKeys.createdAt));
  return rows.map(rowToDoc);
}

/* ------------------------------- usage logs ----------------------------- */

export async function logApiUsage(entry: ApiUsageLogDoc): Promise<void> {
  const pg = getPg();
  await pg.insert(pgUsageLogs).values({
    keyHash: entry.keyHash,
    shopId: entry.shopId,
    endpoint: entry.endpoint,
    method: entry.method,
    statusCode: entry.statusCode,
    responseTime: entry.responseTime,
    timestamp: entry.timestamp,
    ip: entry.ip ?? null,
  });

  await shadowWriteMongo(shouldShadowWriteMongoApiKeys, "api_usage_logs.insert", async () => {
    const col = await logsCollection();
    await col.insertOne(entry);
  });
}

export async function countApiUsageInWindow(
  keyHash: string,
  windowStart: Date,
): Promise<number> {
  const pg = getPg();
  // postgres-js (the driver under drizzle here) rejects a JS Date passed as
  // a parameter to raw SQL with "The 'string' argument must be of type
  // string or an instance of Buffer or ArrayBuffer. Received an instance of
  // Date". This call site failed silently before the W3 cutover because the
  // PG api_keys table was empty (every partner request 401'd before reaching
  // the rate-limit check). Once partner keys were backfilled, every partner
  // request started 500'ing here. Serialize the Date to an ISO timestamp
  // string before binding so postgres-js accepts it.
  const rows = (await pg.execute(dsql`
    SELECT COUNT(*)::bigint AS c FROM external_api_usage_logs
    WHERE key_hash = ${keyHash} AND timestamp >= ${windowStart.toISOString()}
  `)) as unknown as Array<{ c: string | number }>;
  return Number(rows[0]?.c ?? 0);
}

/* ------------------------------- partner keys --------------------------- */

/**
 * List partner keys for the platform-admin partner-keys console. The
 * `keyHash` column is excluded from the projection — partner keys
 * displayed to humans must never include the hash.
 */
export async function listPartnerApiKeys(): Promise<ApiKeyDoc[]> {
  const pg = getPg();
  const rows = await pg
    .select()
    .from(pgApiKeys)
    .where(eq(pgApiKeys.isPartner, true))
    .orderBy(desc(pgApiKeys.createdAt));
  return rows.map((r) => {
    const doc = rowToDoc(r);
    // Strip keyHash so the API response shape matches the legacy
    // `.project({ keyHash: 0 })` Mongo path.
    delete (doc as Partial<ApiKeyDoc>).keyHash;
    return doc;
  });
}

export async function revokePartnerApiKey(
  keyId: string,
  revokedBy: string,
): Promise<boolean> {
  const pg = getPg();
  const revokedAt = new Date();
  const res = await pg
    .update(pgApiKeys)
    .set({ revoked: true, revokedAt, revokedBy })
    .where(and(eq(pgApiKeys.id, keyId), eq(pgApiKeys.isPartner, true)))
    .returning({ id: pgApiKeys.id });
  const ok = res.length > 0;

  await shadowWriteMongo(shouldShadowWriteMongoApiKeys, "api_keys.revokePartner", async () => {
    if (!ObjectId.isValid(keyId)) return;
    const col = await keysCollection();
    await col.updateOne(
      { _id: new ObjectId(keyId), isPartner: true },
      { $set: { revoked: true, revokedAt, revokedBy } },
    );
  });

  return ok;
}

export async function reactivatePartnerApiKey(keyId: string): Promise<boolean> {
  const pg = getPg();
  const res = await pg
    .update(pgApiKeys)
    .set({ revoked: false, revokedAt: null, revokedBy: null })
    .where(and(eq(pgApiKeys.id, keyId), eq(pgApiKeys.isPartner, true)))
    .returning({ id: pgApiKeys.id });
  const ok = res.length > 0;

  await shadowWriteMongo(shouldShadowWriteMongoApiKeys, "api_keys.reactivatePartner", async () => {
    if (!ObjectId.isValid(keyId)) return;
    const col = await keysCollection();
    await col.updateOne(
      { _id: new ObjectId(keyId), isPartner: true },
      { $unset: { revoked: "", revokedAt: "", revokedBy: "" } },
    );
  });

  return ok;
}
