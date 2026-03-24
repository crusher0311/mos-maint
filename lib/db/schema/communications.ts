import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  varchar,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const conversationStatusEnum = pgEnum("conversation_status", [
  "active",
  "archived",
  "closed",
]);

export const conversationChannelEnum = pgEnum("conversation_channel", [
  "sms",
  "voice",
  "email",
  "web_chat",
  "internal",
]);

export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);

export const messageStatusEnum = pgEnum("message_status", [
  "pending",
  "sent",
  "delivered",
  "failed",
  "read",
]);

export const participantRoleEnum = pgEnum("participant_role", [
  "customer",
  "agent",
  "ai_assistant",
  "system",
]);

export const phoneNumberTypeEnum = pgEnum("phone_number_type", [
  "local",
  "toll_free",
  "mobile",
]);

export const phoneNumberStatusEnum = pgEnum("phone_number_status", [
  "active",
  "inactive",
  "pending",
  "released",
]);

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull(),
  channel: conversationChannelEnum("channel").notNull().default("sms"),
  status: conversationStatusEnum("status").notNull().default("active"),
  subject: text("subject"),
  customerName: varchar("customer_name", { length: 255 }),
  customerPhone: varchar("customer_phone", { length: 50 }),
  customerEmail: varchar("customer_email", { length: 255 }),
  assignedTo: varchar("assigned_to", { length: 255 }),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastMessagePreview: text("last_message_preview"),
  unreadCount: integer("unread_count").notNull().default(0),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("conversations_shop_id_idx").on(table.shopId),
  index("conversations_status_idx").on(table.shopId, table.status),
  index("conversations_last_message_idx").on(table.lastMessageAt),
]);

export const conversationMessages = pgTable("conversation_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  direction: messageDirectionEnum("direction").notNull(),
  status: messageStatusEnum("status").notNull().default("pending"),
  body: text("body"),
  senderName: varchar("sender_name", { length: 255 }),
  senderPhone: varchar("sender_phone", { length: 50 }),
  senderType: participantRoleEnum("sender_type").default("customer"),
  mediaUrls: jsonb("media_urls"),
  externalId: varchar("external_id", { length: 255 }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("conv_messages_conversation_id_idx").on(table.conversationId),
  index("conv_messages_created_at_idx").on(table.createdAt),
]);

export const conversationParticipants = pgTable("conversation_participants", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: participantRoleEnum("role").notNull(),
  name: varchar("name", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  leftAt: timestamp("left_at", { withTimezone: true }),
});

export const phoneNumbers = pgTable("phone_numbers", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull(),
  phoneNumber: varchar("phone_number", { length: 50 }).notNull().unique(),
  friendlyName: varchar("friendly_name", { length: 255 }),
  type: phoneNumberTypeEnum("type").default("local"),
  status: phoneNumberStatusEnum("status").notNull().default("active"),
  capabilities: jsonb("capabilities"),
  twilioSid: varchar("twilio_sid", { length: 255 }),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const smsContacts = pgTable("sms_contacts", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull(),
  phoneNumber: varchar("phone_number", { length: 50 }).notNull(),
  firstName: varchar("first_name", { length: 255 }),
  lastName: varchar("last_name", { length: 255 }),
  email: varchar("email", { length: 255 }),
  optedIn: boolean("opted_in").notNull().default(true),
  optedInAt: timestamp("opted_in_at", { withTimezone: true }),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
  lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
  tags: jsonb("tags"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const smsMessages = pgTable("sms_messages", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull(),
  contactId: integer("contact_id").references(() => smsContacts.id, { onDelete: "set null" }),
  conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  direction: messageDirectionEnum("direction").notNull(),
  status: messageStatusEnum("status").notNull().default("pending"),
  fromNumber: varchar("from_number", { length: 50 }).notNull(),
  toNumber: varchar("to_number", { length: 50 }).notNull(),
  body: text("body"),
  mediaUrls: jsonb("media_urls"),
  twilioSid: varchar("twilio_sid", { length: 255 }),
  errorCode: varchar("error_code", { length: 50 }),
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("sms_messages_shop_id_idx").on(table.shopId),
  index("sms_messages_contact_id_idx").on(table.contactId),
  index("sms_messages_conversation_id_idx").on(table.conversationId),
]);

export const voicemails = pgTable("voicemails", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull(),
  callerPhone: varchar("caller_phone", { length: 50 }),
  callerName: varchar("caller_name", { length: 255 }),
  recipientPhone: varchar("recipient_phone", { length: 50 }),
  duration: integer("duration"),
  recordingUrl: text("recording_url"),
  recordingSid: varchar("recording_sid", { length: 255 }),
  transcription: text("transcription"),
  transcriptionStatus: varchar("transcription_status", { length: 50 }),
  isRead: boolean("is_read").notNull().default(false),
  isArchived: boolean("is_archived").notNull().default(false),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("voicemails_shop_id_idx").on(table.shopId),
  index("voicemails_created_at_idx").on(table.createdAt),
]);

export const callTranscriptions = pgTable("call_transcriptions", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull(),
  callSid: varchar("call_sid", { length: 255 }),
  callerPhone: varchar("caller_phone", { length: 50 }),
  agentPhone: varchar("agent_phone", { length: 50 }),
  direction: messageDirectionEnum("direction"),
  duration: integer("duration"),
  transcriptionText: text("transcription_text"),
  summary: text("summary"),
  sentiment: varchar("sentiment", { length: 50 }),
  topics: jsonb("topics"),
  recordingUrl: text("recording_url"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("call_transcriptions_shop_id_idx").on(table.shopId),
  index("call_transcriptions_created_at_idx").on(table.createdAt),
]);

export const conversationsRelations = relations(conversations, ({ many }) => ({
  messages: many(conversationMessages),
  participants: many(conversationParticipants),
  smsMessages: many(smsMessages),
}));

export const conversationMessagesRelations = relations(
  conversationMessages,
  ({ one }) => ({
    conversation: one(conversations, {
      fields: [conversationMessages.conversationId],
      references: [conversations.id],
    }),
  }),
);

export const conversationParticipantsRelations = relations(
  conversationParticipants,
  ({ one }) => ({
    conversation: one(conversations, {
      fields: [conversationParticipants.conversationId],
      references: [conversations.id],
    }),
  }),
);

export const smsMessagesRelations = relations(smsMessages, ({ one }) => ({
  contact: one(smsContacts, {
    fields: [smsMessages.contactId],
    references: [smsContacts.id],
  }),
  conversation: one(conversations, {
    fields: [smsMessages.conversationId],
    references: [conversations.id],
  }),
}));
