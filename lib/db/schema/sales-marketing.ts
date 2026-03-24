import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  decimal,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { crmAccounts } from "./crm-accounts";

export const dealFunnelStages = pgTable("deal_funnel_stages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").default("#3c81c3"),
  sortOrder: integer("sort_order").notNull().default(0),
  probability: integer("probability").default(0),
  isDefault: boolean("is_default").default(false),
  isWon: boolean("is_won").default(false),
  isLost: boolean("is_lost").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
});

export const deals = pgTable("deals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  accountId: varchar("account_id").references(() => crmAccounts.id),
  stageId: varchar("stage_id").notNull().references(() => dealFunnelStages.id),
  value: decimal("value", { precision: 12, scale: 2 }).default("0.00"),
  probability: integer("probability").default(0),
  expectedCloseDate: timestamp("expected_close_date"),
  actualCloseDate: timestamp("actual_close_date"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  source: text("source"),
  notes: text("notes"),
  assignedTo: text("assigned_to"),
  priority: text("priority").default("medium"),
  tags: jsonb("tags").$type<string[]>().default(sql`'[]'::jsonb`),
  activities: jsonb("activities").$type<Array<{ date: string; type: string; note: string; user?: string }>>().default(sql`'[]'::jsonb`),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  stageIdx: index("deals_stage_idx").on(table.stageId),
  accountIdx: index("deals_account_idx").on(table.accountId),
  priorityIdx: index("deals_priority_idx").on(table.priority),
}));

export const campaigns = pgTable("campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull().default("email"),
  status: text("status").notNull().default("draft"),
  subject: text("subject"),
  body: text("body"),
  templateId: varchar("template_id"),
  scheduledAt: timestamp("scheduled_at"),
  sentAt: timestamp("sent_at"),
  audienceFilter: jsonb("audience_filter").$type<Record<string, any>>().default(sql`'{}'::jsonb`),
  totalRecipients: integer("total_recipients").default(0),
  delivered: integer("delivered").default(0),
  opened: integer("opened").default(0),
  clicked: integer("clicked").default(0),
  bounced: integer("bounced").default(0),
  unsubscribed: integer("unsubscribed").default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  statusIdx: index("campaigns_status_idx").on(table.status),
  typeIdx: index("campaigns_type_idx").on(table.type),
}));

export const coupons = pgTable("coupons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  discountType: text("discount_type").notNull().default("percentage"),
  discountValue: decimal("discount_value", { precision: 10, scale: 2 }).notNull(),
  minPurchase: decimal("min_purchase", { precision: 10, scale: 2 }),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").default(0),
  validFrom: timestamp("valid_from"),
  validUntil: timestamp("valid_until"),
  isActive: boolean("is_active").default(true),
  applicablePlans: jsonb("applicable_plans").$type<string[]>().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  codeIdx: index("coupons_code_idx").on(table.code),
  activeIdx: index("coupons_active_idx").on(table.isActive),
}));

export const specials = pgTable("specials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").notNull().default("promotion"),
  discountType: text("discount_type").default("percentage"),
  discountValue: decimal("discount_value", { precision: 10, scale: 2 }),
  imageUrl: text("image_url"),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  isActive: boolean("is_active").default(true),
  targetAudience: text("target_audience"),
  terms: text("terms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  activeIdx: index("specials_active_idx").on(table.isActive),
  typeIdx: index("specials_type_idx").on(table.type),
}));

export const messageTemplates = pgTable("message_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  channel: text("channel").notNull().default("email"),
  subject: text("subject"),
  body: text("body").notNull(),
  category: text("category"),
  variables: jsonb("variables").$type<string[]>().default(sql`'[]'::jsonb`),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  channelIdx: index("msg_templates_channel_idx").on(table.channel),
  categoryIdx: index("msg_templates_category_idx").on(table.category),
}));

export const pricingPlans = pgTable("pricing_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  monthlyPrice: decimal("monthly_price", { precision: 10, scale: 2 }).notNull(),
  annualPrice: decimal("annual_price", { precision: 10, scale: 2 }),
  setupFee: decimal("setup_fee", { precision: 10, scale: 2 }).default("0.00"),
  trialDays: integer("trial_days").default(0),
  isActive: boolean("is_active").default(true),
  isPopular: boolean("is_popular").default(false),
  sortOrder: integer("sort_order").default(0),
  stripePriceIdMonthly: text("stripe_price_id_monthly"),
  stripePriceIdAnnual: text("stripe_price_id_annual"),
  metadata: jsonb("metadata").$type<Record<string, any>>().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  slugIdx: index("pricing_plans_slug_idx").on(table.slug),
  activeIdx: index("pricing_plans_active_idx").on(table.isActive),
}));

export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  category: text("category"),
  price: decimal("price", { precision: 10, scale: 2 }),
  isActive: boolean("is_active").default(true),
  imageUrl: text("image_url"),
  stripeProductId: text("stripe_product_id"),
  metadata: jsonb("metadata").$type<Record<string, any>>().default(sql`'{}'::jsonb`),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  slugIdx: index("products_slug_idx").on(table.slug),
  categoryIdx: index("products_category_idx").on(table.category),
}));

export const productFeatures = pgTable("product_features", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").references(() => products.id, { onDelete: "cascade" }),
  planId: varchar("plan_id").references(() => pricingPlans.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  isIncluded: boolean("is_included").default(true),
  limitValue: text("limit_value"),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  productIdx: index("product_features_product_idx").on(table.productId),
  planIdx: index("product_features_plan_idx").on(table.planId),
}));

export const promoCodes = pgTable("promo_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  discountType: text("discount_type").notNull().default("percentage"),
  discountValue: decimal("discount_value", { precision: 10, scale: 2 }).notNull(),
  applicablePlanIds: jsonb("applicable_plan_ids").$type<string[]>().default(sql`'[]'::jsonb`),
  maxRedemptions: integer("max_redemptions"),
  redemptionCount: integer("redemption_count").default(0),
  validFrom: timestamp("valid_from"),
  validUntil: timestamp("valid_until"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  codeIdx: index("promo_codes_code_idx").on(table.code),
  activeIdx: index("promo_codes_active_idx").on(table.isActive),
}));

export const gettingStartedPackages = pgTable("getting_started_packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  planId: varchar("plan_id").references(() => pricingPlans.id),
  includedProducts: jsonb("included_products").$type<string[]>().default(sql`'[]'::jsonb`),
  price: decimal("price", { precision: 10, scale: 2 }),
  setupFee: decimal("setup_fee", { precision: 10, scale: 2 }).default("0.00"),
  isActive: boolean("is_active").default(true),
  sortOrder: integer("sort_order").default(0),
  features: jsonb("features").$type<string[]>().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  planIdx: index("gsp_plan_idx").on(table.planId),
  activeIdx: index("gsp_active_idx").on(table.isActive),
}));

export type DealFunnelStage = typeof dealFunnelStages.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Coupon = typeof coupons.$inferSelect;
export type Special = typeof specials.$inferSelect;
export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type PricingPlan = typeof pricingPlans.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductFeature = typeof productFeatures.$inferSelect;
export type PromoCode = typeof promoCodes.$inferSelect;
export type GettingStartedPackage = typeof gettingStartedPackages.$inferSelect;
