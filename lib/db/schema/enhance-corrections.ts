import {
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  integer,
  index,
} from "drizzle-orm/pg-core";

/**
 * Advisor corrections collected from the Detect Dog "Enhance Notes" feature.
 *
 * Shop identification: rows are keyed by `mosShopId` (the canonical internal
 * shop ID). Task #300 dropped the original raw provider `shop_id` column
 * after backfilling — keying on the upstream Tekmetric/Protractor ID meant a
 * shop that changed providers (or whose upstream ID was renamed) silently
 * lost its learned corrections.
 */
export const enhanceCorrections = pgTable(
  "enhance_corrections",
  {
    id: serial("id").primaryKey(),
    mosShopId: integer("mos_shop_id").notNull(),
    taskName: varchar("task_name", { length: 500 }),
    aiSuggested: text("ai_suggested").notNull(),
    advisorWrote: text("advisor_wrote").notNull(),
    advisorEmail: varchar("advisor_email", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    mosShopIdIdx: index("enhance_corrections_mos_shop_id_idx").on(table.mosShopId),
    createdAtIdx: index("enhance_corrections_created_at_idx").on(table.createdAt),
  }),
);
