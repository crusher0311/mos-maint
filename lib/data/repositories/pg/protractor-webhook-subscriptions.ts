/**
 * Postgres-backed Protractor webhook-subscription bookkeeping — the
 * write surface used by
 * `lib/data/repositories/protractor-webhook-subscriptions.ts` when
 * `PROTRACTOR_OPS_PG_CANONICAL=1` (task #999).
 *
 * Backs the `protractor_webhook_subscriptions` table
 * (lib/db/schema/integration-ops.ts, PK shopId). The Mongo doc records
 * token / callbackUrl / registrationMode / lastEnsuredAt (with a
 * $setOnInsert firstEnsuredAt); the extra fields not covered by typed
 * columns (registrationMode, callbackUrl, firstEnsuredAt) ride in the
 * `payload` jsonb catch-all.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { protractorWebhookSubscriptions } from "@/lib/db/schema/integration-ops";

export async function ensureSubscriptionRecord(
  shopId: number,
  fields: {
    token: string | null;
    callbackUrl: string | null;
    registrationMode: string;
    lastEnsuredAt: Date;
    firstEnsuredAt: Date;
  },
): Promise<void> {
  const db = getDb();
  // Preserve $setOnInsert(firstEnsuredAt): only set on first insert.
  const existing = await db
    .select({ payload: protractorWebhookSubscriptions.payload })
    .from(protractorWebhookSubscriptions)
    .where(eq(protractorWebhookSubscriptions.shopId, shopId))
    .limit(1);
  const priorFirstEnsuredAt =
    (existing[0]?.payload as Record<string, unknown> | undefined)
      ?.firstEnsuredAt ?? fields.firstEnsuredAt;

  const payload = {
    shopId,
    token: fields.token,
    callbackUrl: fields.callbackUrl,
    registrationMode: fields.registrationMode,
    lastEnsuredAt: fields.lastEnsuredAt,
    firstEnsuredAt: priorFirstEnsuredAt,
  };

  await db
    .insert(protractorWebhookSubscriptions)
    .values({
      shopId,
      token: fields.token,
      url: fields.callbackUrl,
      payload,
      lastCheckedAt: fields.lastEnsuredAt,
    })
    .onConflictDoUpdate({
      target: protractorWebhookSubscriptions.shopId,
      set: {
        token: fields.token,
        url: fields.callbackUrl,
        payload,
        lastCheckedAt: fields.lastEnsuredAt,
        updatedAt: new Date(),
      },
    });
}
