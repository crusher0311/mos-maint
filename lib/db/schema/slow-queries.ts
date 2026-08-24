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
 * Task #1161 — slow-query analyzer capture table. Written in batches by
 * lib/slow-query/tracker.ts (never from Mongo hot paths), purged on a
 * 30-day retention + hard row cap by the slow-query-monitor cron.
 */
export const slowQueries = pgTable(
  "slow_queries",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    db: varchar("db", { length: 8 }).notNull(), // 'mongo' | 'pg'
    operation: varchar("operation", { length: 40 }).notNull(),
    target: varchar("target", { length: 200 }),
    shape: text("shape").notNull(),
    shapeHash: varchar("shape_hash", { length: 40 }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    rowsReturned: integer("rows_returned"),
    docsExamined: integer("docs_examined"),
    source: varchar("source", { length: 120 }),
    caller: varchar("caller", { length: 300 }),
  },
  (table) => ({
    tsIdx: index("slow_queries_ts_idx").on(table.ts),
    durationIdx: index("slow_queries_duration_idx").on(table.durationMs),
    shapeHashIdx: index("slow_queries_shape_hash_idx").on(table.shapeHash),
    targetIdx: index("slow_queries_target_idx").on(table.target),
  }),
);
