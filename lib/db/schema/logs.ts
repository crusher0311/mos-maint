import {
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const productionLogs = pgTable(
  "production_logs",
  {
    id: serial("id").primaryKey(),
    dt: timestamp("dt", { withTimezone: true }).notNull(),
    level: varchar("level", { length: 20 }).notNull().default("info"),
    message: text("message").notNull(),
    messageJson: jsonb("message_json"),
    appname: varchar("appname", { length: 100 }),
    host: varchar("host", { length: 100 }),
    raw: text("raw"),
    dtHash: varchar("dt_hash", { length: 64 }).notNull().unique(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dtIdx: index("production_logs_dt_idx").on(table.dt),
    levelIdx: index("production_logs_level_idx").on(table.level),
    appnameIdx: index("production_logs_appname_idx").on(table.appname),
    dtHashIdx: index("production_logs_dt_hash_idx").on(table.dtHash),
  }),
);
