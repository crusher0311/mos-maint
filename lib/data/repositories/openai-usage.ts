import { getDb as mongoDb } from "@/lib/mongo";
import { getDb as pgDb } from "@/lib/db/drizzle";
import { sql } from "drizzle-orm";

/** Bounded, canonical-store read. No schema/index creation or fallback to stale stores. */
export async function getOpenAiUsageRows(from: Date, to: Date): Promise<Record<string, any>[]> {
  if (process.env.API_USAGE_PG_CANONICAL === "1") {
    return pgDb().transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      const result = await tx.execute(sql`
        SELECT endpoint, shop_id AS "shopId", timestamp, is_error AS "isError", extra
        FROM api_usage WHERE provider = 'openai' AND timestamp >= ${from} AND timestamp < ${to}
        ORDER BY timestamp DESC LIMIT 10001`);
      return Array.from(result as any).map((r: any) => ({ ...r.extra, ...r, extra: undefined }));
    });
  }
  const db = await mongoDb();
  return db.collection("api_usage").find({ provider: "openai", timestamp: { $gte: from, $lt: to } },
    { projection: { _id: 0, endpoint: 1, shopId: 1, timestamp: 1, isError: 1, model: 1,
      aiTrackingVersion: 1, promptTokens: 1, completionTokens: 1, cachedTokens: 1,
      usageKnown: 1, estimatedCostUsd: 1 }, maxTimeMS: 5000 })
    .sort({ timestamp: -1 }).limit(10001).toArray();
}
