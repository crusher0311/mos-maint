import { eq, desc } from "drizzle-orm";
import { getDb } from "../drizzle";
import { callTranscriptions, apiUsageLogs } from "../schema";

type NewTranscription = typeof callTranscriptions.$inferInsert;
type NewApiUsageLog = typeof apiUsageLogs.$inferInsert;

export async function createCallTranscription(data: NewTranscription) {
  const db = getDb();
  const [result] = await db
    .insert(callTranscriptions)
    .values(data)
    .returning();
  return result;
}

export async function getCallTranscriptionsByShopId(
  shopId: number,
  options: { limit?: number; offset?: number } = {},
) {
  const db = getDb();
  const { limit = 50, offset = 0 } = options;

  return db.query.callTranscriptions.findMany({
    where: eq(callTranscriptions.shopId, shopId),
    orderBy: [desc(callTranscriptions.createdAt)],
    limit,
    offset,
  });
}

export async function getCallTranscriptionById(id: number) {
  const db = getDb();
  return db.query.callTranscriptions.findFirst({
    where: eq(callTranscriptions.id, id),
  });
}

export async function logApiUsage(data: NewApiUsageLog) {
  const db = getDb();
  const [result] = await db.insert(apiUsageLogs).values(data).returning();
  return result;
}

export async function getApiUsageByShopId(
  shopId: number,
  options: { limit?: number; offset?: number } = {},
) {
  const db = getDb();
  const { limit = 100, offset = 0 } = options;

  return db.query.apiUsageLogs.findMany({
    where: eq(apiUsageLogs.shopId, shopId),
    orderBy: [desc(apiUsageLogs.createdAt)],
    limit,
    offset,
  });
}
