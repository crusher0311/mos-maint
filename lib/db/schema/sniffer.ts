import {
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";

export const snifferSessions = pgTable(
  "sniffer_sessions",
  {
    id: serial("id").primaryKey(),
    uploadedBy: varchar("uploaded_by", { length: 255 }).notNull(),
    uploadedByEmail: varchar("uploaded_by_email", { length: 255 }),
    platform: varchar("platform", { length: 50 }),
    label: varchar("label", { length: 255 }),
    captureCount: integer("capture_count").notNull().default(0),
    captures: jsonb("captures").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    createdAtIdx: index("sniffer_sessions_created_at_idx").on(table.createdAt),
    platformIdx: index("sniffer_sessions_platform_idx").on(table.platform),
    uploadedByIdx: index("sniffer_sessions_uploaded_by_idx").on(table.uploadedBy),
  }),
);
