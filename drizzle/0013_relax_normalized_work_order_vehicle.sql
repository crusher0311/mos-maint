-- task #344 (W3a): Protractor invoices arrive with no attached vehicle
-- (vehicleId blank, vehicle jsonb empty). Before the polarity flip the
-- dual-writer silently skipped them; after the flip a missing vehicle
-- would crash every Protractor invoice ingestion with pgCode 23502.
--
-- Make the columns nullable so the work_order PG mirror accepts
-- vehicle-less invoices. Job search joins already left-join through
-- vehicle_id, so a NULL is harmless on the read side.
ALTER TABLE "normalized_work_orders" ALTER COLUMN "vehicle_id" DROP NOT NULL;
ALTER TABLE "normalized_work_orders" ALTER COLUMN "vehicle" DROP NOT NULL;
