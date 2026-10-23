import type { Db } from "mongodb";
import { drizzle } from "drizzle-orm/postgres-js";
import { getPostgresClient } from "@/lib/db/postgres";
import { SupabaseDualWriter } from "@/lib/supabase-dual-writer";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";
import { isProtractorShopRecord } from "./shop-eligibility";
import { drainNormalizationIntents, normalizationRetriesEnabled } from "./normalization-retries";

export async function processLocalNormalizationRetries(db: Db, options: {
  budgetMs?: number; shouldStop?: () => boolean;
} = {}) {
  if (!normalizationRetriesEnabled()) return { processed: 0 };
  return drainNormalizationIntents(getPostgresClient(), {
    eligible: async shopId => {
      const shop = await db.collection("shops").findOne(
        { shopId: { $in: [shopId, String(shopId)] } }, { maxTimeMS: 5000 },
      );
      return isProtractorShopRecord(shop) ? { enterpriseId: shop?.enterpriseId } : null;
    },
    normalize: (tx, intent, enterpriseId) => new NormalizedIngestionService(
      db, "protractor", intent.shop_id, enterpriseId, {
        localNormalizationWriter: new SupabaseDualWriter(drizzle(tx) as any, { skipVehicleEnrichment: true }),
        ingestionVia: "webhook-queue-replay",
      },
    ).ingestWorkOrderWithAllEntities(intent.payload),
  }, options);
}
