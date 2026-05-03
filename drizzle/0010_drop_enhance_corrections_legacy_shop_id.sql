-- Task #300 cleanup: drop the legacy raw-provider shop_id column from
-- enhance_corrections now that mos_shop_id is the canonical key.
--
-- BEFORE applying this migration, run:
--   npx tsx scripts/backfill-enhance-corrections-mos-shop-id.ts
-- The DO block below short-circuits with a clear error if any row still has
-- a NULL mos_shop_id, so we can't accidentally drop history that the backfill
-- couldn't resolve.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM enhance_corrections WHERE mos_shop_id IS NULL) THEN
    RAISE EXCEPTION 'enhance_corrections has rows with NULL mos_shop_id. Run scripts/backfill-enhance-corrections-mos-shop-id.ts before applying this migration.';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "enhance_corrections_shop_id_idx";
--> statement-breakpoint
ALTER TABLE "enhance_corrections" ALTER COLUMN "mos_shop_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "enhance_corrections" DROP COLUMN IF EXISTS "shop_id";
