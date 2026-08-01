import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  varchar,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

export const ticketStatusEnum = pgEnum("ticket_status", [
  "open",
  "in_progress",
  "pending",
  "resolved",
  "closed",
]);

export const ticketPriorityEnum = pgEnum("ticket_priority", [
  "low",
  "medium",
  "high",
  "urgent",
]);

export const ticketCategoryEnum = pgEnum("ticket_category", [
  "technical",
  "billing",
  "integration",
  "feature_request",
  "general",
]);

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: serial("id").primaryKey(),
    // task #1000 (PACKAGE 4): identity bridge for the Mongo→PG cutover. Holds
    // the ObjectId-shaped string id returned to callers so their
    // `ObjectId.isValid()` guards keep passing after the flag flip.
    mongoId: text("mongo_id"),
    ticketNumber: varchar("ticket_number", { length: 50 }).notNull().unique(),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    category: ticketCategoryEnum("category").notNull().default("general"),
    priority: ticketPriorityEnum("priority").notNull().default("medium"),
    status: ticketStatusEnum("status").notNull().default("open"),
    source: varchar("source", { length: 50 }).default("web"),
    shopId: integer("shop_id"),
    shopName: varchar("shop_name", { length: 255 }),
    locationIdentifier: varchar("location_identifier", { length: 255 }),
    userEmail: varchar("user_email", { length: 255 }),
    userName: varchar("user_name", { length: 255 }),
    callerPhone: varchar("caller_phone", { length: 50 }),
    callSid: varchar("call_sid", { length: 100 }),
    assignedTo: varchar("assigned_to", { length: 255 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // task #1000 (PACKAGE 4): the Mongo repo sets these on the resolved→closed
    // auto-close sweep; mirrored here so PG-canonical writes retain them.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    autoClosedAt: timestamp("auto_closed_at", { withTimezone: true }),
    messages: jsonb("messages").default([]),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    shopIdIdx: index("support_tickets_shop_id_idx").on(table.shopId),
    statusIdx: index("support_tickets_status_idx").on(table.status),
    userEmailIdx: index("support_tickets_user_email_idx").on(table.userEmail),
    createdAtIdx: index("support_tickets_created_at_idx").on(table.createdAt),
    mongoIdIdx: index("support_tickets_mongo_id_idx").on(table.mongoId),
  }),
);
