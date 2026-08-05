/**
 * Wave 4 (DB switchover task #346) — identity, sessions, billing &
 * settings Postgres tables. This is the final and highest-blast-radius
 * cutover wave: the entities everything joins to.
 *
 * Per the runbook (`docs/runbooks/db-w4-cutover.md`) the W4 cutover
 * happens inside an announced maintenance window because every
 * authenticated request reads `sessions` from Mongo before doing
 * anything; switching that under live traffic would mean re-issuing
 * every active session or running a complex dual-read shim. A short
 * window where everyone is logged out and the cutover happens cleanly
 * is much safer.
 *
 * Conventions (carried over from `wave1.ts` / `wave2.ts` / `wave3.ts`):
 *   - Natural keys are the primary key wherever the Mongo collection has
 *     one (`shops.mos_shop_id`, `enterprise_accounts.id` (ObjectId text),
 *     `users.id` (ObjectId text), `sessions.token`, `(shop_id,
 *     feature_key)` for `shop_features`).
 *   - Heterogeneous Mongo subdocs (shop billing, integration creds,
 *     stripe payloads) are captured as `jsonb` rather than expanded
 *     into dozens of nullable columns. Indexed lookup fields are
 *     pulled out as columns alongside.
 *   - All timestamps are `timestamptz`.
 *   - Foreign keys are declared with `references(() => parent.col)`
 *     and `onDelete: "cascade"` for child rows that have no meaning
 *     without their parent (sessions, shop_features). Soft references
 *     across loosely-coupled entities (e.g. enterprise_accounts.shop_ids)
 *     are NOT FKs — Mongo never enforced them and tightening that here
 *     would block the backfill on shops we're allowed to discover later.
 *
 * Auth surface is unchanged: still custom session + bcrypt + Chrome
 * extension bearer token. Only storage moves to Postgres.
 *
 * See `docs/db-migration-map.md` §3.1 / §3.2 and
 * `docs/runbooks/db-w4-cutover.md` for the cutover playbook.
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  serial,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/* ========================================================================== */
/* enterprise_accounts                                                        */
/* Parent of shops.enterprise_id. Backfilled FIRST in the W4 dependency      */
/* chain so shops can FK-reference it.                                       */
/* ========================================================================== */

export const enterpriseAccounts = pgTable(
  "enterprise_accounts",
  {
    /** Mongo ObjectId, kept as text so existing references work unchanged. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /**
     * Soft list of mos_shop_ids in this enterprise. Mongo stored this as
     * an array of mixed string/number ids; we normalize to int[] at
     * backfill time. Not an FK — see header.
     */
    shopIds: jsonb("shop_ids").notNull().default([]),
    sharedMappings: jsonb("shared_mappings"),
    sharedIntegrations: jsonb("shared_integrations"),
    featureSettings: jsonb("feature_settings"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("enterprise_accounts_name_idx").on(t.name),
  }),
);

/* ========================================================================== */
/* shops                                                                      */
/* Highest fan-in entity in the system. Keyed on the normalized              */
/* `mos_shop_id` (#300). The legacy numeric `id` is preserved alongside     */
/* for the handful of admin lookups that key on it.                          */
/* ========================================================================== */

export const shops = pgTable(
  "shops",
  {
    /** Canonical numeric shop id (was `shops.shopId` in Mongo). */
    mosShopId: integer("mos_shop_id").primaryKey(),
    /** Legacy numeric primary key from the originating system. */
    legacyId: integer("legacy_id"),
    name: text("name"),
    locationIdentifier: text("location_identifier"),
    enterpriseId: text("enterprise_id").references(() => enterpriseAccounts.id, {
      onDelete: "set null",
    }),
    /**
     * Per-shop overrides on platform features. Resolves below per-shop
     * `shop_features` and below enterprise/plan defaults. Stored as
     * `{ [featureKey]: boolean }`.
     */
    enabledFeatures: jsonb("enabled_features"),
    /**
     * Billing subdoc (plan, status, trial dates, stripeCustomerId,
     * grace period markers, vinViewCount, etc.). Kept as jsonb because
     * the shape evolves frequently with billing changes; promoted
     * indexed columns below for the hot read paths (status, plan,
     * stripe customer id).
     */
    billing: jsonb("billing"),
    billingPlan: text("billing_plan"),
    billingStatus: text("billing_status"),
    stripeCustomerId: text("stripe_customer_id"),
    /**
     * Per-integration settings blobs (`autoflow`, `tekmetric`,
     * `protractor`, `shopware`, `branding`, `inspection`, etc.). Many
     * route handlers do nested-key updates on these subdocs (e.g.
     * `$set: { 'autoflow.apiKey': ... }`); the W4 PG repo translates
     * those into jsonb path updates.
     */
    settings: jsonb("settings"),
    /** Sticker / branding config (was `shop.sticker`). */
    sticker: jsonb("sticker"),
    /** Free-form metadata Mongo accumulated (createdVia, signupSource, ...). */
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    legacyIdIdx: index("shops_legacy_id_idx").on(t.legacyId),
    enterpriseIdx: index("shops_enterprise_idx").on(t.enterpriseId),
    stripeCustomerIdx: index("shops_stripe_customer_idx").on(t.stripeCustomerId),
    billingStatusIdx: index("shops_billing_status_idx").on(t.billingStatus),
  }),
);

/* ========================================================================== */
/* users                                                                      */
/* Bcrypt password hashes, extension bearer tokens, must-change-password    */
/* flag, role, primary + multi-shop assignments.                            */
/*                                                                            */
/* `email_lower` is a generated/maintained mirror of `email` so the unique  */
/* index can be enforced case-insensitively without breaking existing       */
/* mixed-case display values. The backfill (`scripts/backfill-email-lower  */
/* .ts` already exists) ensures Mongo has it; the W4 backfill carries it    */
/* forward.                                                                  */
/* ========================================================================== */

export const users = pgTable(
  "users",
  {
    /** Mongo ObjectId text — preserves cross-collection references. */
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailLower: text("email_lower").notNull(),
    /** Bcrypt hash. Plaintext fallbacks were retired in #302/#307/#308. */
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("owner"),
    /**
     * Primary shop assignment. FK enforced with `ON DELETE SET NULL`
     * so a shop deletion never orphans the user; legacy platform-admin
     * accounts that predate any shop simply hold NULL.
     */
    shopId: integer("shop_id").references(() => shops.mosShopId, {
      onDelete: "set null",
    }),
    /** Multi-shop access list (mos_shop_ids). */
    shopIds: jsonb("shop_ids").notNull().default([]),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /** Chrome extension bearer token (`ext_…`). */
    extensionToken: text("extension_token"),
    extensionTokenCreatedAt: timestamp("extension_token_created_at", {
      withTimezone: true,
    }),
    /** Free-form profile fields Mongo carried (firstName, lastName, ...). */
    profile: jsonb("profile"),
    /**
     * Loose audit subdoc (lastPasswordResetAt, lastPasswordResetBy,
     * etc.). Kept as jsonb to avoid widening the table every time an
     * audit field is added.
     */
    auditMeta: jsonb("audit_meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * Case-insensitive email uniqueness — auth + signup + password
     * reset all key on this. Mongo enforced this via a partial index on
     * `email_lower`; we make it a hard unique constraint here.
     */
    emailLowerUniq: uniqueIndex("users_email_lower_uniq").on(t.emailLower),
    /**
     * Extension bearer-token lookup (lib/extension-auth.ts +
     * lib/auth.ts ext_ fallback). Partial: only rows that have a token.
     * Drizzle pg-core doesn't expose a partial-index helper; we make it
     * a regular UNIQUE here. Tokens are unique by construction (random
     * 32 bytes), and NULL is allowed in PG unique indexes.
     */
    extensionTokenUniq: uniqueIndex("users_extension_token_uniq").on(t.extensionToken),
    shopIdx: index("users_shop_idx").on(t.shopId),
    platformAdminIdx: index("users_platform_admin_idx").on(t.isPlatformAdmin),
  }),
);

/* ========================================================================== */
/* sessions                                                                   */
/* Custom server-side session store. Cookie value is the `token` PK.        */
/* `shop_id` carries the shop the session is currently scoped to (changes  */
/* on switch-shop). FK to users so user deletion cleans the table.         */
/* ========================================================================== */

export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shopId: integer("shop_id"),
    isImpersonation: boolean("is_impersonation").notNull().default(false),
    impersonatedBy: text("impersonated_by"),
    /** Per-session copy of the must-change-password gate (see lib/auth.ts). */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

/* ========================================================================== */
/* shop_users — explicit join (kept as W4 per audit reclassification         */
/* in task #341, since `app/api/platform-admin/tickets/route.ts` still uses */
/* it for ticket-notification routing).                                      */
/* ========================================================================== */

export const shopUsers = pgTable(
  "shop_users",
  {
    shopId: integer("shop_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.userId] }),
    userIdx: index("shop_users_user_idx").on(t.userId),
  }),
);

/* ========================================================================== */
/* shop_features (per-(shop, feature) on/off + settings + subscription)      */
/* The à-la-carte feature toggle store backing lib/features.ts. Modeled as  */
/* one row per (shop_id, feature_key) per W4 acceptance criteria so we can  */
/* index/query a single feature across shops without scanning a JSON array. */
/* The Mongo source doc (one-per-shop with `enabledFeatures: string[]`,    */
/* `featureSettings: { [key]: ... }`, `subscriptions: [{ featureId, ... }]`)*/
/* is exploded by the backfill into N rows here.                            */
/* ========================================================================== */

export const shopFeatures = pgTable(
  "shop_features",
  {
    shopId: integer("shop_id")
      .notNull()
      .references(() => shops.mosShopId, { onDelete: "cascade" }),
    /** Feature identifier (matches the Mongo `enabledFeatures` strings and
     * the keys in `featureSettings` / `subscriptions[].featureId`). */
    featureKey: text("feature_key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** Per-feature settings blob (was `featureSettings[featureKey]` in Mongo). */
    settings: jsonb("settings"),
    /** Stripe subscription metadata for à-la-carte features that are
     * billed individually (was an entry of `subscriptions[]` in Mongo). */
    subscription: jsonb("subscription"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.featureKey] }),
    featureIdx: index("shop_features_feature_key_idx").on(t.featureKey),
  }),
);

/* ========================================================================== */
/* platform_admins (auxiliary admin-only users — distinct from `users`     */
/* with isPlatformAdmin=true, used by the dedicated platform-admin login).  */
/* ========================================================================== */

export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailLower: text("email_lower").notNull(),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("platform_admin"),
    name: text("name"),
    /** Loose metadata blob (lastLoginAt, createdBy, scopes, etc.). */
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailLowerUniq: uniqueIndex("platform_admins_email_lower_uniq").on(t.emailLower),
  }),
);

/* ========================================================================== */
/* platform_settings (`{ type: 'billing', ... }`, `{ type: 'sticker',     */
/* ... }`, etc.). Keyed on `type`.                                         */
/* ========================================================================== */

export const platformSettings = pgTable("platform_settings", {
  type: text("type").primaryKey(),
  payload: jsonb("payload").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ========================================================================== */
/* platform_plans — canonical definition lives in wave2.ts (that is the    */
/* shape prod actually has: monthly_price/annual_price/features/raw).      */
/* A second, incompatible definition used to live here (price_per_month/   */
/* included_vins/active/sort_order) but its CREATE TABLE was always        */
/* skipped because drizzle/0012 creates the table first. Task #1022        */
/* removed it; import `platformPlans` from ./wave2.                        */
/* ========================================================================== */

/* ========================================================================== */
/* Auth-adjacent token tables (pending_signups, setup_tokens,              */
/* password_reset_tokens). Each is keyed on `token` with TTL via           */
/* `expires_at` + a partial index for the cron sweep.                      */
/* ========================================================================== */

export const pendingSignups = pgTable(
  "pending_signups",
  {
    token: text("token").primaryKey(),
    email: text("email").notNull(),
    emailLower: text("email_lower").notNull(),
    payload: jsonb("payload"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index("pending_signups_email_idx").on(t.emailLower),
    expiresIdx: index("pending_signups_expires_idx").on(t.expiresAt),
  }),
);

export const setupTokens = pgTable(
  "setup_tokens",
  {
    token: text("token").primaryKey(),
    email: text("email").notNull(),
    emailLower: text("email_lower").notNull(),
    shopId: integer("shop_id"),
    payload: jsonb("payload"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index("setup_tokens_email_idx").on(t.emailLower),
    expiresIdx: index("setup_tokens_expires_idx").on(t.expiresAt),
  }),
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    token: text("token").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email"),
    emailLower: text("email_lower"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("password_reset_tokens_user_idx").on(t.userId),
    expiresIdx: index("password_reset_tokens_expires_idx").on(t.expiresAt),
  }),
);

/* ========================================================================== */
/* Billing                                                                    */
/* ========================================================================== */

/**
 * `billing_settings` — per-shop billing override blob (was the
 * `billing_settings` Mongo collection — distinct from `shops.billing`,
 * which is the shop's authoritative subscription state).
 */
export const billingSettings = pgTable("billing_settings", {
  shopId: integer("shop_id")
    .primaryKey()
    .references(() => shops.mosShopId, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `billing_status_log` — append-only audit of billing state changes
 * (grace period extensions, manual overrides, status flips). Keyed by
 * serial id; the original Mongo `_id` is preserved as
 * `backfill_mongo_id` so the backfill upsert is idempotent.
 */
export const billingStatusLog = pgTable(
  "billing_status_log",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    reason: text("reason"),
    actor: text("actor"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopCreatedIdx: index("billing_status_log_shop_created_idx").on(t.shopId, t.createdAt),
    backfillUniq: uniqueIndex("billing_status_log_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* Stripe webhook idempotency                                                 */
/* `stripe_events` and `stripe_webhook_events` are the dedupe stores         */
/* webhooks read on every replay. The cutover MUST preserve them or         */
/* Stripe re-deliveries will double-process. The W4 runbook includes a      */
/* synthetic-replay parity check.                                            */
/* ========================================================================== */

export const stripeEvents = pgTable(
  "stripe_events",
  {
    id: text("id").primaryKey(), // stripe event id (`evt_…`)
    type: text("type"),
    livemode: boolean("livemode"),
    apiVersion: text("api_version"),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    typeIdx: index("stripe_events_type_idx").on(t.type),
  }),
);

export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    id: text("id").primaryKey(),
    type: text("type"),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => ({
    typeIdx: index("stripe_webhook_events_type_idx").on(t.type),
  }),
);
