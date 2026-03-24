import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  varchar,
  real,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";

export const callOutcomeEnum = pgEnum("call_outcome", [
  "answered",
  "voicemail",
  "missed",
  "failed",
  "transferred",
  "callback_scheduled",
]);

export const callSentimentEnum = pgEnum("call_sentiment", [
  "positive",
  "neutral",
  "negative",
  "escalated",
]);

export const rescueRoverSettings = pgTable("rescue_rover_settings", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  voiceId: varchar("voice_id", { length: 100 }),
  voiceProvider: varchar("voice_provider", { length: 50 }).default("deepgram"),
  greeting: text("greeting"),
  afterHoursGreeting: text("after_hours_greeting"),
  maxCallDuration: integer("max_call_duration").default(300),
  transferNumber: varchar("transfer_number", { length: 50 }),
  enableTranscription: boolean("enable_transcription").notNull().default(true),
  enableSentimentAnalysis: boolean("enable_sentiment_analysis")
    .notNull()
    .default(false),
  language: varchar("language", { length: 10 }).default("en"),
  timezone: varchar("timezone", { length: 50 }).default("America/New_York"),
  businessHours: jsonb("business_hours"),
  customInstructions: text("custom_instructions"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rescueRoverCallLogs = pgTable("rescue_rover_call_logs", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull(),
  callSid: varchar("call_sid", { length: 255 }),
  callerPhone: varchar("caller_phone", { length: 50 }),
  callerName: varchar("caller_name", { length: 255 }),
  duration: integer("duration"),
  outcome: callOutcomeEnum("outcome"),
  sentiment: callSentimentEnum("sentiment"),
  transcription: text("transcription"),
  summary: text("summary"),
  intentDetected: varchar("intent_detected", { length: 255 }),
  appointmentScheduled: boolean("appointment_scheduled").default(false),
  transferredTo: varchar("transferred_to", { length: 255 }),
  aiConfidenceScore: real("ai_confidence_score"),
  tokensUsed: integer("tokens_used"),
  costEstimate: real("cost_estimate"),
  recordingUrl: text("recording_url"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("rr_call_logs_shop_id_idx").on(table.shopId),
  index("rr_call_logs_created_at_idx").on(table.createdAt),
]);

export const rescueRoverSafetyRules = pgTable("rescue_rover_safety_rules", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id"),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  ruleType: varchar("rule_type", { length: 50 }).notNull(),
  condition: jsonb("condition").notNull(),
  action: jsonb("action").notNull(),
  priority: integer("priority").notNull().default(0),
  isGlobal: boolean("is_global").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rescueRoverPromptTemplates = pgTable(
  "rescue_rover_prompt_templates",
  {
    id: serial("id").primaryKey(),
    shopId: integer("shop_id"),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    templateType: varchar("template_type", { length: 50 }).notNull(),
    content: text("content").notNull(),
    variables: jsonb("variables"),
    isDefault: boolean("is_default").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const rescueRoverVoiceScripts = pgTable("rescue_rover_voice_scripts", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id"),
  name: varchar("name", { length: 255 }).notNull(),
  scriptType: varchar("script_type", { length: 50 }).notNull(),
  content: text("content").notNull(),
  triggerCondition: jsonb("trigger_condition"),
  priority: integer("priority").notNull().default(0),
  isDefault: boolean("is_default").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rescueRoverContextRules = pgTable("rescue_rover_context_rules", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id"),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  contextType: varchar("context_type", { length: 50 }).notNull(),
  matchPattern: jsonb("match_pattern").notNull(),
  responseGuidance: text("response_guidance").notNull(),
  priority: integer("priority").notNull().default(0),
  isGlobal: boolean("is_global").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rescueRoverRcsLinks = pgTable("rescue_rover_rcs_links", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  url: text("url").notNull(),
  description: text("description"),
  linkType: varchar("link_type", { length: 50 }).notNull(),
  displayText: varchar("display_text", { length: 255 }),
  isActive: boolean("is_active").notNull().default(true),
  clickCount: integer("click_count").notNull().default(0),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const apiUsageLogs = pgTable("api_usage_logs", {
  id: serial("id").primaryKey(),
  shopId: integer("shop_id").notNull(),
  service: varchar("service", { length: 100 }).notNull(),
  endpoint: varchar("endpoint", { length: 255 }),
  method: varchar("method", { length: 10 }),
  tokensInput: integer("tokens_input"),
  tokensOutput: integer("tokens_output"),
  totalTokens: integer("total_tokens"),
  costEstimate: real("cost_estimate"),
  latencyMs: integer("latency_ms"),
  statusCode: integer("status_code"),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("api_usage_logs_shop_id_idx").on(table.shopId),
  index("api_usage_logs_service_idx").on(table.service),
  index("api_usage_logs_created_at_idx").on(table.createdAt),
]);
