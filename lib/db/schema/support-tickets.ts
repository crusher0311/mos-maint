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
  }),
);
