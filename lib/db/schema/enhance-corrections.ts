import {
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  index,
} from "drizzle-orm/pg-core";

export const enhanceCorrections = pgTable(
  "enhance_corrections",
  {
    id: serial("id").primaryKey(),
    shopId: varchar("shop_id", { length: 50 }).notNull(),
    taskName: varchar("task_name", { length: 500 }),
    aiSuggested: text("ai_suggested").notNull(),
    advisorWrote: text("advisor_wrote").notNull(),
    advisorEmail: varchar("advisor_email", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    shopIdIdx: index("enhance_corrections_shop_id_idx").on(table.shopId),
    createdAtIdx: index("enhance_corrections_created_at_idx").on(table.createdAt),
  }),
);
