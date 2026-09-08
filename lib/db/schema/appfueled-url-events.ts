import {
  boolean,
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Durable, token-authenticated AppFueled vehicle-URL webhook ingress. */
export const appfueledUrlConnections = pgTable(
  "appfueled_url_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: text("connection_id").notNull(),
    mosShopId: integer("mos_shop_id").notNull(),
    incomingShopId: bigint("incoming_shop_id", { mode: "number" }).notNull(),
    shopIdNamespace: text("shop_id_namespace").notNull(),
    namespaceConfirmation: text("namespace_confirmation").notNull(),
    allowedHosts: jsonb("allowed_hosts").notNull().default([]),
    tokenHash: text("token_hash").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: text("disabled_by"),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    rotatedBy: text("rotated_by"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastReceiptId: uuid("last_receipt_id"),
  },
  (t) => ({
    connectionIdUnique: uniqueIndex("appfueled_url_connections_connection_id_uq").on(t.connectionId),
    tokenHashUnique: uniqueIndex("appfueled_url_connections_token_hash_uq").on(t.tokenHash),
    shopIdx: index("appfueled_url_connections_shop_idx").on(t.mosShopId),
    idLengthsCheck: check("appfueled_url_connections_id_lengths_check",
      sql`char_length(${t.connectionId}) BETWEEN 1 AND 128 AND ${t.tokenHash} ~ '^[0-9a-f]{64}$' AND jsonb_typeof(${t.allowedHosts}) = 'array' AND jsonb_array_length(${t.allowedHosts}) BETWEEN 1 AND 10`),
    provisioningCheck: check("appfueled_url_connections_provisioning_check",
      sql`${t.mosShopId} > 0 AND ${t.incomingShopId} > 0 AND ${t.incomingShopId} <= 9007199254740991 AND ${t.shopIdNamespace} IN ('mos','provider') AND char_length(${t.namespaceConfirmation}) BETWEEN 10 AND 500`),
    mosNamespaceCheck: check("appfueled_url_connections_mos_namespace_check",
      sql`${t.shopIdNamespace} <> 'mos' OR ${t.incomingShopId} = ${t.mosShopId}`),
  }),
).enableRLS();

export const appfueledUrlReceipts = pgTable(
  "appfueled_url_receipts",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id").notNull().references(() => appfueledUrlConnections.id, { onDelete: "cascade" }),
    mosShopId: integer("mos_shop_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    vin: text("vin"),
    payload: jsonb("payload").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason").notNull(),
    vehicleUrl: text("vehicle_url"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    ipHash: text("ip_hash").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connectionCorrelationUnique: uniqueIndex("appfueled_url_receipts_connection_correlation_uq").on(t.connectionId, t.correlationId),
    receivedIdx: index("appfueled_url_receipts_received_idx").on(t.receivedAt),
    shopReceivedIdx: index("appfueled_url_receipts_shop_received_idx").on(t.mosShopId, t.receivedAt),
    connectionReceivedIdx: index("appfueled_url_receipts_connection_received_idx").on(t.connectionId, t.receivedAt),
    vinReceivedIdx: index("appfueled_url_receipts_vin_received_idx").on(t.vin, t.receivedAt),
    outcomeReceivedIdx: index("appfueled_url_receipts_outcome_received_idx").on(t.outcome, t.receivedAt),
    boundsCheck: check("appfueled_url_receipts_bounds_check",
      sql`${t.mosShopId} > 0 AND ${t.durationMs} >= 0 AND ${t.outcome} IN ('accepted','rejected') AND (${t.vin} IS NULL OR ${t.vin} ~ '^[A-HJ-NPR-Z0-9]{17}$') AND ${t.ipHash} ~ '^[0-9a-f]{64}$' AND octet_length(${t.payload}::text) <= 16384 AND char_length(${t.reason}) BETWEEN 1 AND 100 AND ((${t.outcome} = 'accepted' AND ${t.vin} IS NOT NULL AND char_length(${t.vehicleUrl}) BETWEEN 1 AND 2048) OR (${t.outcome} = 'rejected' AND ${t.vehicleUrl} IS NULL))`),
  }),
).enableRLS();

export const appfueledVehicleUrls = pgTable(
  "appfueled_vehicle_urls",
  {
    connectionId: uuid("connection_id").notNull().references(() => appfueledUrlConnections.id, { onDelete: "cascade" }),
    mosShopId: integer("mos_shop_id").notNull(),
    vin: text("vin").notNull(),
    vehicleUrl: text("vehicle_url").notNull(),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull(),
    sourceReceiptId: uuid("source_receipt_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.connectionId, t.mosShopId, t.vin] }),
    shopVinIdx: index("appfueled_vehicle_urls_shop_vin_idx").on(t.mosShopId, t.vin),
    receivedIdx: index("appfueled_vehicle_urls_received_idx").on(t.lastReceivedAt),
    boundsCheck: check("appfueled_vehicle_urls_bounds_check",
      sql`${t.mosShopId} > 0 AND ${t.vin} ~ '^[A-HJ-NPR-Z0-9]{17}$' AND char_length(${t.vehicleUrl}) BETWEEN 1 AND 2048`),
  }),
).enableRLS();

/** Short-lived fixed-window counter used only for cross-instance ingress gating. */
export const appfueledUrlRateBuckets = pgTable(
  "appfueled_url_rate_buckets",
  {
    bucketKey: text("bucket_key").primaryKey(),
    count: integer("count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index("appfueled_url_rate_buckets_expires_idx").on(t.expiresAt),
  }),
).enableRLS();