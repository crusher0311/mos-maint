CREATE INDEX "nc_content_hash_idx" ON "normalized_customers" USING btree ((provenance->>'contentHash'));--> statement-breakpoint
CREATE INDEX "nc_source_system_idx" ON "normalized_customers" USING btree ((provenance->>'sourceSystem'));--> statement-breakpoint
CREATE INDEX "nli_content_hash_idx" ON "normalized_line_items" USING btree ((provenance->>'contentHash'));--> statement-breakpoint
CREATE INDEX "nli_source_system_idx" ON "normalized_line_items" USING btree ((provenance->>'sourceSystem'));--> statement-breakpoint
CREATE INDEX "np_content_hash_idx" ON "normalized_payments" USING btree ((provenance->>'contentHash'));--> statement-breakpoint
CREATE INDEX "np_source_system_idx" ON "normalized_payments" USING btree ((provenance->>'sourceSystem'));--> statement-breakpoint
CREATE INDEX "nsj_content_hash_idx" ON "normalized_service_jobs" USING btree ((provenance->>'contentHash'));--> statement-breakpoint
CREATE INDEX "nsj_source_system_idx" ON "normalized_service_jobs" USING btree ((provenance->>'sourceSystem'));--> statement-breakpoint
CREATE INDEX "nv_content_hash_idx" ON "normalized_vehicles" USING btree ((provenance->>'contentHash'));--> statement-breakpoint
CREATE INDEX "nv_source_system_idx" ON "normalized_vehicles" USING btree ((provenance->>'sourceSystem'));--> statement-breakpoint
CREATE INDEX "nwo_content_hash_idx" ON "normalized_work_orders" USING btree ((provenance->>'contentHash'));--> statement-breakpoint
CREATE INDEX "nwo_source_system_idx" ON "normalized_work_orders" USING btree ((provenance->>'sourceSystem'));