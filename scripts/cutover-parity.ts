/**
 * Per-domain Mongo↔Postgres cutover parity / verification report (task #997).
 *
 * This is the identity + integration-cache sibling of
 * `scripts/wave1-parity-report.ts`. Where wave1 covered the 15 low-risk
 * cache/lookup collections, this script covers the high-blast-radius
 * identity tables (shops, users, sessions, billing, stripe dedupe) plus
 * the per-integration source-of-truth mirrors (tekmetric / protractor /
 * shopware / autoflow / autovitals) so each per-group cutover PR ships
 * with a concrete parity artifact.
 *
 * STRICTLY READ-ONLY. dev Mongo *is* production. This script issues only
 * `countDocuments` / `find().sort().limit()` against Mongo and
 * `SELECT`-only statements against Postgres. It never writes, never
 * creates an index, and never uses an index hint that would create one.
 *
 * Per entity it reports:
 *   - mongoCount / pgCount / countDelta (+ pct)
 *   - freshness: max of the natural recency field in each store
 *   - sampled key diffs BOTH directions:
 *       newest N Mongo docs → looked up in PG by natural key (missingFromPg)
 *       newest N PG rows    → looked up in Mongo by natural key (missingFromMongo)
 *   - for the Mongo→PG samples, a shallow field-equality spot check on
 *     2-3 promoted fields (e.g. vin / status)
 *
 * Missing PG tables (e.g. an autovitals mirror that was never given a
 * backfill spec) are reported as `status: "no-pg-table"` rather than
 * failing the whole run.
 *
 * CLI:
 *   pnpm tsx scripts/cutover-parity.ts --domain=identity
 *   pnpm tsx scripts/cutover-parity.ts --domain=all --sample=20
 *   pnpm tsx scripts/cutover-parity.ts --domain=tekmetric --json
 *
 * Flags:
 *   --domain=identity|tekmetric|protractor|shopware|autoflow|autovitals|legacy|all  (default: all)
 *   --sample=N   newest-N sample size per direction (default: 10)
 *   --json       also write a JSON report to
 *                docs/db-migration-audit-log/cutover-parity-<domain>-<ts>.json
 *
 * Exit codes:
 *   0  all entities within tolerance
 *   1  a domain/entity threw, OR any countDelta exceeds 1% of mongoCount,
 *      OR any sampled newest Mongo key was missing from PG
 *   2  bad CLI args (unknown --domain, empty selection)
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb as getMongo } from "@/lib/mongo";
import { getDb as getPg } from "@/lib/db/drizzle";
import { sql } from "drizzle-orm";

/* -------------------------------------------------------------------------- */
/* Spec types                                                                 */
/* -------------------------------------------------------------------------- */

type Doc = Record<string, unknown>;

type FieldCheck = {
  /** Human label for the promoted field (e.g. "vin"). */
  label: string;
  /** Pull the value from a Mongo doc. */
  fromMongo: (d: Doc) => unknown;
  /** SQL expression projecting the comparable value from PG (aliased later). */
  pgExpr: string;
};

type EntitySpec = {
  name: string;
  /** Mongo collection name. */
  mongoCollection: string;
  /**
   * Postgres table name, or null when no PG mirror exists yet. A null
   * table is reported as `no-pg-table` (backfill mirror spec missing)
   * instead of failing.
   */
  pgTable: string | null;
  /** Natural key derived from a Mongo doc. */
  mongoKey: (d: Doc) => string;
  /** SQL expression projecting the SAME natural key from PG. */
  pgKeyExpr: string;
  /**
   * Mongo recency field (Date) used for freshness. `_id` ObjectId
   * timestamp is used when no explicit field exists.
   */
  mongoRecencyField: string | null;
  /** Sort field for "newest N" Mongo docs (defaults to mongoRecencyField ?? _id). */
  mongoSortField?: string;
  /** PG recency column used for freshness + newest-N ordering. */
  pgRecencyExpr: string;
  /** 2-3 promoted fields spot-checked for shallow equality (Mongo→PG). */
  fieldChecks: FieldCheck[];
};

type DomainName =
  | "identity"
  | "tekmetric"
  | "protractor"
  | "shopware"
  | "autoflow"
  | "autovitals"
  | "legacy";

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Normalize any scalar to a comparable string ("" for null/undefined). */
function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    // Mongo ObjectId etc. expose a useful toString / toHexString.
    const o = v as { toHexString?: () => string; toString?: () => string };
    if (typeof o.toHexString === "function") return o.toHexString();
    if (typeof o.toString === "function") return o.toString();
  }
  return String(v);
}

/** Loose scalar equality used by the promoted-field spot check. */
function looseEq(a: unknown, b: unknown): boolean {
  const sa = s(a).trim();
  const sb = s(b).trim();
  if (sa === sb) return true;
  // numbers may arrive as "12" vs 12; compare numerically when both parse.
  const na = Number(sa);
  const nb = Number(sb);
  if (sa !== "" && sb !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na === nb;
  }
  return sa.toLowerCase() === sb.toLowerCase();
}

/** Coerce a PG scalar (Date | string | number | null) to a JS Date or null. */
function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const IDENTITY: EntitySpec[] = [
  {
    name: "shops",
    mongoCollection: "shops",
    pgTable: "shops",
    // Mongo stores the canonical id as `shopId` (a.k.a. mos_shop_id).
    mongoKey: (d) => s(d.mos_shop_id ?? d.shopId ?? d._id),
    pgKeyExpr: "mos_shop_id::text",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "name", fromMongo: (d) => d.name, pgExpr: "name" },
      {
        label: "billingStatus",
        fromMongo: (d) => (d.billing as Doc | undefined)?.status,
        pgExpr: "billing_status",
      },
    ],
  },
  {
    name: "users",
    mongoCollection: "users",
    pgTable: "users",
    mongoKey: (d) => s(d.id ?? d._id),
    pgKeyExpr: "id",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "email", fromMongo: (d) => d.email, pgExpr: "email" },
      { label: "role", fromMongo: (d) => d.role, pgExpr: "role" },
    ],
  },
  {
    name: "sessions",
    mongoCollection: "sessions",
    pgTable: "sessions",
    mongoKey: (d) => s(d.token ?? d._id),
    pgKeyExpr: "token",
    mongoRecencyField: "createdAt",
    pgRecencyExpr: "created_at",
    fieldChecks: [
      { label: "userId", fromMongo: (d) => d.userId, pgExpr: "user_id" },
    ],
  },
  {
    name: "enterprise_accounts",
    mongoCollection: "enterprise_accounts",
    pgTable: "enterprise_accounts",
    mongoKey: (d) => s(d.id ?? d._id),
    pgKeyExpr: "id",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "name", fromMongo: (d) => d.name, pgExpr: "name" },
    ],
  },
  {
    name: "platform_admins",
    mongoCollection: "platform_admins",
    pgTable: "platform_admins",
    mongoKey: (d) => s(d.id ?? d._id),
    pgKeyExpr: "id",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "email", fromMongo: (d) => d.email, pgExpr: "email" },
    ],
  },
  {
    name: "platform_settings",
    mongoCollection: "platform_settings",
    pgTable: "platform_settings",
    mongoKey: (d) => s(d.type ?? d._id),
    pgKeyExpr: "type",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [],
  },
  {
    name: "platform_plans",
    mongoCollection: "platform_plans",
    pgTable: "platform_plans",
    mongoKey: (d) => s(d.slug ?? d._id),
    pgKeyExpr: "slug",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "name", fromMongo: (d) => d.name, pgExpr: "name" },
    ],
  },
  {
    // Mongo source is one-doc-per-shop with an enabledFeatures[] array; the
    // PG mirror explodes it into (shop_id, feature_key) rows. Counts are
    // therefore expected to differ structurally — we key parity on shop_id
    // presence rather than exact row count. The key extractor below matches
    // the shop dimension so "newest Mongo shop present in PG" still holds.
    name: "shop_features",
    mongoCollection: "shop_features",
    pgTable: "shop_features",
    mongoKey: (d) => s(d.shopId ?? d.shop_id ?? d._id),
    pgKeyExpr: "shop_id::text",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [],
  },
  {
    name: "billing_settings",
    mongoCollection: "billing_settings",
    pgTable: "billing_settings",
    mongoKey: (d) => s(d.shopId ?? d.shop_id ?? d._id),
    pgKeyExpr: "shop_id::text",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [],
  },
  {
    name: "stripe_events",
    mongoCollection: "stripe_events",
    pgTable: "stripe_events",
    mongoKey: (d) => s(d.id ?? d._id),
    pgKeyExpr: "id",
    mongoRecencyField: "receivedAt",
    pgRecencyExpr: "received_at",
    fieldChecks: [
      { label: "type", fromMongo: (d) => d.type, pgExpr: "type" },
    ],
  },
  {
    name: "stripe_webhook_events",
    mongoCollection: "stripe_webhook_events",
    pgTable: "stripe_webhook_events",
    mongoKey: (d) => s(d.id ?? d._id),
    pgKeyExpr: "id",
    mongoRecencyField: "receivedAt",
    pgRecencyExpr: "received_at",
    fieldChecks: [
      { label: "type", fromMongo: (d) => d.type, pgExpr: "type" },
    ],
  },
];

const TEKMETRIC: EntitySpec[] = [
  {
    name: "tekmetric_work_orders",
    mongoCollection: "tekmetric_work_orders",
    pgTable: "tekmetric_work_orders",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.workOrderId ?? d.work_order_id ?? d.id)}`,
    pgKeyExpr: "shop_id::text || ':' || work_order_id",
    mongoRecencyField: "fetchedAt",
    pgRecencyExpr: "fetched_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "status", fromMongo: (d) => d.status, pgExpr: "status" },
    ],
  },
  {
    name: "tekmetric_repair_orders",
    mongoCollection: "tekmetric_repair_orders",
    pgTable: "tekmetric_repair_orders",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.repairOrderId ?? d.repair_order_id ?? d.id)}`,
    pgKeyExpr: "shop_id::text || ':' || repair_order_id",
    mongoRecencyField: "fetchedAt",
    pgRecencyExpr: "fetched_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "status", fromMongo: (d) => d.status, pgExpr: "status" },
    ],
  },
  {
    name: "tekmetric_vehicles",
    mongoCollection: "tekmetric_vehicles",
    pgTable: "tekmetric_vehicles",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.vehicleId ?? d.vehicle_id ?? d.id)}`,
    pgKeyExpr: "shop_id::text || ':' || vehicle_id",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "make", fromMongo: (d) => d.make, pgExpr: "make" },
    ],
  },
];

const PROTRACTOR: EntitySpec[] = [
  {
    name: "protractor_work_orders",
    mongoCollection: "protractor_work_orders",
    pgTable: "protractor_work_orders",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.workOrderId ?? d.work_order_id ?? d.id)}`,
    pgKeyExpr: "shop_id::text || ':' || work_order_id",
    mongoRecencyField: "fetchedAt",
    pgRecencyExpr: "fetched_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "status", fromMongo: (d) => d.status, pgExpr: "status" },
    ],
  },
  {
    name: "protractor_vehicles",
    mongoCollection: "protractor_vehicles",
    pgTable: "protractor_vehicles",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.vin)}`,
    pgKeyExpr: "shop_id::text || ':' || vin",
    mongoRecencyField: "fetchedAt",
    pgRecencyExpr: "fetched_at",
    fieldChecks: [
      { label: "make", fromMongo: (d) => d.make, pgExpr: "make" },
      { label: "model", fromMongo: (d) => d.model, pgExpr: "model" },
    ],
  },
  {
    name: "protractor_invoices",
    mongoCollection: "protractor_invoices",
    pgTable: "protractor_invoices",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.invoiceId ?? d.invoice_id ?? d.id)}`,
    pgKeyExpr: "shop_id::text || ':' || invoice_id",
    mongoRecencyField: "fetchedAt",
    pgRecencyExpr: "fetched_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
    ],
  },
  {
    name: "protractor_callback_events",
    mongoCollection: "protractor_callback_events",
    pgTable: "protractor_callback_events",
    // Append-only; PG keyed by serial id + backfill_mongo_id. Natural
    // cross-store key is the Mongo _id mirrored into backfill_mongo_id.
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "receivedAt",
    pgRecencyExpr: "received_at",
    fieldChecks: [
      { label: "eventType", fromMongo: (d) => d.eventType, pgExpr: "event_type" },
    ],
  },
];

const SHOPWARE: EntitySpec[] = [
  {
    name: "shopware_repair_orders",
    mongoCollection: "shopware_repair_orders",
    pgTable: "shopware_repair_orders",
    mongoKey: (d) => `${s(d.mosShopId ?? d.mos_shop_id ?? d.shopId)}:${s(d.roId ?? d.ro_id ?? d.id)}`,
    pgKeyExpr: "mos_shop_id::text || ':' || ro_id::text",
    mongoRecencyField: "syncedAt",
    pgRecencyExpr: "synced_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "state", fromMongo: (d) => d.state, pgExpr: "state" },
    ],
  },
  {
    name: "shopware_vehicles",
    mongoCollection: "shopware_vehicles",
    pgTable: "shopware_vehicles",
    mongoKey: (d) => `${s(d.mosShopId ?? d.mos_shop_id ?? d.shopId)}:${s(d.vehicleId ?? d.vehicle_id ?? d.id)}`,
    pgKeyExpr: "mos_shop_id::text || ':' || vehicle_id::text",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "make", fromMongo: (d) => d.make, pgExpr: "make" },
    ],
  },
  {
    name: "shopware_customers",
    mongoCollection: "shopware_customers",
    pgTable: "shopware_customers",
    mongoKey: (d) => `${s(d.mosShopId ?? d.mos_shop_id ?? d.shopId)}:${s(d.customerId ?? d.customer_id ?? d.id)}`,
    pgKeyExpr: "mos_shop_id::text || ':' || customer_id::text",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "name", fromMongo: (d) => d.name, pgExpr: "name" },
    ],
  },
];

const AUTOFLOW: EntitySpec[] = [
  {
    name: "autoflow_dvi_items",
    mongoCollection: "autoflow_dvi_items",
    pgTable: "autoflow_dvi_items",
    // PG has a UNIQUE backfill_mongo_id — the Mongo _id is the cross key.
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "receivedAt",
    pgRecencyExpr: "received_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "severity", fromMongo: (d) => d.severity, pgExpr: "severity" },
    ],
  },
  {
    name: "autoflow_events",
    mongoCollection: "autoflow_events",
    pgTable: "autoflow_events",
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "receivedAt",
    pgRecencyExpr: "received_at",
    fieldChecks: [
      { label: "eventType", fromMongo: (d) => d.eventType, pgExpr: "event_type" },
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
    ],
  },
  {
    name: "af_open",
    mongoCollection: "af_open",
    pgTable: "af_open",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.roNumber ?? d.ro_number)}`,
    pgKeyExpr: "shop_id::text || ':' || ro_number",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [],
  },
];

const AUTOVITALS: EntitySpec[] = [
  {
    name: "autovitals_vehicles",
    mongoCollection: "autovitals_vehicles",
    pgTable: "autovitals_vehicles",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.vehicleId ?? d.vehicle_id ?? d.id)}`,
    pgKeyExpr: "shop_id || ':' || vehicle_id::text",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "make", fromMongo: (d) => d.make, pgExpr: "make" },
    ],
  },
  {
    name: "autovitals_appointments",
    mongoCollection: "autovitals_appointments",
    pgTable: "autovitals_appointments",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.appointmentId ?? d.appointment_id ?? d.id)}`,
    pgKeyExpr: "shop_id || ':' || appointment_id::text",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "status", fromMongo: (d) => d.status, pgExpr: "status" },
    ],
  },
  {
    name: "autovitals_inspections",
    mongoCollection: "autovitals_inspections",
    pgTable: "autovitals_inspections",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.appointmentId ?? d.appointment_id ?? d.id)}`,
    pgKeyExpr: "shop_id || ':' || appointment_id::text",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "technicianName", fromMongo: (d) => d.technicianName, pgExpr: "technician_name" },
    ],
  },
];

/* Task #1000 — legacy pre-normalized stores (vehicles/customers/
 * manual_vehicles, DVI, canned jobs, concern conversations, repair
 * patterns, support tickets). */
const LEGACY: EntitySpec[] = [
  {
    name: "vehicles",
    mongoCollection: "vehicles",
    pgTable: "pre_normalized_vehicles",
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "make", fromMongo: (d) => d.make, pgExpr: "make" },
    ],
  },
  {
    name: "customers",
    mongoCollection: "customers",
    pgTable: "pre_normalized_customers",
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "externalId", fromMongo: (d) => d.externalId, pgExpr: "external_id" },
      { label: "status", fromMongo: (d) => d.status, pgExpr: "status" },
    ],
  },
  {
    name: "manual_vehicles",
    mongoCollection: "manual_vehicles",
    pgTable: "pre_normalized_manual_vehicles",
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "createdAt",
    pgRecencyExpr: "created_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
    ],
  },
  {
    name: "dvi",
    mongoCollection: "dvi",
    pgTable: "dvi",
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "fetchedAt",
    pgRecencyExpr: "fetched_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "roNumber", fromMongo: (d) => d.roNumber, pgExpr: "ro_number" },
    ],
  },
  {
    name: "dvi_results",
    mongoCollection: "dvi_results",
    pgTable: "dvi_results",
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "receivedAt",
    pgRecencyExpr: "received_at",
    fieldChecks: [
      { label: "roNumber", fromMongo: (d) => d.roNumber, pgExpr: "ro_number" },
    ],
  },
  {
    name: "canned_jobs",
    mongoCollection: "canned_jobs",
    pgTable: "canned_jobs",
    mongoKey: (d) => `${s(d.shopId ?? d.shop_id)}:${s(d.cannedJobId ?? d.id ?? d._id)}`,
    pgKeyExpr: "shop_id::text || ':' || canned_job_id",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "title", fromMongo: (d) => d.title ?? d.name, pgExpr: "title" },
    ],
  },
  {
    name: "canned_job_applications",
    mongoCollection: "canned_job_applications",
    pgTable: "canned_job_applications",
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "appliedAt",
    pgRecencyExpr: "applied_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
    ],
  },
  {
    name: "concern_conversations",
    mongoCollection: "concern_conversations",
    pgTable: "concern_conversations",
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "id",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "vin", fromMongo: (d) => d.vin, pgExpr: "vin" },
      { label: "status", fromMongo: (d) => d.status, pgExpr: "status" },
    ],
  },
  {
    name: "shop_repair_patterns",
    mongoCollection: "shop_repair_patterns",
    pgTable: "shop_repair_patterns",
    mongoKey: (d) => s(d._id),
    pgKeyExpr: "backfill_mongo_id",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "jobTitleNormalized", fromMongo: (d) => d.jobTitleNormalized, pgExpr: "job_title_normalized" },
      { label: "occurrences", fromMongo: (d) => d.occurrences, pgExpr: "occurrences" },
    ],
  },
  {
    name: "support_tickets",
    mongoCollection: "support_tickets",
    pgTable: "support_tickets",
    mongoKey: (d) => s(d.ticketNumber),
    pgKeyExpr: "ticket_number",
    mongoRecencyField: "updatedAt",
    pgRecencyExpr: "updated_at",
    fieldChecks: [
      { label: "status", fromMongo: (d) => d.status, pgExpr: "status" },
      { label: "subject", fromMongo: (d) => d.subject, pgExpr: "subject" },
    ],
  },
];

const REGISTRY: Record<DomainName, EntitySpec[]> = {
  identity: IDENTITY,
  tekmetric: TEKMETRIC,
  protractor: PROTRACTOR,
  shopware: SHOPWARE,
  autoflow: AUTOFLOW,
  autovitals: AUTOVITALS,
  legacy: LEGACY,
};

const ALL_DOMAINS = Object.keys(REGISTRY) as DomainName[];

/* -------------------------------------------------------------------------- */
/* Report shapes                                                              */
/* -------------------------------------------------------------------------- */

type FieldMismatch = {
  key: string;
  field: string;
  mongo: string;
  pg: string;
};

type EntityReport = {
  domain: DomainName;
  entity: string;
  status: "ok" | "no-pg-table" | "error";
  mongoCount: number;
  pgCount: number;
  countDelta: number;
  countDeltaPct: number | null;
  mongoFreshness: string | null;
  pgFreshness: string | null;
  sampledMongoKeys: number;
  missingFromPg: string[];
  missingFromMongo: string[];
  fieldMismatches: FieldMismatch[];
  note?: string;
  error?: string;
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs() {
  const args = process.argv.slice(2);
  const domainRaw = args.find((a) => a.startsWith("--domain="))?.slice(9) ?? "all";
  const sample = Number(args.find((a) => a.startsWith("--sample="))?.slice(9) ?? "10");
  const json = args.includes("--json");
  return { domainRaw, sample: Number.isFinite(sample) && sample > 0 ? Math.floor(sample) : 10, json };
}

/* -------------------------------------------------------------------------- */
/* Per-entity reporter                                                        */
/* -------------------------------------------------------------------------- */

async function reportEntity(
  domain: DomainName,
  spec: EntitySpec,
  sample: number,
): Promise<EntityReport> {
  const base: EntityReport = {
    domain,
    entity: spec.name,
    status: "ok",
    mongoCount: 0,
    pgCount: 0,
    countDelta: 0,
    countDeltaPct: null,
    mongoFreshness: null,
    pgFreshness: null,
    sampledMongoKeys: 0,
    missingFromPg: [],
    missingFromMongo: [],
    fieldMismatches: [],
  };

  if (spec.pgTable === null) {
    return {
      ...base,
      status: "no-pg-table",
      note: "no PG table — backfill mirror spec missing",
    };
  }

  const mongo = await getMongo();
  const pg = getPg();
  const coll = mongo.collection(spec.name);
  const pgTable = spec.pgTable;

  // --- counts (read-only) -------------------------------------------------
  const mongoCount = await coll.countDocuments();
  const pgCountRow = (await pg.execute(
    sql.raw(`SELECT COUNT(*)::int AS c FROM ${pgTable}`),
  )) as unknown as { c: number }[];
  const pgCount = Number(pgCountRow[0]?.c ?? 0);
  const countDelta = pgCount - mongoCount;
  const countDeltaPct =
    mongoCount > 0 ? (Math.abs(countDelta) / mongoCount) * 100 : countDelta === 0 ? 0 : null;

  // --- freshness ----------------------------------------------------------
  const sortField = spec.mongoSortField ?? spec.mongoRecencyField ?? "_id";
  let mongoFreshness: string | null = null;
  if (spec.mongoRecencyField) {
    const newest = await coll
      .find({}, { projection: { [spec.mongoRecencyField]: 1 } })
      .sort({ [spec.mongoRecencyField]: -1 })
      .limit(1)
      .toArray();
    mongoFreshness = s((newest[0] as Doc | undefined)?.[spec.mongoRecencyField]) || null;
  }
  const pgFreshRow = (await pg.execute(
    sql.raw(`SELECT MAX(${spec.pgRecencyExpr}) AS m FROM ${pgTable}`),
  )) as unknown as { m: unknown }[];
  const pgFreshness = toDate(pgFreshRow[0]?.m)?.toISOString() ?? null;

  // --- newest-N Mongo sample → look up in PG ------------------------------
  const mongoSample = (await coll
    .find({})
    .sort({ [sortField]: -1 })
    .limit(sample)
    .toArray()) as Doc[];
  const mongoKeys = mongoSample.map((d) => spec.mongoKey(d));

  // Pull a generous window of newest PG keys + the promoted fields for the
  // shallow spot check. SELECT-only, ORDER BY recency, no hints.
  const fieldSelects = spec.fieldChecks
    .map((f, i) => `${f.pgExpr} AS f${i}`)
    .join(", ");
  const pgSampleSelect =
    `SELECT ${spec.pgKeyExpr} AS k` +
    (fieldSelects ? `, ${fieldSelects}` : "") +
    ` FROM ${pgTable} ORDER BY ${spec.pgRecencyExpr} DESC NULLS LAST LIMIT ${sample * 6}`;
  const pgRows = (await pg.execute(sql.raw(pgSampleSelect))) as unknown as Record<string, unknown>[];

  const pgByKey = new Map<string, Record<string, unknown>>();
  for (const r of pgRows) {
    const k = s(r.k);
    if (!pgByKey.has(k)) pgByKey.set(k, r);
  }

  const missingFromPg: string[] = [];
  const fieldMismatches: FieldMismatch[] = [];
  for (const d of mongoSample) {
    const key = spec.mongoKey(d);
    const row = pgByKey.get(key);
    if (!row) {
      missingFromPg.push(key);
      continue;
    }
    // shallow promoted-field spot check on the matched row
    spec.fieldChecks.forEach((f, i) => {
      const mv = f.fromMongo(d);
      const pv = row[`f${i}`];
      if (!looseEq(mv, pv)) {
        fieldMismatches.push({ key, field: f.label, mongo: s(mv), pg: s(pv) });
      }
    });
  }

  // --- newest-N PG sample → look up in Mongo ------------------------------
  const pgNewest = (await pg.execute(
    sql.raw(
      `SELECT ${spec.pgKeyExpr} AS k FROM ${pgTable} ORDER BY ${spec.pgRecencyExpr} DESC NULLS LAST LIMIT ${sample}`,
    ),
  )) as unknown as { k: unknown }[];
  const pgNewestKeys = pgNewest.map((r) => s(r.k)).filter((k) => k !== "");

  const mongoKeySet = new Set(mongoKeys);
  const missingFromMongo: string[] = [];
  for (const k of pgNewestKeys) {
    if (mongoKeySet.has(k)) continue;
    // Confirm against Mongo directly for keys not in the sampled window.
    const found = await mongoLookup(coll, spec, k);
    if (!found) missingFromMongo.push(k);
  }

  return {
    ...base,
    status: "ok",
    mongoCount,
    pgCount,
    countDelta,
    countDeltaPct,
    mongoFreshness,
    pgFreshness,
    sampledMongoKeys: mongoKeys.length,
    missingFromPg,
    missingFromMongo,
    fieldMismatches,
  };
}

/**
 * Read-only reverse lookup: does Mongo contain a doc matching this PG
 * natural key? We reconstruct the query filter from the key shape rather
 * than mutate anything. Falls back to a `false` (reported as missing)
 * when the key shape isn't reconstructable — conservative but read-only.
 */
async function mongoLookup(
  coll: ReturnType<Awaited<ReturnType<typeof getMongo>>["collection"]>,
  spec: EntitySpec,
  key: string,
): Promise<boolean> {
  // backfill_mongo_id / _id style keys (single ObjectId-as-string).
  if (spec.pgKeyExpr === "backfill_mongo_id") {
    const doc = await coll.findOne({ _id: asObjectIdFilter(key) } as Doc);
    return Boolean(doc);
  }
  // Composite "a:b" keys are matched by scanning the most-recent window and
  // comparing the derived key — avoids guessing field names/types. Bounded.
  const recent = (await coll
    .find({})
    .sort({ [spec.mongoSortField ?? spec.mongoRecencyField ?? "_id"]: -1 })
    .limit(500)
    .toArray()) as Doc[];
  return recent.some((d) => spec.mongoKey(d) === key);
}

/** Build a filter value for `_id`: real ObjectId when it parses, else the raw string. */
function asObjectIdFilter(id: string): unknown {
  try {
    // Lazy require to avoid a hard top-level dependency shape.
    // 24-hex → ObjectId; otherwise use the string as-is.
    if (/^[0-9a-fA-F]{24}$/.test(id)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ObjectId } = require("mongodb") as typeof import("mongodb");
      return new ObjectId(id);
    }
  } catch {
    /* fall through to string */
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

/** countDelta tolerance: fail if abs(delta) exceeds 1% of mongoCount. */
const DELTA_PCT_TOLERANCE = 1;

async function main() {
  const { domainRaw, sample, json } = parseArgs();

  let domains: DomainName[];
  if (domainRaw === "all") {
    domains = ALL_DOMAINS;
  } else if ((ALL_DOMAINS as string[]).includes(domainRaw)) {
    domains = [domainRaw as DomainName];
  } else {
    console.error(
      `Unknown --domain=${domainRaw}. Use one of: ${["all", ...ALL_DOMAINS].join(", ")}`,
    );
    process.exit(2);
    return;
  }

  const reports: EntityReport[] = [];
  for (const domain of domains) {
    for (const spec of REGISTRY[domain]) {
      process.stderr.write(`[cutover-parity] ${domain}/${spec.name}…\n`);
      try {
        reports.push(await reportEntity(domain, spec, sample));
      } catch (err) {
        console.error(`[cutover-parity] ${domain}/${spec.name} FAILED:`, err);
        reports.push({
          domain,
          entity: spec.name,
          status: "error",
          mongoCount: -1,
          pgCount: -1,
          countDelta: 0,
          countDeltaPct: null,
          mongoFreshness: null,
          pgFreshness: null,
          sampledMongoKeys: 0,
          missingFromPg: [],
          missingFromMongo: [],
          fieldMismatches: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // --- human summary table ------------------------------------------------
  printTable(reports);

  // --- optional JSON artifact --------------------------------------------
  if (json) {
    const outDir = join(process.cwd(), "docs", "db-migration-audit-log");
    mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const domainTag = domainRaw;
    const jsonPath = join(outDir, `cutover-parity-${domainTag}-${ts}.json`);
    writeFileSync(
      jsonPath,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), domain: domainTag, sampleSize: sample, reports },
        null,
        2,
      ),
    );
    console.error(`\n[cutover-parity] JSON report written to ${jsonPath}`);
  }

  // --- exit code ----------------------------------------------------------
  const failed = reports.filter((r) => {
    if (r.status === "error") return true;
    if (r.status === "no-pg-table") return false;
    if (r.missingFromPg.length > 0) return true;
    if (r.countDeltaPct === null) return false; // mongoCount 0 & delta 0 handled as 0
    return r.countDeltaPct > DELTA_PCT_TOLERANCE;
  });

  if (failed.length > 0) {
    console.error(
      `\n[cutover-parity] FAIL: ${failed.length} entit${failed.length === 1 ? "y" : "ies"} out of tolerance: ` +
        failed.map((f) => `${f.domain}/${f.entity}`).join(", "),
    );
    process.exit(1);
  }
  console.error("\n[cutover-parity] OK: all entities within tolerance.");
}

function pad(v: string, n: number): string {
  return v.length >= n ? v.slice(0, n) : v + " ".repeat(n - v.length);
}

function printTable(reports: EntityReport[]) {
  const header =
    pad("domain", 11) +
    pad("entity", 28) +
    pad("mongo", 10) +
    pad("pg", 10) +
    pad("delta", 9) +
    pad("delta%", 8) +
    pad("miss→pg", 9) +
    pad("miss→mo", 9) +
    pad("fieldΔ", 8) +
    "status";
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of reports) {
    const deltaPct = r.countDeltaPct === null ? "-" : r.countDeltaPct.toFixed(2);
    console.log(
      pad(r.domain, 11) +
        pad(r.entity, 28) +
        pad(String(r.mongoCount), 10) +
        pad(String(r.pgCount), 10) +
        pad(String(r.countDelta), 9) +
        pad(deltaPct, 8) +
        pad(String(r.missingFromPg.length), 9) +
        pad(String(r.missingFromMongo.length), 9) +
        pad(String(r.fieldMismatches.length), 8) +
        (r.status === "ok" ? "ok" : r.status === "no-pg-table" ? "no-pg-table" : "ERROR"),
    );
    if (r.mongoFreshness || r.pgFreshness) {
      console.log(
        pad("", 11) + `   freshness: mongo=${r.mongoFreshness ?? "-"} pg=${r.pgFreshness ?? "-"}`,
      );
    }
    if (r.note) console.log(pad("", 11) + `   note: ${r.note}`);
    if (r.error) console.log(pad("", 11) + `   error: ${r.error}`);
    if (r.missingFromPg.length) {
      console.log(pad("", 11) + `   missingFromPg: ${r.missingFromPg.slice(0, 5).join(", ")}`);
    }
    if (r.missingFromMongo.length) {
      console.log(pad("", 11) + `   missingFromMongo: ${r.missingFromMongo.slice(0, 5).join(", ")}`);
    }
    if (r.fieldMismatches.length) {
      console.log(
        pad("", 11) +
          `   fieldMismatches: ` +
          r.fieldMismatches
            .slice(0, 5)
            .map((m) => `${m.key}[${m.field}] mongo=${m.mongo} pg=${m.pg}`)
            .join("; "),
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
