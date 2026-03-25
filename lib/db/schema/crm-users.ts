import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { crmAccounts, crmLocations } from "./crm-accounts";

export const crmUsers = pgTable("crm_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  emailLower: text("email_lower").notNull(),
  role: text("role").notNull().default("user"),
  shopId: integer("shop_id"),
  shopIds: jsonb("shop_ids").$type<number[]>().default(sql`'[]'::jsonb`),
  isPlatformAdmin: boolean("is_platform_admin").default(false),
  accountId: varchar("account_id").references(() => crmAccounts.id),
  locationId: varchar("location_id").references(() => crmLocations.id),
  contactId: varchar("contact_id"),
  mongoUserId: text("mongo_user_id"),
  status: text("status").notNull().default("Active"),
  lastLogin: timestamp("last_login"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (table) => ({
  emailLowerIdx: index("crm_users_email_lower_idx").on(table.emailLower),
  shopIdIdx: index("crm_users_shop_id_idx").on(table.shopId),
  accountIdx: index("crm_users_account_idx").on(table.accountId),
  statusIdx: index("crm_users_status_idx").on(table.status),
  mongoUserIdIdx: index("crm_users_mongo_user_id_idx").on(table.mongoUserId),
}));

export type CrmUser = typeof crmUsers.$inferSelect;
