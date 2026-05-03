-- Task #300: normalize shop identification on enhance_corrections to mosShopId.
--
-- Adds a nullable mos_shop_id column + index. Writers dual-write both columns;
-- readers prefer mos_shop_id and fall back to the legacy shop_id for rows
-- written before this migration. Backfill is performed by
-- scripts/backfill-enhance-corrections-mos-shop-id.ts (Mongo lookup against
-- the canonical `shops` collection — pure SQL can't resolve provider IDs to
-- mosShopId because the registry lives in MongoDB).
--
-- The legacy shop_id column will be dropped in a follow-up migration once
-- the backfill is verified to have covered every historical row in prod.

ALTER TABLE "enhance_corrections" ADD COLUMN IF NOT EXISTS "mos_shop_id" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enhance_corrections_mos_shop_id_idx" ON "enhance_corrections" USING btree ("mos_shop_id");
