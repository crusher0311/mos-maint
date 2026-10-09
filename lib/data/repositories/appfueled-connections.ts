import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { appfueledConnections, appfueledWebhookLimits } from "@/lib/db/schema/wave2";
import { findShopByShopId } from "./shops";
import { AppFueledInputError, connectionDigest, encryptCredentials, parseCredentials, parseConnectionShopId } from "@/lib/external-api/appfueled-credentials";

export const connectionDeps = { getDb, findShopByShopId };
const table = appfueledConnections;
const publicColumns = {
  shopId: table.shopId, isActive: table.isActive, createdAt: table.createdAt,
  updatedAt: table.updatedAt, disabledAt: table.disabledAt,
};
const masked = <T extends object>(row: T | undefined) => row ? { ...row, configured: true as const } : null;

export async function getAppFueledConnection(shopId: number) {
  parseConnectionShopId(shopId);
  const [row] = await connectionDeps.getDb().select(publicColumns).from(table).where(eq(table.shopId, shopId));
  return masked(row);
}

export async function replaceAppFueledConnection(body: unknown, actor: string) {
  const input = parseCredentials(body);
  if (!await connectionDeps.findShopByShopId(input.shopId, { shopId: 1 }))
    throw new AppFueledInputError("MOS shop not found");
  const credentialsCiphertext = encryptCredentials(input, process.env.APPFUELED_CREDENTIALS_ENCRYPTION_KEY);
  const values = {
    shopId: input.shopId, connectionHash: connectionDigest(input.connectionId),
    credentialsCiphertext, isActive: true, updatedAt: new Date(), updatedBy: actor,
    disabledAt: null, disabledBy: null,
  };
  // DB uniqueness arbitrates concurrent cross-shop assignments, including disabled rows.
  const [row] = await connectionDeps.getDb().insert(table).values({ ...values, createdBy: actor })
    .onConflictDoUpdate({ target: table.shopId, set: values }).returning(publicColumns);
  return masked(row);
}

export async function disableAppFueledConnection(shopId: number, actor: string) {
  parseConnectionShopId(shopId);
  const [row] = await connectionDeps.getDb().update(table).set({
    isActive: false, disabledAt: new Date(), disabledBy: actor, updatedAt: new Date(), updatedBy: actor,
  }).where(eq(table.shopId, shopId)).returning(publicColumns);
  return masked(row);
}

export async function resolveAppFueledConnection(connectionId: string) {
  const hash = connectionDigest(connectionId);
  const [row] = await connectionDeps.getDb().select({ shopId: table.shopId, connectionHash: table.connectionHash })
    .from(table).where(and(eq(table.connectionHash, hash), eq(table.isActive, true))).limit(1);
  return row ?? null;
}

// Fixed-size global bucket plus one per registered connection. Atomic across
// replicas; arbitrary caller IDs cannot grow this table. No request body logged.
export async function admitAppFueledWebhook(bucket: string, limit: number) {
  const t = appfueledWebhookLimits;
  const window = sql`date_trunc('minute', now())`;
  const [row] = await connectionDeps.getDb().insert(t).values({ bucket, windowStart: window, count: 1 })
    .onConflictDoUpdate({ target: t.bucket, set: {
      windowStart: window,
      count: sql`CASE WHEN ${t.windowStart} = ${window} THEN ${t.count} + 1 ELSE 1 END`,
    }, setWhere: sql`${t.windowStart} <> ${window} OR ${t.count} < ${limit}` })
    .returning({ count: t.count });
  return Boolean(row);
}
