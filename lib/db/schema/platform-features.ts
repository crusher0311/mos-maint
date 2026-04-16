import {
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const platformFeatures = pgTable(
  "platform_features",
  {
    id: serial("id").primaryKey(),
    order: integer("order").notNull().default(0),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    description: text("description"),
    status: varchar("status", { length: 50 }).notNull().default("active"),
    includedInTiers: jsonb("included_in_tiers").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    slugIdx: index("platform_features_slug_idx").on(table.slug),
    statusIdx: index("platform_features_status_idx").on(table.status),
  }),
);
