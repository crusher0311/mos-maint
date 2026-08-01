/**
 * Backfill Mongo → Supabase.
 *
 *   • For the 6 dual-written normalized collections (W3a, task #344): uses
 *     `lib/supabase-dual-writer.ts` so field mappings stay in sync with the
 *     live ingestion path.
 *   • For the W3b raw mirrors (task #345 — Tekmetric / Protractor /
 *     Shopware / Autoflow / Autovitals / pre-normalized / plan caches /
 *     events / api_keys / job_index family / Carfax): uses the
 *     `MirrorSpec` registry below. Each mirror declares the source Mongo
 *     collection, the target PG table, the natural-key columns, and a
 *     small `extract(doc) -> { keys, indexed, payload }` mapper. The
 *     same checkpoint / retry / batching machinery is reused.
 *
 * Usage:
 *   tsx scripts/backfill-mongo-to-supabase.ts                       # all normalized collections
 *   tsx scripts/backfill-mongo-to-supabase.ts --collection=vehicles # single normalized collection
 *   tsx scripts/backfill-mongo-to-supabase.ts --mirror=events        # single W3b mirror
 *   tsx scripts/backfill-mongo-to-supabase.ts --mirror=all-w3b       # every W3b mirror, in order
 *   tsx scripts/backfill-mongo-to-supabase.ts --shop=54              # single shop (numeric mosShopId)
 *   tsx scripts/backfill-mongo-to-supabase.ts --batch=500            # batch size (default 250)
 *   tsx scripts/backfill-mongo-to-supabase.ts --concurrency=4        # parallel upserts per batch (default 4)
 *   tsx scripts/backfill-mongo-to-supabase.ts --reset                # discard checkpoint and start over
 *   tsx scripts/backfill-mongo-to-supabase.ts --verify-only          # skip backfill, just print row-count diffs
 *   tsx scripts/backfill-mongo-to-supabase.ts --dry-run              # iterate Mongo but do not write to Supabase
 *
 * Resumable: checkpoint stored in .local/backfill-checkpoint.json keyed by
 * (collection, shopFilter). Each batch advances the checkpoint to the last
 * processed _id, so a re-run picks up where it left off.
 */

import fs from "node:fs";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDb as getMongoDb } from "../lib/mongo";
import * as pgSchema from "../lib/db/schema";
import { SupabaseDualWriter } from "../lib/supabase-dual-writer";

// Dedicated Postgres pool for the backfill so we don't contend with the live
// app's tiny shared pool (max: 2 in lib/db/drizzle.ts).
function makeDedicatedPgDb() {
  const url = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATAONE_DATABASE_URL or DATABASE_URL");
  const client = postgres(url, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 30,
    max_lifetime: 60 * 30,
  });
  return drizzle(client, { schema: pgSchema });
}
const getPgDb = makeDedicatedPgDb;
import {
  normalizedVehicles,
  normalizedCustomers,
  normalizedWorkOrders,
  normalizedServiceJobs,
  normalizedLineItems,
  normalizedPayments,
} from "../lib/db/schema/normalized";

type CollectionKey =
  | "vehicles"
  | "customers"
  | "work_orders"
  | "service_jobs"
  | "line_items"
  | "payments";

interface CollectionSpec {
  key: CollectionKey;
  mongoName: string;
  pgTable: any;
  upsert: (writer: SupabaseDualWriter, doc: any) => Promise<void>;
}

const COLLECTIONS: CollectionSpec[] = [
  {
    key: "vehicles",
    mongoName: "normalized_vehicles",
    pgTable: normalizedVehicles,
    upsert: (w, d) => w.upsertVehicle(d),
  },
  {
    key: "customers",
    mongoName: "normalized_customers",
    pgTable: normalizedCustomers,
    upsert: (w, d) => w.upsertCustomer(d),
  },
  {
    key: "work_orders",
    mongoName: "normalized_work_orders",
    pgTable: normalizedWorkOrders,
    upsert: (w, d) => w.upsertWorkOrder(d),
  },
  {
    key: "service_jobs",
    mongoName: "normalized_service_jobs",
    pgTable: normalizedServiceJobs,
    upsert: (w, d) => w.upsertServiceJob(d),
  },
  {
    key: "line_items",
    mongoName: "normalized_line_items",
    pgTable: normalizedLineItems,
    upsert: (w, d) => w.upsertLineItem(d),
  },
  {
    key: "payments",
    mongoName: "normalized_payments",
    pgTable: normalizedPayments,
    upsert: (w, d) => w.upsertPayment(d),
  },
];

/* ========================================================================== */
/* W3b raw-mirror registry (task #345).                                       */
/*                                                                            */
/* Each MirrorSpec declares how to copy one Mongo collection into the         */
/* corresponding Postgres table from `lib/db/schema/wave3.ts`. The engine     */
/* below builds a parameterised `INSERT ... ON CONFLICT (...) DO {UPDATE,     */
/* NOTHING}` statement per spec, so we don't have to write per-table SQL by   */
/* hand and the same checkpoint / retry / batch / dry-run / verify machinery  */
/* used for the normalized collections is reused.                             */
/*                                                                            */
/* Two PK conventions are supported:                                          */
/*  • `naturalKey: string[]` — composite natural key (e.g. ['shopId',         */
/*    'workOrderId']). Conflict target is the natural key and `payload` /     */
/*    `updatedAt` are refreshed.                                              */
/*  • Otherwise the engine assumes the table has a `backfill_mongo_id` text   */
/*    column with a unique index, and inserts with `ON CONFLICT                */
/*    (backfill_mongo_id) DO NOTHING` so reruns are idempotent.               */
/* ========================================================================== */

type ExtractedRow = {
  /** Map of pg-column-name (snake_case) to JS value. */
  values: Record<string, unknown>;
  /**
   * Optional override of the natural-key conflict columns. Defaults to
   * `spec.naturalKey`. Used by tables whose unique key varies by row
   * shape (e.g. carfax_cache uses `cache_key`).
   */
  conflictKey?: string[];
};

interface MirrorSpec {
  key: string;
  mongoName: string;
  pgTableName: string;
  /**
   * Composite natural key. When set, the engine emits an upsert
   * keyed on these columns. When unset, the engine assumes a
   * `backfill_mongo_id` UNIQUE column and emits insert-or-skip.
   */
  naturalKey?: string[];
  /**
   * When true (the default for natural-key tables), the engine
   * refreshes `payload` + `updated_at` (or `fetched_at`) on
   * conflict. When false the spec is treated as insert-or-skip even
   * with a natural key — useful for append-only mirrors like
   * `protractor_callback_events` where a re-emit shouldn't clobber
   * the original timestamp.
   */
  refreshOnConflict?: boolean;
  /** Mongo filter — defaults to {} or {shopId} when --shop is set. */
  buildFilter?: (shop?: number) => Record<string, unknown>;
  /**
   * PG column used to filter `--shop` in `verifyMirror`. Defaults to
   * `shop_id`; Shopware mirrors use `mos_shop_id`. Set to `null` for
   * tables that aren't shop-scoped (e.g. `protractor_callback_events`,
   * `events`, `api_keys`) — `--shop` is then ignored on the PG side.
   */
  shopFilterColumn?: string | null;
  /** Map a mongo doc into a row. May return null to skip the doc. */
  /**
   * Map a mongo doc into one or more PG rows. May return null to skip
   * the doc, a single row, or an array of rows (used by mirrors that
   * explode a single Mongo document into N PG rows — e.g. shop_features
   * which stores `enabledFeatures: string[]` in Mongo but is keyed on
   * `(shop_id, feature_key)` in PG).
   */
  extract: (doc: any) => ExtractedRow | ExtractedRow[] | null;
}

/* ---------------------------- helpers ----------------------------------- */

function asDate(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function asInt(v: any): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}
function asStr(v: any): string | null {
  if (v == null) return null;
  return String(v);
}

const filterByShop = (shop?: number) => (shop != null ? { shopId: shop } : {});

/* ---------------------------- spec catalog ------------------------------ */

const MIRRORS: MirrorSpec[] = [
  /* events / api_keys are PG-canonical via repositories; they can also be
   * backfilled here for historical Mongo rows that pre-date the cutover. */
  {
    key: "events",
    mongoName: "events",
    pgTableName: "events",
    // `events.shop_id` is text, not int — verify-mirror's `--shop`
    // filter is shop-scoped on the Mongo side via buildFilter; PG
    // side is unfiltered to keep the parity check simple.
    shopFilterColumn: null,
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        provider: asStr(d.provider),
        event: asStr(d.event),
        type: asStr(d.type),
        shop_id: d.shopId != null ? String(d.shopId) : null,
        vehicle_vin: asStr(d.vehicleVin),
        vin: asStr(d.vin ?? d.vehicleVin),
        received_at: asDate(d.receivedAt),
        created_at: asDate(d.createdAt) ?? new Date(),
        payload: d,
      },
    }),
    buildFilter: (s) => (s != null ? { shopId: s } : {}),
  },
  {
    key: "api_keys",
    mongoName: "api_keys",
    pgTableName: "api_keys",
    naturalKey: ["id"],
    refreshOnConflict: false,
    // api_keys is global; per-shop verification doesn't apply.
    shopFilterColumn: null,
    extract: (d) => ({
      values: {
        id: String(d._id),
        shop_id: asInt(d.shopId),
        key_hash: asStr(d.keyHash),
        key_prefix: asStr(d.keyPrefix),
        name: asStr(d.name) ?? "",
        permissions: Array.isArray(d.permissions) ? d.permissions : [],
        rate_limit: asInt(d.rateLimit) ?? 0,
        rate_limit_tier: asStr(d.rateLimitTier),
        is_active: !!d.isActive,
        revoked: !!d.revoked,
        last_used_at: asDate(d.lastUsedAt),
        usage_count: asInt(d.usageCount) ?? 0,
        created_at: asDate(d.createdAt) ?? new Date(),
        created_by: asStr(d.createdBy) ?? "",
        expires_at: asDate(d.expiresAt),
        is_partner: !!d.isPartner,
        partner_id: asStr(d.partnerId),
        partner_name: asStr(d.partnerName),
      },
    }),
  },
  {
    key: "api_usage_logs",
    mongoName: "api_usage_logs",
    pgTableName: "external_api_usage_logs",
    refreshOnConflict: false,
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        key_hash: asStr(d.keyHash),
        shop_id: asInt(d.shopId),
        endpoint: asStr(d.endpoint) ?? "",
        method: asStr(d.method) ?? "",
        status_code: asInt(d.statusCode) ?? 0,
        response_time: asInt(d.responseTime) ?? 0,
        timestamp: asDate(d.timestamp) ?? new Date(),
        ip: asStr(d.ip),
      },
    }),
  },

  /* Tekmetric mirrors */
  {
    key: "tekmetric_work_orders",
    mongoName: "tekmetric_work_orders",
    pgTableName: "tekmetric_work_orders",
    naturalKey: ["shop_id", "work_order_id"],
    buildFilter: filterByShop,
    extract: (d) => {
      const wid = asStr(d.workOrderId ?? d.id ?? d._id);
      const sid = asInt(d.shopId);
      if (sid == null || !wid) return null;
      return {
        values: {
          shop_id: sid,
          work_order_id: wid,
          repair_order_number: asInt(d.repairOrderNumber),
          status: asStr(d.status?.name ?? d.status),
          vin: asStr(d.vin),
          customer_id: asStr(d.customerId),
          vehicle_id: asStr(d.vehicleId),
          completed_date: asDate(d.completedDate),
          posted_date: asDate(d.postedDate),
          updated_date: asDate(d.updatedDate ?? d.updatedAt),
          payload: d,
          fetched_at: asDate(d.fetchedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "tekmetric_repair_orders",
    mongoName: "tekmetric_repair_orders",
    pgTableName: "tekmetric_repair_orders",
    naturalKey: ["shop_id", "repair_order_id"],
    buildFilter: filterByShop,
    extract: (d) => {
      const rid = asStr(d.repairOrderId ?? d.id ?? d._id);
      const sid = asInt(d.shopId);
      if (sid == null || !rid) return null;
      return {
        values: {
          shop_id: sid,
          repair_order_id: rid,
          repair_order_number: asInt(d.repairOrderNumber),
          status: asStr(d.status?.name ?? d.status),
          vin: asStr(d.vin),
          completed_date: asDate(d.completedDate),
          updated_date: asDate(d.updatedDate ?? d.updatedAt),
          payload: d,
          fetched_at: asDate(d.fetchedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "tekmetric_vehicles",
    mongoName: "tekmetric_vehicles",
    pgTableName: "tekmetric_vehicles",
    naturalKey: ["shop_id", "vehicle_id"],
    buildFilter: filterByShop,
    extract: (d) => {
      const vid = asStr(d.vehicleId ?? d.id ?? d._id);
      const sid = asInt(d.shopId ?? d.tekmetric?.shopId);
      if (sid == null || !vid) return null;
      return {
        values: {
          shop_id: sid,
          vehicle_id: vid,
          vin: asStr(d.vin),
          customer_id: asStr(d.customerId),
          year: asInt(d.year),
          make: asStr(d.make),
          model: asStr(d.model),
          payload: d,
          updated_at: asDate(d.updatedAt ?? d.fetchedAt) ?? new Date(),
        },
      };
    },
  },
  /* tekmetric_tokens: schema-specific (encrypted columns + `raw` jsonb) —
   * cutover is handled by the auth library, not this generic mirror.
   * Deferred to the per-integration Tekmetric soak follow-up. */

  /* Protractor mirrors */
  {
    key: "protractor_work_orders",
    mongoName: "protractor_work_orders",
    pgTableName: "protractor_work_orders",
    naturalKey: ["shop_id", "work_order_id"],
    buildFilter: filterByShop,
    extract: (d) => {
      const wid = asStr(d.workOrderId ?? d._id);
      const sid = asInt(d.shopId);
      if (sid == null || !wid) return null;
      return {
        values: {
          shop_id: sid,
          work_order_id: wid,
          work_order_guid: asStr(d.workOrderGuid),
          work_order_number: asInt(d.workOrderNumber),
          type: asStr(d.type),
          status: asStr(d.status),
          vin: asStr(d.vin),
          service_item_id: asStr(d.serviceItemId),
          contact_id: asStr(d.contactId),
          odometer: asInt(d.odometer),
          workflow_stage: asStr(d.workflowStage),
          completed: d.completed != null ? !!d.completed : null,
          scheduled_time: asStr(d.scheduledTime),
          promised_time: asStr(d.promisedTime),
          payload: d,
          fetched_at: asDate(d.fetchedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "protractor_invoices",
    mongoName: "protractor_invoices",
    pgTableName: "protractor_invoices",
    naturalKey: ["shop_id", "invoice_id"],
    buildFilter: filterByShop,
    extract: (d) => {
      const iid = asStr(d.invoiceId ?? d._id);
      const sid = asInt(d.shopId);
      if (sid == null || !iid) return null;
      return {
        values: {
          shop_id: sid,
          invoice_id: iid,
          invoice_number: asInt(d.invoiceNumber),
          vin: asStr(d.vin),
          completed_date: asDate(d.completedDate),
          payload: d,
          fetched_at: asDate(d.fetchedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "protractor_vehicles",
    mongoName: "protractor_vehicles",
    pgTableName: "protractor_vehicles",
    naturalKey: ["shop_id", "vin"],
    buildFilter: filterByShop,
    extract: (d) => {
      const vin = asStr(d.vin);
      const sid = asInt(d.shopId);
      if (sid == null || !vin) return null;
      return {
        values: {
          shop_id: sid,
          vin,
          protractor_id: asStr(d.protractorId ?? d._id),
          year: asInt(d.year),
          make: asStr(d.make),
          model: asStr(d.model),
          odometer: asInt(d.odometer),
          odometer_date: asStr(d.odometerDate),
          license_plate: asStr(d.licensePlate),
          owner_id: asStr(d.ownerId),
          payload: d,
          fetched_at: asDate(d.fetchedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "protractor_callback_events",
    mongoName: "protractor_callback_events",
    pgTableName: "protractor_callback_events",
    refreshOnConflict: false,
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        // Task #1006: backfilled rows get the Mongo _id hex as their
        // event_key — the same key the runtime Mongo mode hands out — so
        // any in-flight retry key still resolves after the flag flip.
        event_key: asStr(d.eventKey) ?? String(d._id),
        shop_id: asInt(d.shopId),
        event_type: asStr(d.eventType ?? d.type),
        received_at: asDate(d.receivedAt) ?? new Date(),
        payload: d,
        method: asStr(d.method),
        connection_id: asStr(d.connectionId),
        object_type: asStr(d.objectType),
        object_id: asStr(d.objectId),
        operation: asStr(d.operation),
        work_order_id: asStr(d.workOrderId),
        status: asStr(d.status),
        processed: d.processed === true,
        processed_at: asDate(d.processedAt),
        attempts: asInt(d.attempts),
        priority: asInt(d.priority),
        processing_started_at: asDate(d.processingStartedAt),
        last_attempt_at: asDate(d.lastAttemptAt),
        last_error: asStr(d.lastError),
        last_error_at: asDate(d.lastErrorAt),
        vin: asStr(d.vin),
        work_order_number:
          d.workOrderNumber == null ? null : String(d.workOrderNumber),
        no_action: typeof d.noAction === "boolean" ? d.noAction : null,
        deleted_from_dashboard:
          typeof d.deletedFromDashboard === "boolean" ? d.deletedFromDashboard : null,
      },
    }),
    buildFilter: filterByShop,
  },

  /* Shop-Ware mirrors */
  {
    key: "shopware_repair_orders",
    mongoName: "shopware_repair_orders",
    pgTableName: "shopware_repair_orders",
    naturalKey: ["mos_shop_id", "ro_id"],
    shopFilterColumn: "mos_shop_id",
    // Mongo `shopware_repair_orders` is keyed on mosShopId + roId.
    buildFilter: (s) => (s != null ? { mosShopId: s } : {}),
    extract: (d) => {
      const mos = asInt(d.mosShopId ?? d.shopId);
      const ro = asInt(d.roId ?? d.id);
      if (mos == null || ro == null) return null;
      return {
        values: {
          mos_shop_id: mos,
          ro_id: ro,
          tenant_id: asInt(d.tenantId),
          sw_shop_id: asInt(d.swShopId),
          number: asInt(d.number),
          state: asStr(d.state),
          vin: asStr(d.vin),
          customer_id: asInt(d.customerId),
          vehicle_id: asInt(d.vehicleId),
          customer_name: asStr(d.customerName),
          vehicle_year: asInt(d.vehicleYear),
          vehicle_make: asStr(d.vehicleMake),
          vehicle_model: asStr(d.vehicleModel),
          odometer: asInt(d.odometer),
          service_count: asInt(d.serviceCount),
          created_at_src: asDate(d.createdAtSrc ?? d.createdAt),
          updated_at_src: asDate(d.updatedAtSrc ?? d.updatedAt),
          closed_at: asDate(d.closedAt),
          deleted: !!d.deleted,
          deleted_at: asDate(d.deletedAt),
          deleted_via_webhook: d.deletedViaWebhook != null ? !!d.deletedViaWebhook : null,
          partial_from_webhook: d.partialFromWebhook != null ? !!d.partialFromWebhook : null,
          fetch_error: asStr(d.fetchError),
          raw: d.raw ?? d,
          synced_at: asDate(d.syncedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "shopware_vehicles",
    mongoName: "shopware_vehicles",
    pgTableName: "shopware_vehicles",
    naturalKey: ["mos_shop_id", "vehicle_id"],
    shopFilterColumn: "mos_shop_id",
    buildFilter: (s) => (s != null ? { mosShopId: s } : {}),
    extract: (d) => {
      const mos = asInt(d.mosShopId ?? d.shopId);
      const vid = asInt(d.vehicleId ?? d.id);
      if (mos == null || vid == null) return null;
      return {
        values: {
          mos_shop_id: mos,
          vehicle_id: vid,
          vin: asStr(d.vin),
          year: asInt(d.year),
          make: asStr(d.make),
          model: asStr(d.model),
          customer_id: asInt(d.customerId),
          payload: d,
          updated_at: asDate(d.updatedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "shopware_customers",
    mongoName: "shopware_customers",
    pgTableName: "shopware_customers",
    naturalKey: ["mos_shop_id", "customer_id"],
    shopFilterColumn: "mos_shop_id",
    buildFilter: (s) => (s != null ? { mosShopId: s } : {}),
    extract: (d) => {
      const mos = asInt(d.mosShopId ?? d.shopId);
      const cid = asInt(d.customerId ?? d.id);
      if (mos == null || cid == null) return null;
      return {
        values: {
          mos_shop_id: mos,
          customer_id: cid,
          name: asStr(d.name),
          payload: d,
          updated_at: asDate(d.updatedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "shopware_webhook_logs",
    mongoName: "shopware_webhook_logs",
    pgTableName: "shopware_webhook_logs",
    refreshOnConflict: false,
    shopFilterColumn: "mos_shop_id",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        mos_shop_id: asInt(d.mosShopId ?? d.shopId),
        sw_shop_id: asInt(d.swShopId),
        event_type: asStr(d.eventType ?? d.type),
        received_at: asDate(d.receivedAt) ?? new Date(),
        payload: d,
        processed: !!d.processed,
        process_error: asStr(d.processError),
      },
    }),
  },

  /* autoflow_credentials: encrypted columns (api_key_enc / api_password_enc)
   * — handled by the AutoFlow auth library, not this generic mirror.
   * Deferred to per-integration AutoFlow soak follow-up. */
  {
    key: "autoflow_dvi_items",
    mongoName: "autoflow_dvi_items",
    pgTableName: "autoflow_dvi_items",
    extract: (d) => {
      const sid = asInt(d.shopId);
      if (sid == null) return null;
      return {
        values: {
          backfill_mongo_id: String(d._id),
          shop_id: sid,
          dvi_id: asStr(d.dviId ?? d.sheetId),
          item_id: asStr(d.itemId),
          vin: asStr(d.vin),
          label: asStr(d.label),
          severity: asStr(d.severity),
          note: asStr(d.note),
          payload: d,
          received_at: asDate(d.receivedAt) ?? new Date(),
        },
      };
    },
    buildFilter: filterByShop,
  },
  {
    key: "autoflow_events",
    mongoName: "autoflow_events",
    pgTableName: "autoflow_events",
    refreshOnConflict: false,
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        event_type: asStr(d.eventType ?? d.type),
        received_at: asDate(d.receivedAt) ?? new Date(),
        payload: d,
      },
    }),
    buildFilter: filterByShop,
  },
  {
    key: "af_open",
    mongoName: "af_open",
    pgTableName: "af_open",
    naturalKey: ["shop_id", "ro_number"],
    buildFilter: filterByShop,
    extract: (d) => {
      const ro = asStr(d.roNumber);
      const sid = asInt(d.shopId);
      if (sid == null || !ro) return null;
      return {
        values: {
          shop_id: sid,
          ro_number: ro,
          payload: d,
          updated_at: asDate(d.updatedAt) ?? new Date(),
        },
      };
    },
  },

  /* Autovitals mirrors */
  {
    key: "autovitals_vehicles",
    mongoName: "autovitals_vehicles",
    pgTableName: "autovitals_vehicles",
    naturalKey: ["shop_id", "vehicle_id"],
    // Mongo `autovitals_*.shopId` is stored as a string; PG schema mirrors that.
    buildFilter: (s) => (s != null ? { shopId: String(s) } : {}),
    extract: (d) => {
      const sid = d.shopId != null ? String(d.shopId) : null;
      const vid = asInt(d.vehicleId ?? d.id);
      if (!sid || vid == null) return null;
      return {
        values: {
          shop_id: sid,
          vehicle_id: vid,
          vin: asStr(d.vin),
          year: asInt(d.year),
          make: asStr(d.make),
          model: asStr(d.model),
          mileage: asInt(d.mileage),
          license_plate: asStr(d.licensePlate),
          color: asStr(d.color),
          customer_id: asInt(d.customerId),
          customer_name: asStr(d.customerName),
          payload: d,
          updated_at: asDate(d.updatedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "autovitals_imports",
    mongoName: "autovitals_imports",
    pgTableName: "autovitals_imports",
    refreshOnConflict: false,
    buildFilter: (s) => (s != null ? { shopId: String(s) } : {}),
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: d.shopId != null ? String(d.shopId) : null,
        import_type: asStr(d.importType ?? d.type),
        started_at: asDate(d.startedAt),
        finished_at: asDate(d.finishedAt),
        success: d.success != null ? !!d.success : null,
        summary: d.summary ?? null,
        payload: d,
      },
    }),
  },
  /* autovitals_appointments / autovitals_inspections: schema indexes a
   * dozen domain-specific fields (appointmentId, inspectionResultId, ...)
   * — wired in the per-integration AutoVitals soak follow-up. */

  /* Pre-normalized layer (legacy `vehicles` / `customers` / `repair_orders`
   * / `manual_vehicles` collections) */
  {
    key: "pre_repair_orders",
    mongoName: "repair_orders",
    pgTableName: "pre_normalized_repair_orders",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        ro_number: asStr(d.roNumber),
        vin: asStr(d.vin),
        customer_id: asStr(d.customerId),
        status: asStr(d.status),
        mileage: asInt(d.mileage),
        opened_at: asDate(d.openedAt),
        closed_at: asDate(d.closedAt),
        payload: d,
        created_at: asDate(d.createdAt) ?? new Date(),
        updated_at: asDate(d.updatedAt) ?? new Date(),
      },
    }),
    buildFilter: filterByShop,
  },
  {
    key: "pre_vehicles",
    mongoName: "vehicles",
    pgTableName: "pre_normalized_vehicles",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        vin: asStr(d.vin),
        year: asInt(d.year),
        make: asStr(d.make),
        model: asStr(d.model),
        trim: asStr(d.trim),
        last_mileage: asInt(d.lastMileage),
        declined: d.declined ?? null,
        components: d.components ?? null,
        payload: d,
        created_at: asDate(d.createdAt) ?? new Date(),
        updated_at: asDate(d.updatedAt) ?? new Date(),
      },
    }),
    buildFilter: filterByShop,
  },
  {
    key: "pre_customers",
    mongoName: "customers",
    pgTableName: "pre_normalized_customers",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: d.shopId != null ? String(d.shopId) : null,
        name: asStr(d.name),
        first_name: asStr(d.firstName),
        last_name: asStr(d.lastName),
        email: asStr(d.email ?? d.emailLower),
        phone: asStr(d.phone),
        external_id: asStr(d.externalId),
        status: asStr(d.status),
        provider: asStr(d.provider),
        last_vin: asStr(d.lastVin),
        last_ro: asStr(d.lastRo),
        last_mileage: asInt(d.lastMileage),
        payload: d,
        created_at: asDate(d.createdAt) ?? new Date(),
        updated_at: asDate(d.updatedAt) ?? new Date(),
      },
    }),
    buildFilter: filterByShop,
  },
  {
    key: "pre_manual_vehicles",
    mongoName: "manual_vehicles",
    pgTableName: "pre_normalized_manual_vehicles",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        vin: asStr(d.vin),
        year: asInt(d.year),
        make: asStr(d.make),
        model: asStr(d.model),
        entered_by: asStr(d.enteredBy),
        payload: d,
        created_at: asDate(d.createdAt) ?? new Date(),
      },
    }),
    buildFilter: filterByShop,
  },

  /* DVI / canned jobs */
  {
    key: "dvi",
    mongoName: "dvi",
    pgTableName: "dvi",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        ro_number: asStr(d.roNumber),
        vin: asStr(d.vin),
        sheet_id: asStr(d.sheetId),
        mileage: asInt(d.mileage),
        ok: d.ok != null ? !!d.ok : null,
        empty: d.empty != null ? !!d.empty : null,
        error: asStr(d.error),
        fetched_at: asDate(d.fetchedAt),
        notes: asStr(d.notes),
        customer: d.customer ?? null,
        vehicle: d.vehicle ?? null,
        lines: d.lines ?? null,
        raw: d.raw ?? null,
        source: asStr(d.source),
      },
    }),
    buildFilter: filterByShop,
  },
  {
    key: "dvi_results",
    mongoName: "dvi_results",
    pgTableName: "dvi_results",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        dvi_id: asStr(d.dviId),
        ro_number: asStr(d.roNumber),
        vin: asStr(d.vin),
        payload: d,
        received_at: asDate(d.receivedAt) ?? new Date(),
      },
    }),
    buildFilter: filterByShop,
  },
  {
    key: "canned_jobs",
    mongoName: "canned_jobs",
    pgTableName: "canned_jobs",
    naturalKey: ["shop_id", "canned_job_id"],
    buildFilter: filterByShop,
    extract: (d) => {
      const cid = asStr(d.cannedJobId ?? d.id ?? d._id);
      const sid = asInt(d.shopId);
      if (sid == null || !cid) return null;
      return {
        values: {
          shop_id: sid,
          canned_job_id: cid,
          title: asStr(d.title),
          code: asStr(d.code),
          payload: d,
          updated_at: asDate(d.updatedAt) ?? new Date(),
        },
      };
    },
  },

  /* Plan / recommendation caches */
  {
    key: "plans",
    mongoName: "plans",
    pgTableName: "plans",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        vin: asStr(d.vin),
        payload: d,
        created_at: asDate(d.createdAt) ?? new Date(),
      },
    }),
    buildFilter: filterByShop,
  },
  {
    key: "plan_cache",
    mongoName: "plan_cache",
    pgTableName: "plan_cache",
    naturalKey: ["shop_id", "vin"],
    buildFilter: filterByShop,
    extract: (d) => {
      const vin = asStr(d.vin);
      const sid = asInt(d.shopId);
      if (sid == null || !vin) return null;
      return {
        values: {
          shop_id: sid,
          vin,
          payload: d.payload ?? d,
          cached_at: asDate(d.cachedAt) ?? new Date(),
          expires_at: asDate(d.expiresAt),
        },
      };
    },
  },
  {
    key: "recommendations",
    mongoName: "recommendations",
    pgTableName: "recommendations",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        vin: asStr(d.vin),
        payload: d,
      },
    }),
    buildFilter: filterByShop,
  },

  /* Job index family */
  {
    key: "job_index",
    mongoName: "job_index",
    pgTableName: "job_index",
    extract: (d) => {
      const sid = asInt(d.shopId);
      if (sid == null) return null;
      // Task #382 — Forward ACES IDs into the PG job_index columns so
      // ongoing Mongo→PG mirror keeps `aces_vehicle_id` / `aces_engine_id`
      // continuously in sync. Source of truth is `vehicle.aces*` (canonical
      // shape used by Tek/SW/Protractor live indexers); fall back to
      // top-level for legacy shape compatibility.
      const acesVid = d.vehicle?.acesVehicleId ?? d.acesVehicleId ?? null;
      const acesEid = d.vehicle?.acesEngineId ?? d.acesEngineId ?? null;
      return {
        values: {
          backfill_mongo_id: String(d._id),
          shop_id: sid,
          work_order_number: asInt(d.workOrderNumber),
          job_title: asStr(d.jobTitle),
          job_code: asStr(d.jobCode),
          vehicle_vin: asStr(d.vehicleVin ?? d.vehicle?.vin ?? d.vin),
          service_item_id: asStr(d.serviceItemId),
          performed_at: asDate(d.performedAt),
          aces_vehicle_id: acesVid,
          aces_engine_id: acesEid,
          lines: d.lines ?? null,
          payload: d,
        },
      };
    },
    buildFilter: filterByShop,
  },
  {
    key: "job_history",
    mongoName: "job_history",
    pgTableName: "job_history",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        payload: d,
        received_at: asDate(d.receivedAt) ?? new Date(),
      },
    }),
    buildFilter: filterByShop,
  },
  {
    key: "jobs",
    mongoName: "jobs",
    pgTableName: "jobs",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        vin: asStr(d.vin),
        payload: d,
        created_at: asDate(d.createdAt) ?? new Date(),
      },
    }),
    buildFilter: filterByShop,
  },
  {
    key: "sms_historical_work_orders",
    mongoName: "sms_historical_work_orders",
    pgTableName: "sms_historical_work_orders",
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        vin: asStr(d.vin),
        ro_number: asStr(d.roNumber),
        provider: asStr(d.provider),
        payload: d,
        received_at: asDate(d.receivedAt) ?? new Date(),
      },
    }),
    buildFilter: filterByShop,
  },

  /* Carfax */
  {
    key: "carfax_reports",
    mongoName: "carfax_reports",
    pgTableName: "carfax_reports",
    naturalKey: ["shop_id", "vin"],
    buildFilter: filterByShop,
    extract: (d) => {
      const vin = asStr(d.vin);
      const sid = asInt(d.shopId);
      if (sid == null || !vin) return null;
      return {
        values: {
          shop_id: sid,
          vin,
          fetched_at: asDate(d.fetchedAt),
          report_date: asStr(d.reportDate),
          number_of_owners: asInt(d.numberOfOwners),
          accidents: asInt(d.accidents),
          damage_reports: asInt(d.damageReports),
          last_reported_mileage: asInt(d.lastReportedMileage),
          service_records: d.serviceRecords ?? null,
          title_issues: d.titleIssues ?? null,
          recalls: d.recalls ?? null,
          ok: d.ok != null ? !!d.ok : null,
          error: asStr(d.error),
          raw: d.raw ?? null,
          source: asStr(d.source),
          created_at: asDate(d.createdAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "carfax_history",
    mongoName: "carfax_history",
    pgTableName: "carfax_history",
    extract: (d) => {
      const vin = asStr(d.vin);
      if (!vin) return null;
      return {
        values: {
          backfill_mongo_id: String(d._id),
          vin,
          date: asStr(d.date),
          mileage: asInt(d.mileage),
          service: asStr(d.service),
          label: asStr(d.label),
          payload: d,
        },
      };
    },
  },
  {
    key: "carfax_cache",
    mongoName: "carfax_cache",
    pgTableName: "carfax_cache",
    naturalKey: ["cache_key"],
    extract: (d) => {
      const ck = asStr(d.cacheKey ?? d._id);
      if (!ck) return null;
      return {
        values: {
          cache_key: ck,
          payload: d.payload ?? d,
          cached_at: asDate(d.cachedAt) ?? new Date(),
          expires_at: asDate(d.expiresAt),
        },
      };
    },
  },

  /* ================================================================== */
  /* Wave 4 mirrors (task #346) — identity / sessions / billing /        */
  /* settings. Run in dependency order via `--mirror=all-w4`:            */
  /*   enterprise_accounts → shops → users → shop_features →             */
  /*   platform_admins → platform_settings → platform_plans →            */
  /*   pending_signups → setup_tokens → password_reset_tokens →          */
  /*   sessions → shop_users → billing_settings → billing_status_log →   */
  /*   stripe_events → stripe_webhook_events.                            */
  /* ================================================================== */
  {
    key: "enterprise_accounts",
    mongoName: "enterprise_accounts",
    pgTableName: "enterprise_accounts",
    naturalKey: ["id"],
    shopFilterColumn: null,
    extract: (d) => ({
      values: {
        id: String(d._id),
        name: asStr(d.name) ?? "",
        shop_ids: Array.isArray(d.shopIds) ? d.shopIds : [],
        shared_mappings: d.sharedMappings ?? null,
        shared_integrations: d.sharedIntegrations ?? null,
        feature_settings: d.featureSettings ?? null,
        created_at: asDate(d.createdAt) ?? new Date(),
        updated_at: asDate(d.updatedAt) ?? new Date(),
      },
    }),
  },
  {
    key: "shops",
    mongoName: "shops",
    pgTableName: "shops",
    naturalKey: ["mos_shop_id"],
    shopFilterColumn: "mos_shop_id",
    buildFilter: (s) => (s != null ? { shopId: s } : {}),
    extract: (d) => {
      const sid = asInt(d.shopId);
      if (sid == null) return null;
      // Settings is the catch-all jsonb container; copy any per-integration
      // sub-objects we're known to use into it so PG reads via
      // shopRowToDoc() see them at the top level.
      const settings: Record<string, unknown> = { ...(d.settings ?? {}) };
      for (const k of [
        "autoflow", "tekmetric", "protractor", "shopware",
        "autovitals", "branding", "inspection", "preferences", "carfax",
      ]) {
        if (d[k] !== undefined) settings[k] = d[k];
      }
      return {
        values: {
          mos_shop_id: sid,
          legacy_id: asInt(d.id),
          name: asStr(d.name),
          location_identifier: asStr(d.locationIdentifier),
          enterprise_id: d.enterpriseId != null ? String(d.enterpriseId) : null,
          enabled_features: d.enabledFeatures ?? null,
          billing: d.billing ?? null,
          billing_plan: asStr(d.billing?.plan),
          billing_status: asStr(d.billing?.status),
          stripe_customer_id:
            asStr(d.billing?.stripeCustomerId) ?? asStr(d.stripeCustomerId),
          settings,
          sticker: d.sticker ?? null,
          metadata: d.metadata ?? null,
          created_at: asDate(d.createdAt) ?? new Date(),
          updated_at: asDate(d.updatedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "users",
    mongoName: "users",
    pgTableName: "users",
    naturalKey: ["id"],
    shopFilterColumn: "shop_id",
    buildFilter: (s) => (s != null ? { shopId: s } : {}),
    extract: (d) => {
      const email = asStr(d.email);
      if (!email) return null;
      return {
        values: {
          id: String(d._id),
          email,
          email_lower: email.toLowerCase(),
          password_hash: asStr(d.passwordHash),
          role: asStr(d.role) ?? "owner",
          shop_id: asInt(d.shopId),
          shop_ids: Array.isArray(d.shopIds) ? d.shopIds : [],
          is_platform_admin: !!d.isPlatformAdmin,
          must_change_password: !!d.mustChangePassword,
          extension_token: asStr(d.extensionToken),
          extension_token_created_at: asDate(d.extensionTokenCreatedAt),
          profile: d.profile ?? null,
          audit_meta: d.auditMeta ?? null,
          created_at: asDate(d.createdAt) ?? new Date(),
          updated_at: asDate(d.updatedAt) ?? new Date(),
        },
      };
    },
  },
  {
    // Mongo stores one doc per shop with `enabledFeatures: string[]`,
    // `featureSettings: { [key]: settings }` and `subscriptions: [{
    // featureId, ... }]`. PG (per W4 acceptance criteria) is keyed on
    // `(shop_id, feature_key)`, so we explode the doc into one row per
    // distinct feature_key — flipping `enabled` based on
    // enabledFeatures membership and attaching the matching settings /
    // subscription blobs.
    key: "shop_features",
    mongoName: "shop_features",
    pgTableName: "shop_features",
    naturalKey: ["shop_id", "feature_key"],
    buildFilter: filterByShop,
    extract: (d) => {
      const sid = asInt(d.shopId);
      if (sid == null) return null;
      const enabledArr: string[] = Array.isArray(d.enabledFeatures)
        ? d.enabledFeatures.map(String)
        : [];
      const settingsMap: Record<string, unknown> =
        d.featureSettings && typeof d.featureSettings === "object"
          ? (d.featureSettings as Record<string, unknown>)
          : {};
      const subsArr: any[] = Array.isArray(d.subscriptions) ? d.subscriptions : [];
      const subsByKey = new Map<string, unknown>();
      for (const s of subsArr) {
        const fk = asStr(s?.featureId);
        if (fk) subsByKey.set(fk, s);
      }
      const keys = new Set<string>([
        ...enabledArr,
        ...Object.keys(settingsMap),
        ...subsByKey.keys(),
      ]);
      if (keys.size === 0) return null;
      const createdAt = asDate(d.createdAt) ?? new Date();
      const updatedAt = asDate(d.updatedAt) ?? new Date();
      return Array.from(keys).map((featureKey) => ({
        values: {
          shop_id: sid,
          feature_key: featureKey,
          enabled: enabledArr.includes(featureKey),
          settings: settingsMap[featureKey] ?? null,
          subscription: subsByKey.get(featureKey) ?? null,
          created_at: createdAt,
          updated_at: updatedAt,
        },
      }));
    },
  },
  {
    key: "platform_admins",
    mongoName: "platform_admins",
    pgTableName: "platform_admins",
    naturalKey: ["id"],
    shopFilterColumn: null,
    extract: (d) => {
      const email = asStr(d.email);
      if (!email) return null;
      return {
        values: {
          id: String(d._id),
          email,
          email_lower: email.toLowerCase(),
          password_hash: asStr(d.passwordHash),
          role: asStr(d.role) ?? "platform_admin",
          name: asStr(d.name),
          metadata: d.metadata ?? null,
          created_at: asDate(d.createdAt) ?? new Date(),
          updated_at: asDate(d.updatedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "platform_settings",
    mongoName: "platform_settings",
    pgTableName: "platform_settings",
    naturalKey: ["type"],
    shopFilterColumn: null,
    extract: (d) => {
      const type = asStr(d.type);
      if (!type) return null;
      // Strip the discriminator/timestamps so payload mirrors the API shape.
      const { _id, type: _t, updatedAt, ...payload } = d;
      return {
        values: {
          type,
          payload,
          updated_at: asDate(updatedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "platform_plans",
    mongoName: "platform_plans",
    pgTableName: "platform_plans",
    naturalKey: ["slug"],
    shopFilterColumn: null,
    extract: (d) => {
      const slug = asStr(d.slug);
      if (!slug) return null;
      return {
        values: {
          slug,
          name: asStr(d.name) ?? slug,
          description: asStr(d.description),
          stripe_product_id: asStr(d.stripeProductId),
          stripe_price_id: asStr(d.stripePriceId),
          price_per_month: d.pricePerMonth != null ? Number(d.pricePerMonth) : null,
          included_vins: asInt(d.includedVins),
          payload: d,
          active: d.active !== false,
          sort_order: asInt(d.sortOrder) ?? 0,
          created_at: asDate(d.createdAt) ?? new Date(),
          updated_at: asDate(d.updatedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "pending_signups",
    mongoName: "pending_signups",
    pgTableName: "pending_signups",
    naturalKey: ["token"],
    shopFilterColumn: null,
    extract: (d) => {
      const token = asStr(d.token);
      const email = asStr(d.email);
      const expiresAt = asDate(d.expiresAt);
      if (!token || !email || !expiresAt) return null;
      return {
        values: {
          token,
          email,
          email_lower: email.toLowerCase(),
          payload: d.payload ?? d,
          expires_at: expiresAt,
          created_at: asDate(d.createdAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "setup_tokens",
    mongoName: "setup_tokens",
    pgTableName: "setup_tokens",
    naturalKey: ["token"],
    shopFilterColumn: "shop_id",
    buildFilter: filterByShop,
    extract: (d) => {
      const token = asStr(d.token);
      const email = asStr(d.email);
      const expiresAt = asDate(d.expiresAt);
      if (!token || !email || !expiresAt) return null;
      return {
        values: {
          token,
          email,
          email_lower: email.toLowerCase(),
          shop_id: asInt(d.shopId),
          payload: d.payload ?? d,
          consumed_at: asDate(d.consumedAt),
          expires_at: expiresAt,
          created_at: asDate(d.createdAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "password_reset_tokens",
    mongoName: "password_reset_tokens",
    pgTableName: "password_reset_tokens",
    naturalKey: ["token"],
    shopFilterColumn: null,
    extract: (d) => {
      const token = asStr(d.token);
      const expiresAt = asDate(d.expiresAt);
      if (!token || !expiresAt) return null;
      const email = asStr(d.email);
      return {
        values: {
          token,
          user_id: d.userId != null ? String(d.userId) : null,
          email,
          email_lower: email ? email.toLowerCase() : null,
          consumed_at: asDate(d.consumedAt),
          expires_at: expiresAt,
          created_at: asDate(d.createdAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "sessions",
    mongoName: "sessions",
    pgTableName: "sessions",
    naturalKey: ["token"],
    shopFilterColumn: "shop_id",
    buildFilter: filterByShop,
    extract: (d) => {
      const token = asStr(d.token);
      const userId = d.userId != null ? String(d.userId) : null;
      const expiresAt = asDate(d.expiresAt);
      if (!token || !userId || !expiresAt) return null;
      return {
        values: {
          token,
          user_id: userId,
          shop_id: asInt(d.shopId),
          is_impersonation: !!d.isImpersonation,
          impersonated_by: d.impersonatedBy != null ? String(d.impersonatedBy) : null,
          must_change_password: !!d.mustChangePassword,
          expires_at: expiresAt,
          created_at: asDate(d.createdAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "shop_users",
    mongoName: "shop_users",
    pgTableName: "shop_users",
    naturalKey: ["shop_id", "user_id"],
    buildFilter: filterByShop,
    extract: (d) => {
      const sid = asInt(d.shopId);
      const uid = d.userId != null ? String(d.userId) : null;
      if (sid == null || !uid) return null;
      return {
        values: {
          shop_id: sid,
          user_id: uid,
          role: asStr(d.role),
          created_at: asDate(d.createdAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "billing_settings",
    mongoName: "billing_settings",
    pgTableName: "billing_settings",
    naturalKey: ["shop_id"],
    buildFilter: filterByShop,
    extract: (d) => {
      const sid = asInt(d.shopId);
      if (sid == null) return null;
      const { _id, shopId, updatedAt, ...payload } = d;
      return {
        values: {
          shop_id: sid,
          payload,
          updated_at: asDate(updatedAt) ?? new Date(),
        },
      };
    },
  },
  {
    key: "billing_status_log",
    mongoName: "billing_status_log",
    pgTableName: "billing_status_log",
    refreshOnConflict: false,
    shopFilterColumn: "shop_id",
    buildFilter: filterByShop,
    extract: (d) => ({
      values: {
        backfill_mongo_id: String(d._id),
        shop_id: asInt(d.shopId),
        from_status: asStr(d.fromStatus),
        to_status: asStr(d.toStatus),
        reason: asStr(d.reason),
        actor: asStr(d.actor),
        payload: d.payload ?? null,
        created_at: asDate(d.createdAt) ?? new Date(),
      },
    }),
  },
  {
    key: "stripe_events",
    mongoName: "stripe_events",
    pgTableName: "stripe_events",
    naturalKey: ["id"],
    refreshOnConflict: false,
    shopFilterColumn: null,
    extract: (d) => {
      const id = asStr(d.id ?? d._id);
      if (!id) return null;
      return {
        values: {
          id,
          type: asStr(d.type),
          livemode: d.livemode != null ? !!d.livemode : null,
          api_version: asStr(d.apiVersion ?? d.api_version),
          payload: d.payload ?? d,
          received_at: asDate(d.receivedAt) ?? asDate(d.createdAt) ?? new Date(),
          processed_at: asDate(d.processedAt),
        },
      };
    },
  },
  {
    key: "stripe_webhook_events",
    mongoName: "stripe_webhook_events",
    pgTableName: "stripe_webhook_events",
    naturalKey: ["id"],
    refreshOnConflict: false,
    shopFilterColumn: null,
    extract: (d) => {
      const id = asStr(d.id ?? d._id);
      if (!id) return null;
      return {
        values: {
          id,
          type: asStr(d.type),
          payload: d.payload ?? d,
          received_at: asDate(d.receivedAt) ?? asDate(d.createdAt) ?? new Date(),
          processed_at: asDate(d.processedAt),
          error: asStr(d.error),
        },
      };
    },
  },
];

// Wave 4 mirror keys, in dependency-safe replay order.
const W4_MIRROR_KEYS = [
  "enterprise_accounts",
  "shops",
  "users",
  "shop_features",
  "platform_admins",
  "platform_settings",
  "platform_plans",
  "pending_signups",
  "setup_tokens",
  "password_reset_tokens",
  "sessions",
  "shop_users",
  "billing_settings",
  "billing_status_log",
  "stripe_events",
  "stripe_webhook_events",
];

const MIRROR_BY_KEY = new Map(MIRRORS.map((s) => [s.key, s]));

interface Args {
  collection?: CollectionKey;
  mirror?: string; // a mirror key, or "all-w3b"
  shop?: number;
  batch: number;
  concurrency: number;
  reset: boolean;
  verifyOnly: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Args = {
    batch: 250,
    concurrency: 4,
    reset: false,
    verifyOnly: false,
    dryRun: false,
  };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    switch (k) {
      case "collection":
        out.collection = v as CollectionKey;
        break;
      case "mirror":
        out.mirror = v;
        break;
      case "shop":
        out.shop = Number(v);
        break;
      case "batch":
        out.batch = Number(v);
        break;
      case "concurrency":
        out.concurrency = Number(v);
        break;
      case "reset":
        out.reset = true;
        break;
      case "verify-only":
        out.verifyOnly = true;
        break;
      case "dry-run":
        out.dryRun = true;
        break;
      default:
        console.warn(`Unknown arg: --${k}`);
    }
  }
  return out;
}

const CHECKPOINT_DIR = path.join(process.cwd(), ".local");
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, "backfill-checkpoint.json");
const LOG_FILE = path.join(CHECKPOINT_DIR, "backfill.log");

function ensureLocalDir() {
  if (!fs.existsSync(CHECKPOINT_DIR)) fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
}

function logLine(msg: string) {
  ensureLocalDir();
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
  console.log(line);
}

// Capture uncaught crashes to the log file so we never lose context.
process.on("uncaughtException", (e) => {
  logLine(`UNCAUGHT EXCEPTION: ${e?.stack || e?.message || e}`);
  process.exit(2);
});
process.on("unhandledRejection", (e: any) => {
  logLine(`UNHANDLED REJECTION: ${e?.stack || e?.message || e}`);
  process.exit(2);
});

interface Checkpoint {
  [key: string]: {
    lastId: string | null;
    processed: number;
    upserted: number;
    skipped: number; // duplicate-key conflicts (same logical row, different Mongo _id)
    failed: number;
    failedIds: string[]; // doc _ids that errored; retried on subsequent runs before advancing past them
    finishedAt?: string;
  };
}

function checkpointKey(spec: CollectionSpec, shopFilter?: number): string {
  return shopFilter != null ? `${spec.key}:shop=${shopFilter}` : `${spec.key}:all`;
}

function loadCheckpoint(): Checkpoint {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  if (!fs.existsSync(CHECKPOINT_DIR)) fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

function isDuplicateKeyError(err: any): boolean {
  // Postgres SQLSTATE 23505 = unique_violation. postgres-js surfaces it via e.cause.
  const code = err?.code ?? err?.cause?.code;
  if (code === "23505") return true;
  const msg = String(err?.message ?? "") + " " + String(err?.cause?.message ?? "");
  return /duplicate key value violates unique constraint/i.test(msg);
}

/**
 * Postgres SQLSTATE 23502 = not_null_violation. Some legacy mongo docs lack
 * required fields (e.g. work_orders with empty vehicleId from Protractor
 * internal/non-vehicle invoices). These cannot be migrated as-is and are
 * counted as data-quality skips rather than transient failures.
 */
function isNotNullViolation(err: any): boolean {
  const code = err?.code ?? err?.cause?.code;
  if (code === "23502") return true;
  const msg = String(err?.message ?? "") + " " + String(err?.cause?.message ?? "");
  return /violates not-null constraint/i.test(msg);
}

/**
 * NOTE: SQLSTATE 23503 (foreign_key_violation) is intentionally NOT classified
 * as a data-quality skip. FK violations may indicate real defects (wrong ID
 * mapping, wrong shop scoping, parent collection ordered after child, etc.)
 * and should remain visible as `failed` so they show up in retry + error logs
 * for operator investigation.
 */
function isDataQualitySkip(err: any): boolean {
  return isDuplicateKeyError(err) || isNotNullViolation(err);
}

async function processInBatches<T extends { _id: any }>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<{
  ok: number;
  skipped: number;
  failed: number;
  failedIds: string[];
  errors: string[];
}> {
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const failedIds: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(slice.map(worker));
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        ok++;
      } else if (isDataQualitySkip(r.reason)) {
        // Either: (a) duplicate-key — same logical entity already in PG under
        // a different Mongo _id; (b) NOT-NULL violation — legacy mongo doc
        // missing required FK like vehicle_id (e.g. Protractor non-vehicle
        // invoices); or (c) FK violation — referenced parent not yet
        // backfilled. None are recoverable on retry, so count as skipped.
        skipped++;
      } else {
        failed++;
        failedIds.push(String(slice[idx]._id));
        if (errors.length < 5) errors.push(String(r.reason?.message || r.reason));
      }
    });
  }
  return { ok, skipped, failed, failedIds, errors };
}

async function backfillOne(spec: CollectionSpec, args: Args): Promise<void> {
  const mongo = await getMongoDb();
  const pg = getPgDb();
  const writer = new SupabaseDualWriter(pg);

  const cpAll = loadCheckpoint();
  const key = checkpointKey(spec, args.shop);
  if (args.reset) delete cpAll[key];
  const cp = cpAll[key] ?? {
    lastId: null,
    processed: 0,
    upserted: 0,
    skipped: 0,
    failed: 0,
    failedIds: [],
  };
  if (!Array.isArray(cp.failedIds)) cp.failedIds = [];
  if (typeof cp.skipped !== "number") cp.skipped = 0;

  // Retry previously-failed docs first so checkpoint advancement stays safe.
  if (cp.failedIds.length > 0 && !args.dryRun) {
    console.log(`  [${spec.key}] retrying ${cp.failedIds.length} previously-failed doc(s)...`);
    const retryDocs = await mongo
      .collection(spec.mongoName)
      .find({ _id: { $in: cp.failedIds as any } })
      .toArray();
    if (retryDocs.length !== cp.failedIds.length) {
      console.warn(
        `  [${spec.key}] retry expected ${cp.failedIds.length} docs but found ${retryDocs.length} in mongo`,
      );
    }
    const writerRetry = new SupabaseDualWriter(pg);
    const r = await processInBatches(retryDocs, args.concurrency, (d) =>
      spec.upsert(writerRetry, d),
    );
    const stillFailed = new Set(r.failedIds);
    cp.upserted += r.ok;
    cp.skipped += r.skipped;
    cp.failed = stillFailed.size; // counter reflects current outstanding
    cp.failedIds = Array.from(stillFailed);
    cpAll[key] = cp;
    saveCheckpoint(cpAll);
    if (r.errors.length) console.error(`  [${spec.key}] retry errors:`, r.errors);
    console.log(`  [${spec.key}] retry result: ok=${r.ok} stillFailed=${stillFailed.size}`);
  }

  const filter: Record<string, any> = {};
  if (args.shop != null) filter.shopId = args.shop;
  if (cp.lastId) filter._id = { $gt: cp.lastId };

  const total = await mongo.collection(spec.mongoName).countDocuments(filter);
  console.log(
    `\n[${spec.key}] starting backfill — ${total.toLocaleString()} docs to process` +
      (cp.lastId ? ` (resuming from _id > ${cp.lastId})` : "") +
      (args.shop != null ? ` (shop=${args.shop})` : ""),
  );
  if (total === 0) {
    cp.finishedAt = new Date().toISOString();
    cpAll[key] = cp;
    saveCheckpoint(cpAll);
    return;
  }

  const cursor = mongo
    .collection(spec.mongoName)
    .find(filter)
    .sort({ _id: 1 })
    .batchSize(args.batch);

  let buffer: any[] = [];
  const startedAt = Date.now();

  const flush = async () => {
    if (!buffer.length) return;
    if (args.dryRun) {
      // Dry run: count only, never mutate or persist the checkpoint.
      console.log(`  [${spec.key}] [dry-run] would process ${buffer.length} docs`);
      buffer = [];
      return;
    }
    const { ok, skipped, failed, failedIds, errors } = await processInBatches(
      buffer,
      args.concurrency,
      (doc) => spec.upsert(writer, doc),
    );
    cp.upserted += ok;
    cp.skipped += skipped;
    cp.failed += failed;
    cp.failedIds.push(...failedIds);
    cp.processed += buffer.length;
    // Safe to advance lastId past this batch because failedIds are persisted
    // in the checkpoint and will be retried on the next run before any new
    // forward progress is allowed.
    cp.lastId = String(buffer[buffer.length - 1]._id);
    cpAll[key] = cp;
    saveCheckpoint(cpAll);
    if (errors.length) {
      console.error(`  [${spec.key}] sample errors in batch:`, errors);
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = cp.processed / Math.max(elapsed, 1);
    const eta = (total - cp.processed) / Math.max(rate, 1);
    console.log(
      `  [${spec.key}] processed=${cp.processed.toLocaleString()}/${total.toLocaleString()} ok=${cp.upserted} skipped=${cp.skipped} failed=${cp.failed} rate=${rate.toFixed(0)}/s eta=${Math.round(eta)}s`,
    );
    buffer = [];
  };

  for await (const doc of cursor) {
    buffer.push(doc);
    if (buffer.length >= args.batch) await flush();
  }
  await flush();

  cp.finishedAt = new Date().toISOString();
  cpAll[key] = cp;
  saveCheckpoint(cpAll);
  console.log(
    `[${spec.key}] DONE — processed=${cp.processed.toLocaleString()} upserted=${cp.upserted.toLocaleString()} skipped=${cp.skipped.toLocaleString()} failedOutstanding=${cp.failedIds.length}`,
  );
}

/* ========================================================================== */
/* W3b mirror engine                                                          */
/* ========================================================================== */

type AnyPg = ReturnType<typeof getPgDb>;

function quoteIdent(name: string): string {
  // Allow snake_case identifiers only — defensive guard, not a SQL builder.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function buildMirrorUpsertSql(spec: MirrorSpec, row: ExtractedRow) {
  const cols = Object.keys(row.values);
  const colsSql = cols.map(quoteIdent).join(", ");
  const valuesChunk = sql.join(
    cols.map((c) => sql`${row.values[c]}`),
    sql`, `,
  );

  const conflictKey = row.conflictKey ?? spec.naturalKey;
  const refresh = spec.refreshOnConflict !== false;

  let conflictClause: SQL;
  if (conflictKey && conflictKey.length > 0) {
    const target = conflictKey.map(quoteIdent).join(", ");
    if (refresh) {
      const updatable = cols
        .filter((c) => !conflictKey.includes(c))
        .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
        .join(", ");
      conflictClause = updatable
        ? sql.raw(` ON CONFLICT (${target}) DO UPDATE SET ${updatable}`)
        : sql.raw(` ON CONFLICT (${target}) DO NOTHING`);
    } else {
      conflictClause = sql.raw(` ON CONFLICT (${target}) DO NOTHING`);
    }
  } else {
    conflictClause = sql.raw(` ON CONFLICT ("backfill_mongo_id") DO NOTHING`);
  }

  return sql`INSERT INTO ${sql.raw(quoteIdent(spec.pgTableName))} (${sql.raw(colsSql)}) VALUES (${valuesChunk})${conflictClause}`;
}

async function applyMirrorRow(
  pg: AnyPg,
  spec: MirrorSpec,
  doc: Record<string, unknown>,
): Promise<"ok" | "skipped"> {
  const out = spec.extract(doc);
  if (!out) return "skipped";
  const rows = Array.isArray(out) ? out : [out];
  if (rows.length === 0) return "skipped";
  for (const row of rows) {
    const stmt = buildMirrorUpsertSql(spec, row);
    await pg.execute(stmt);
  }
  return "ok";
}

async function backfillMirror(spec: MirrorSpec, args: Args): Promise<void> {
  const mongo = await getMongoDb();
  const pg = getPgDb();

  const cpAll = loadCheckpoint();
  const key = `mirror:${spec.key}` + (args.shop != null ? `:shop=${args.shop}` : "");
  if (args.reset) delete cpAll[key];
  const cp = cpAll[key] ?? {
    lastId: null,
    processed: 0,
    upserted: 0,
    skipped: 0,
    failed: 0,
    failedIds: [],
  };
  if (!Array.isArray(cp.failedIds)) cp.failedIds = [];

  const filter: Record<string, any> = spec.buildFilter
    ? spec.buildFilter(args.shop)
    : (args.shop != null ? { shopId: args.shop } : {});
  if (cp.lastId) filter._id = { $gt: cp.lastId };

  const total = await mongo.collection(spec.mongoName).countDocuments(filter);
  console.log(
    `\n[mirror ${spec.key}] starting — ${total.toLocaleString()} docs to process` +
      (cp.lastId ? ` (resuming from _id > ${cp.lastId})` : "") +
      (args.shop != null ? ` (shop=${args.shop})` : ""),
  );
  if (total === 0) {
    cp.finishedAt = new Date().toISOString();
    cpAll[key] = cp;
    saveCheckpoint(cpAll);
    return;
  }

  const cursor = mongo
    .collection(spec.mongoName)
    .find(filter)
    .sort({ _id: 1 })
    .batchSize(args.batch);

  let buffer: any[] = [];
  const startedAt = Date.now();

  const flush = async () => {
    if (!buffer.length) return;
    if (args.dryRun) {
      console.log(`  [mirror ${spec.key}] [dry-run] would process ${buffer.length} docs`);
      buffer = [];
      return;
    }
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    const failedIds: string[] = [];
    const errors: string[] = [];
    for (let i = 0; i < buffer.length; i += args.concurrency) {
      const slice = buffer.slice(i, i + args.concurrency);
      const results = await Promise.allSettled(
        slice.map((d) => applyMirrorRow(pg, spec, d)),
      );
      results.forEach((r, idx) => {
        if (r.status === "fulfilled") {
          if (r.value === "ok") ok++;
          else skipped++;
        } else if (isDataQualitySkip(r.reason)) {
          skipped++;
        } else {
          failed++;
          failedIds.push(String(slice[idx]._id));
          if (errors.length < 5) {
            const reason: unknown = r.reason;
            const msg =
              reason && typeof reason === "object" && "message" in reason
                ? String((reason as { message: unknown }).message)
                : String(reason);
            errors.push(msg);
          }
        }
      });
    }
    cp.upserted += ok;
    cp.skipped += skipped;
    cp.failed += failed;
    cp.failedIds.push(...failedIds);
    cp.processed += buffer.length;
    cp.lastId = String(buffer[buffer.length - 1]._id);
    cpAll[key] = cp;
    saveCheckpoint(cpAll);
    if (errors.length) console.error(`  [mirror ${spec.key}] sample errors:`, errors);
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = cp.processed / Math.max(elapsed, 1);
    const eta = (total - cp.processed) / Math.max(rate, 1);
    console.log(
      `  [mirror ${spec.key}] processed=${cp.processed.toLocaleString()}/${total.toLocaleString()} ok=${cp.upserted} skipped=${cp.skipped} failed=${cp.failed} rate=${rate.toFixed(0)}/s eta=${Math.round(eta)}s`,
    );
    buffer = [];
  };

  for await (const doc of cursor) {
    buffer.push(doc);
    if (buffer.length >= args.batch) await flush();
  }
  await flush();

  cp.finishedAt = new Date().toISOString();
  cpAll[key] = cp;
  saveCheckpoint(cpAll);
  console.log(
    `[mirror ${spec.key}] DONE — processed=${cp.processed.toLocaleString()} upserted=${cp.upserted.toLocaleString()} skipped=${cp.skipped.toLocaleString()} failedOutstanding=${cp.failedIds.length}`,
  );
}

async function verifyMirror(spec: MirrorSpec, args: Args): Promise<void> {
  const mongo = await getMongoDb();
  const pg = getPgDb();
  const filter = spec.buildFilter
    ? spec.buildFilter(args.shop)
    : (args.shop != null ? { shopId: args.shop } : {});
  const mongoCount = await mongo.collection(spec.mongoName).countDocuments(filter);
  const pgCount = await (async () => {
    const tbl = sql.raw(quoteIdent(spec.pgTableName));
    // shopFilterColumn defaults to "shop_id"; null means the table
    // isn't shop-scoped and `--shop` filters only the Mongo side.
    const shopCol =
      spec.shopFilterColumn === undefined ? "shop_id" : spec.shopFilterColumn;
    const useShopFilter = args.shop != null && shopCol != null;
    const rows = (useShopFilter
      ? await pg.execute(
          sql`SELECT COUNT(*)::bigint AS c FROM ${tbl} WHERE ${sql.raw(quoteIdent(shopCol))} = ${args.shop}`,
        )
      : await pg.execute(sql`SELECT COUNT(*)::bigint AS c FROM ${tbl}`)
    ) as unknown as Array<{ c: string | number }>;
    return Number(rows[0]?.c ?? 0);
  })();
  const diff = mongoCount - pgCount;
  const pct = mongoCount === 0 ? 100 : ((pgCount / mongoCount) * 100).toFixed(2);
  const tolerance = Math.max(5, mongoCount * 0.01);
  const status = Math.abs(diff) <= tolerance ? "OK" : diff > 0 ? "DRIFT(under)" : "DRIFT(over)";
  console.log(
    `[verify mirror ${spec.key}] mongo=${mongoCount.toLocaleString()} pg=${pgCount.toLocaleString()} diff=${diff.toLocaleString()} coverage=${pct}% ${status}`,
  );
}

async function verify(spec: CollectionSpec, args: Args): Promise<void> {
  const mongo = await getMongoDb();
  const pg = getPgDb();
  const filter: Record<string, any> = {};
  if (args.shop != null) filter.shopId = args.shop;
  const mongoCount = await mongo.collection(spec.mongoName).countDocuments(filter);

  const pgRows = (args.shop != null
    ? await pg.execute(
        sql`select count(*)::bigint as c from ${spec.pgTable} where shop_id = ${args.shop}`,
      )
    : await pg.execute(sql`select count(*)::bigint as c from ${spec.pgTable}`)
  ) as unknown as Array<{ c: string | number }>;
  const pgCount = Number(pgRows[0]?.c ?? 0);

  const diff = mongoCount - pgCount; // positive => PG missing rows; negative => PG has extras
  const pct = mongoCount === 0 ? 100 : ((pgCount / mongoCount) * 100).toFixed(2);
  const tolerance = Math.max(5, mongoCount * 0.01);
  const status = Math.abs(diff) <= tolerance ? "OK" : diff > 0 ? "DRIFT(under)" : "DRIFT(over)";
  console.log(
    `[verify ${spec.key}] mongo=${mongoCount.toLocaleString()} pg=${pgCount.toLocaleString()} diff=${diff.toLocaleString()} coverage=${pct}% ${status}`,
  );
}

async function main(): Promise<void> {
  logLine(`main() entered, argv=${JSON.stringify(process.argv.slice(2))}`);
  const args = parseArgs();

  // --mirror mode: W3b raw-mirror backfill. Mutually exclusive with --collection.
  if (args.mirror) {
    const mirrorTargets: MirrorSpec[] =
      args.mirror === "all-w3b"
        ? MIRRORS.filter((m) => !W4_MIRROR_KEYS.includes(m.key))
        : args.mirror === "all-w4"
          ? W4_MIRROR_KEYS.map((k) => MIRROR_BY_KEY.get(k)!).filter(Boolean)
          : (() => {
              const m = MIRROR_BY_KEY.get(args.mirror!);
              if (!m) {
                console.error(
                  `Unknown --mirror. Valid: ${MIRRORS.map((m) => m.key).join(", ")} (or 'all-w3b', 'all-w4')`,
                );
                process.exit(1);
              }
              return [m];
            })();

    logLine(
      `Mirror backfill plan: ${mirrorTargets.map((t) => t.key).join(" → ")}` +
        (args.shop != null ? ` (shop=${args.shop})` : "") +
        (args.dryRun ? " [DRY RUN]" : "") +
        (args.verifyOnly ? " [VERIFY ONLY]" : ""),
    );

    if (!args.verifyOnly) {
      for (const spec of mirrorTargets) {
        try {
          await backfillMirror(spec, args);
        } catch (e: any) {
          console.error(`[mirror ${spec.key}] FATAL:`, e?.stack || e?.message || e);
        }
      }
    }
    console.log("\n=== Verification ===");
    for (const spec of mirrorTargets) {
      try {
        await verifyMirror(spec, args);
      } catch (e: any) {
        console.error(`[verify mirror ${spec.key}] failed:`, e?.message || e);
      }
    }
    process.exit(0);
  }

  const targets = args.collection
    ? COLLECTIONS.filter((c) => c.key === args.collection)
    : COLLECTIONS;

  if (targets.length === 0) {
    console.error(`Unknown --collection. Valid: ${COLLECTIONS.map((c) => c.key).join(", ")}`);
    process.exit(1);
  }

  logLine(
    `Backfill plan: ${targets.map((t) => t.key).join(" → ")}` +
      (args.shop != null ? ` (shop=${args.shop})` : "") +
      (args.dryRun ? " [DRY RUN]" : "") +
      (args.verifyOnly ? " [VERIFY ONLY]" : ""),
  );

  if (!args.verifyOnly) {
    for (const spec of targets) {
      try {
        await backfillOne(spec, args);
      } catch (e: any) {
        console.error(`[${spec.key}] FATAL:`, e?.stack || e?.message || e);
      }
    }
  }

  console.log("\n=== Verification ===");
  for (const spec of targets) {
    try {
      await verify(spec, args);
    } catch (e: any) {
      console.error(`[verify ${spec.key}] failed:`, e?.message || e);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
