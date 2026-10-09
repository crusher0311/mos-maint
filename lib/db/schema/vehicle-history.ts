import { pgTable, text, boolean, jsonb, integer, timestamp } from "drizzle-orm/pg-core";
/** Independent, default-off feature policy. No FK to an unmigrated identity store. */
export const enterpriseVehicleHistoryPolicies = pgTable("enterprise_vehicle_history_policies", {
  enterpriseId: text("enterprise_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  stage: text("stage").notNull().default("performed"),
  shopIds: jsonb("shop_ids").notNull().default([]),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
