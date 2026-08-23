#!/usr/bin/env tsx
/**
 * Wave 1 Mongo → Postgres backfill (task #342).
 *
 * Streams every document from each of the 15 Wave 1 Mongo collections and
 * upserts it into the matching Postgres table. Safe to re-run: every entity
 * targets a primary key / unique constraint and uses ON CONFLICT … DO UPDATE.
 *
 * Usage:
 *   pnpm tsx scripts/wave1-mongo-to-pg-backfill.ts
 *   pnpm tsx scripts/wave1-mongo-to-pg-backfill.ts --only=knowledge_articles,viewed_vins
 *   pnpm tsx scripts/wave1-mongo-to-pg-backfill.ts --batch=2000
 *
 * The migration follows the per-entity contract from
 * `docs/db-migration-map.md` §3.7. Soak windows + Mongo-write removal are
 * deferred operational steps (W1.5).
 */
import "dotenv/config";
import { ObjectId, type Document } from "mongodb";
import { getDb as getMongo } from "@/lib/mongo";
import { getDb as getPg } from "@/lib/db/drizzle";
import { sql } from "drizzle-orm";
import {
  pgUpsertDataOneCache,
  pgUpsertDataOneOe,
  pgBackfillPartCrossRef,
  pgInsertArticle,
  pgInsertAnnouncement,
  pgBackfillIngestionError,
  pgUpsertSmsHistoricalWorkOrder,
} from "@/lib/db/repositories/wave1";

type EntityName =
  | "ratelimits"
  | "viewed_vins"
  | "sync_metrics"
  | "ingestion_errors"
  | "extension_analytics"
  | "data_quality_reports"
  | "system_announcements"
  | "knowledge_articles"
  | "dataone_cache"
  | "dataone_oe"
  | "lkp_ymm_maintenance_interval"
  | "def_maintenance_event"
  | "dataone_lkp_squish_maintenance"
  | "part_cross_ref"
  | "sms_historical_work_orders";

const ALL_ENTITIES: EntityName[] = [
  "ratelimits",
  "viewed_vins",
  "sync_metrics",
  "ingestion_errors",
  "extension_analytics",
  "data_quality_reports",
  "system_announcements",
  "knowledge_articles",
  "dataone_cache",
  "dataone_oe",
  "lkp_ymm_maintenance_interval",
  "def_maintenance_event",
  "dataone_lkp_squish_maintenance",
  "part_cross_ref",
  "sms_historical_work_orders",
];

function parseArgs() {
  const out = { only: ALL_ENTITIES, batch: 1000 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--only=")) {
      out.only = a.slice("--only=".length).split(",").map((s) => s.trim()) as EntityName[];
    } else if (a.startsWith("--batch=")) {
      out.batch = Number(a.slice("--batch=".length)) || 1000;
    }
  }
  return out;
}

function objIdToHex(v: unknown): string {
  if (v instanceof ObjectId) return v.toHexString();
  if (typeof v === "string") return v;
  return new ObjectId().toHexString();
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
function toDateOrNow(v: unknown): Date {
  return toDate(v) ?? new Date();
}
function toIso(v: unknown): string {
  return toDateOrNow(v).toISOString();
}
function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
function toStr(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}
function toBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}
function toArr<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Generic Mongo document with arbitrary fields. Per-collection migrators
 * narrow this with explicit field accessors (toStr/toNum/etc) so we never
 * propagate `any` into the SQL bindings. */
type MongoDoc = Document & Record<string, unknown>;

async function streamCollection<T extends MongoDoc>(
  name: string,
  batch: number,
  handler: (docs: T[]) => Promise<void>,
) {
  const db = await getMongo();
  // Stable order by _id so chunked re-runs (WAVE1_SKIP) resume deterministically.
  const skip = Number(process.env.WAVE1_SKIP ?? 0);
  const cursor = db
    .collection<T>(name)
    .find({}, { noCursorTimeout: true })
    .sort({ _id: 1 })
    .skip(skip);
  let buf: T[] = [];
  let total = skip;
  for await (const doc of cursor) {
    buf.push(doc as T);
    if (buf.length >= batch) {
      await handler(buf);
      total += buf.length;
      console.log(`  …${name}: ${total} migrated`);
      buf = [];
    }
  }
  if (buf.length) {
    await handler(buf);
    total += buf.length;
  }
  console.log(`  ${name}: done (${total} docs)`);
}

interface MongoRatelimitDoc extends MongoDoc {
  bucketKey?: unknown;
  count?: unknown;
  windowSeconds?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
}
async function migrateRatelimits(batch: number) {
  const pg = getPg();
  await streamCollection<MongoRatelimitDoc>("ratelimits", batch, async (docs) => {
    for (const d of docs) {
      const bucketKey = toStr(d.bucketKey);
      if (!bucketKey) continue;
      await pg.execute(sql`
        INSERT INTO ratelimits (bucket_key, count, window_seconds, created_at, expires_at)
        VALUES (${bucketKey}, ${toNum(d.count) ?? 0}, ${toNum(d.windowSeconds) ?? 60},
                ${toIso(d.createdAt)},
                ${toDate(d.expiresAt)?.toISOString() ?? new Date(Date.now() + 60_000).toISOString()})
        ON CONFLICT (bucket_key) DO UPDATE SET
          count = EXCLUDED.count,
          window_seconds = EXCLUDED.window_seconds,
          expires_at = EXCLUDED.expires_at
      `);
    }
  });
}

interface MongoViewedVinDoc extends MongoDoc {
  shopId?: unknown;
  vin?: unknown;
  roNumber?: unknown;
  firstViewedAt?: unknown;
  lastViewedAt?: unknown;
  viewCount?: unknown;
}
async function migrateViewedVins(batch: number) {
  const pg = getPg();
  await streamCollection<MongoViewedVinDoc>("viewed_vins", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      const vin = toStr(d.vin);
      if (shopId == null || !vin) continue;
      const ro = toStr(d.roNumber);
      const roKey = ro ?? "";
      const firstViewed = toDate(d.firstViewedAt) ?? new Date();
      const lastViewed = toDate(d.lastViewedAt) ?? firstViewed;
      await pg.execute(sql`
        INSERT INTO viewed_vins
          (shop_id, vin, ro_number, ro_number_key, first_viewed_at, last_viewed_at, view_count)
        VALUES
          (${shopId}, ${vin.toUpperCase()}, ${ro}, ${roKey},
           ${firstViewed.toISOString()}, ${lastViewed.toISOString()},
           ${toNum(d.viewCount) ?? 1})
        ON CONFLICT (shop_id, vin, ro_number_key) DO UPDATE SET
          last_viewed_at = EXCLUDED.last_viewed_at,
          view_count = GREATEST(viewed_vins.view_count, EXCLUDED.view_count)
      `);
    }
  });
}

interface MongoSyncMetricDoc extends MongoDoc {
  workerType?: unknown;
  shopId?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  durationMs?: unknown;
  success?: unknown;
  error?: unknown;
  recordsProcessed?: unknown;
  recordsSkipped?: unknown;
  retryCount?: unknown;
}
async function migrateSyncMetrics(batch: number) {
  const pg = getPg();
  await streamCollection<MongoSyncMetricDoc>("sync_metrics", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const workerType = toStr(d.workerType);
      if (!workerType) continue;
      await pg.execute(sql`
        INSERT INTO sync_metrics
          (backfill_mongo_id, worker_type, shop_id, started_at, completed_at,
           duration_ms, success, error, records_processed, records_skipped, retry_count)
        VALUES
          (${mongoId}, ${workerType}, ${toNum(d.shopId)},
           ${toIso(d.startedAt)},
           ${toDate(d.completedAt)?.toISOString() ?? null},
           ${toNum(d.durationMs)}, ${toBool(d.success)}, ${toStr(d.error)},
           ${toNum(d.recordsProcessed)}, ${toNum(d.recordsSkipped)}, ${toNum(d.retryCount)})
        ON CONFLICT (backfill_mongo_id) DO UPDATE SET
          worker_type = EXCLUDED.worker_type,
          shop_id = EXCLUDED.shop_id,
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at,
          duration_ms = EXCLUDED.duration_ms,
          success = EXCLUDED.success,
          error = EXCLUDED.error,
          records_processed = EXCLUDED.records_processed,
          records_skipped = EXCLUDED.records_skipped,
          retry_count = EXCLUDED.retry_count
      `);
    }
  });
}

interface MongoIngestionErrorDoc extends MongoDoc {
  workerType?: unknown;
  entityType?: unknown;
  entityId?: unknown;
  shopId?: unknown;
  error?: unknown;
  rawData?: unknown;
  retryCount?: unknown;
  resolved?: unknown;
  resolvedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}
async function migrateIngestionErrors(batch: number) {
  await streamCollection<MongoIngestionErrorDoc>("ingestion_errors", batch, async (docs) => {
    for (const d of docs) {
      const workerType = toStr(d.workerType);
      const entityType = toStr(d.entityType);
      const entityId = toStr(d.entityId);
      const errorMsg = toStr(d.error);
      if (!workerType || !entityType || !entityId || errorMsg == null) continue;
      // Preserve source state — the live write path uses
      // pgUpsertIngestionError which increments retryCount and resets
      // resolved=false; backfill must not do that.
      await pgBackfillIngestionError({
        workerType,
        entityType,
        entityId,
        shopId: toNum(d.shopId),
        error: errorMsg,
        rawData: d.rawData ?? null,
        retryCount: toNum(d.retryCount) ?? 0,
        resolved: toBool(d.resolved),
        resolvedAt: toDate(d.resolvedAt),
        createdAt: toDate(d.createdAt) ?? undefined,
        updatedAt: toDate(d.updatedAt) ?? undefined,
      });
    }
  });
}

interface MongoExtensionAnalyticsDoc extends MongoDoc {
  eventType?: unknown;
  shopId?: unknown;
  userId?: unknown;
  enterpriseId?: unknown;
  vin?: unknown;
  vehicleYear?: unknown;
  vehicleMake?: unknown;
  vehicleModel?: unknown;
  jobTitle?: unknown;
  jobSource?: unknown;
  repairOrderId?: unknown;
  laborAmount?: unknown;
  partsAmount?: unknown;
  totalAmount?: unknown;
  timestamp?: unknown;
}
async function migrateExtensionAnalytics(batch: number) {
  const pg = getPg();
  await streamCollection<MongoExtensionAnalyticsDoc>("extension_analytics", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO extension_analytics
          (backfill_mongo_id, event_type, shop_id, user_id, enterprise_id, vin,
           vehicle_year, vehicle_make, vehicle_model, job_title, job_source,
           repair_order_id, labor_amount, parts_amount, total_amount, timestamp)
        VALUES
          (${mongoId}, ${toStr(d.eventType) ?? "push_to_ro"}, ${shopId},
           ${toStr(d.userId)}, ${toStr(d.enterpriseId)}, ${toStr(d.vin)},
           ${toNum(d.vehicleYear)}, ${toStr(d.vehicleMake)}, ${toStr(d.vehicleModel)},
           ${toStr(d.jobTitle)}, ${toStr(d.jobSource)}, ${toStr(d.repairOrderId)},
           ${toNum(d.laborAmount)}, ${toNum(d.partsAmount)}, ${toNum(d.totalAmount)},
           ${toIso(d.timestamp)})
        ON CONFLICT (backfill_mongo_id) DO UPDATE SET
          event_type = EXCLUDED.event_type,
          shop_id = EXCLUDED.shop_id,
          user_id = EXCLUDED.user_id,
          enterprise_id = EXCLUDED.enterprise_id,
          vin = EXCLUDED.vin,
          vehicle_year = EXCLUDED.vehicle_year,
          vehicle_make = EXCLUDED.vehicle_make,
          vehicle_model = EXCLUDED.vehicle_model,
          job_title = EXCLUDED.job_title,
          job_source = EXCLUDED.job_source,
          repair_order_id = EXCLUDED.repair_order_id,
          labor_amount = EXCLUDED.labor_amount,
          parts_amount = EXCLUDED.parts_amount,
          total_amount = EXCLUDED.total_amount,
          timestamp = EXCLUDED.timestamp
      `);
    }
  });
}

interface MongoDataQualityReportDoc extends MongoDoc {
  shopId?: unknown;
  shopName?: unknown;
  report?: unknown;
  cleanupResult?: unknown;
  runType?: unknown;
  createdAt?: unknown;
}
async function migrateDataQualityReports(batch: number) {
  const pg = getPg();
  await streamCollection<MongoDataQualityReportDoc>("data_quality_reports", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO data_quality_reports
          (backfill_mongo_id, shop_id, shop_name, report, cleanup_result, run_type, created_at)
        VALUES
          (${mongoId}, ${shopId}, ${toStr(d.shopName)},
           ${JSON.stringify(d.report ?? {})}::jsonb,
           ${d.cleanupResult ? JSON.stringify(d.cleanupResult) : null}::jsonb,
           ${toStr(d.runType) ?? "automated"},
           ${toIso(d.createdAt)})
        ON CONFLICT (backfill_mongo_id) DO UPDATE SET
          shop_id = EXCLUDED.shop_id,
          shop_name = EXCLUDED.shop_name,
          report = EXCLUDED.report,
          cleanup_result = EXCLUDED.cleanup_result,
          run_type = EXCLUDED.run_type
      `);
    }
  });
}

interface MongoAnnouncementDoc extends MongoDoc {
  title?: unknown;
  message?: unknown;
  priority?: unknown;
  target?: unknown;
  deliveryChannels?: unknown;
  status?: unknown;
  createdBy?: unknown;
  createdAt?: unknown;
  sentAt?: unknown;
  expiresAt?: unknown;
  stats?: unknown;
}
type AnnouncementPriority = "info" | "warning" | "critical";
type AnnouncementStatus = "draft" | "sent" | "scheduled";
type AnnouncementTargetType = "all" | "shops" | "roles" | "sms_integration";

async function migrateAnnouncements(batch: number) {
  await streamCollection<MongoAnnouncementDoc>("system_announcements", batch, async (docs) => {
    for (const d of docs) {
      const title = toStr(d.title);
      const message = toStr(d.message);
      const priority = toStr(d.priority) as AnnouncementPriority | null;
      const status = toStr(d.status) as AnnouncementStatus | null;
      const createdBy = toStr(d.createdBy);
      if (!title || message == null || !priority || !status || !createdBy) continue;
      const target = (d.target ?? { type: "all" }) as { type: AnnouncementTargetType };
      const deliveryChannels = (d.deliveryChannels ?? { inApp: true, email: false }) as {
        inApp: boolean;
        email: boolean;
      };
      const stats = (d.stats ?? null) as { totalRecipients: number; emailsSent: number; inAppSent: number } | null;
      await pgInsertAnnouncement({
        id: objIdToHex(d._id),
        title,
        message,
        priority,
        target,
        deliveryChannels,
        status,
        createdBy,
        createdAt: toDateOrNow(d.createdAt),
        sentAt: toDate(d.sentAt),
        expiresAt: toDate(d.expiresAt),
        stats,
      });
    }
  });
}

interface MongoKnowledgeArticleDoc extends MongoDoc {
  title?: unknown;
  problem?: unknown;
  solution?: unknown;
  category?: unknown;
  tags?: unknown;
  sourceTicketId?: unknown;
  embedding?: unknown;
  createdBy?: unknown;
  viewCount?: unknown;
  helpfulCount?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}
async function migrateKnowledgeArticles(batch: number) {
  await streamCollection<MongoKnowledgeArticleDoc>("knowledge_articles", batch, async (docs) => {
    for (const d of docs) {
      const title = toStr(d.title);
      const problem = toStr(d.problem);
      const solution = toStr(d.solution);
      const category = toStr(d.category);
      const createdBy = toStr(d.createdBy);
      if (!title || !problem || !solution || !category || !createdBy) continue;
      const embedding = Array.isArray(d.embedding) ? (d.embedding as number[]) : null;
      await pgInsertArticle({
        id: objIdToHex(d._id),
        title,
        problem,
        solution,
        category,
        tags: toArr<string>(d.tags),
        sourceTicketId: toStr(d.sourceTicketId),
        embedding,
        createdBy,
        viewCount: toNum(d.viewCount) ?? 0,
        helpfulCount: toNum(d.helpfulCount) ?? 0,
        createdAt: toDateOrNow(d.createdAt),
        updatedAt: toDateOrNow(d.updatedAt),
      });
    }
  });
}

interface MongoDataOneCacheDoc extends MongoDoc {
  squish?: unknown;
  vin?: unknown;
  data?: unknown;
  vehicle?: unknown;
  fetchedAt?: unknown;
  expiresAt?: unknown;
  source?: unknown;
}
async function migrateDataOneCache(batch: number) {
  await streamCollection<MongoDataOneCacheDoc>("dataone_cache", batch, async (docs) => {
    for (const d of docs) {
      const squish = toStr(d.squish);
      if (!squish) continue;
      await pgUpsertDataOneCache({
        squish,
        vin: toStr(d.vin) ?? squish,
        data: (d.data ?? {}) as Record<string, unknown>,
        vehicle: (d.vehicle ?? null) as Record<string, unknown> | null,
        fetchedAt: toDateOrNow(d.fetchedAt),
        expiresAt: toDate(d.expiresAt) ?? new Date(Date.now() + 86_400_000),
        source: toStr(d.source) ?? "cache",
      });
    }
  });
}

interface MongoDataOneOeDoc extends MongoDoc {
  shopId?: unknown;
  vin?: unknown;
  items?: unknown;
  mileageUsed?: unknown;
  ok?: unknown;
  error?: unknown;
  raw?: unknown;
  source?: unknown;
  fetchedAt?: unknown;
}
async function migrateDataOneOe(batch: number) {
  await streamCollection<MongoDataOneOeDoc>("dataone_oe", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      const vin = toStr(d.vin);
      if (shopId == null || !vin) continue;
      await pgUpsertDataOneOe({
        shopId,
        vin,
        items: (d.items ?? null) as unknown,
        mileageUsed: toNum(d.mileageUsed),
        ok: toBool(d.ok),
        error: toStr(d.error),
        raw: (d.raw ?? null) as unknown,
        source: toStr(d.source) ?? "dataone",
        fetchedAt: toDateOrNow(d.fetchedAt),
      });
    }
  });
}

interface MongoLkpYmmDoc extends MongoDoc {
  Year?: unknown;
  Make?: unknown;
  Model?: unknown;
  Trim?: unknown;
  EventCode?: unknown;
  Description?: unknown;
  MileageInterval?: unknown;
  TimeIntervalMonths?: unknown;
  FirstDueMiles?: unknown;
  FirstDueMonths?: unknown;
  OemNotes?: unknown;
}
async function migrateLkpYmm(batch: number) {
  const pg = getPg();
  await streamCollection<MongoLkpYmmDoc>("lkp_ymm_maintenance_interval", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      await pg.execute(sql`
        INSERT INTO lkp_ymm_maintenance_interval
          (backfill_mongo_id, year, make, model, trim, event_code, description,
           mileage_interval, time_interval_months, first_due_miles, first_due_months,
           oem_notes, raw)
        VALUES
          (${mongoId}, ${toNum(d.Year)}, ${toStr(d.Make)}, ${toStr(d.Model)}, ${toStr(d.Trim)},
           ${toStr(d.EventCode)}, ${toStr(d.Description)},
           ${toNum(d.MileageInterval)}, ${toNum(d.TimeIntervalMonths)},
           ${toNum(d.FirstDueMiles)}, ${toNum(d.FirstDueMonths)},
           ${toStr(d.OemNotes)}, ${JSON.stringify(d)}::jsonb)
        ON CONFLICT (backfill_mongo_id) DO UPDATE SET
          year = EXCLUDED.year,
          make = EXCLUDED.make,
          model = EXCLUDED.model,
          trim = EXCLUDED.trim,
          event_code = EXCLUDED.event_code,
          description = EXCLUDED.description,
          mileage_interval = EXCLUDED.mileage_interval,
          time_interval_months = EXCLUDED.time_interval_months,
          first_due_miles = EXCLUDED.first_due_miles,
          first_due_months = EXCLUDED.first_due_months,
          oem_notes = EXCLUDED.oem_notes,
          raw = EXCLUDED.raw
      `);
    }
  });
}

interface MongoDefMaintenanceDoc extends MongoDoc {
  EventCode?: unknown;
  Description?: unknown;
}
async function migrateDefMaintenance(batch: number) {
  const pg = getPg();
  await streamCollection<MongoDefMaintenanceDoc>("def_maintenance_event", batch, async (docs) => {
    for (const d of docs) {
      const eventCode = toStr(d.EventCode);
      if (!eventCode) continue;
      await pg.execute(sql`
        INSERT INTO def_maintenance_event (event_code, description, raw)
        VALUES (${eventCode}, ${toStr(d.Description)}, ${JSON.stringify(d)}::jsonb)
        ON CONFLICT (event_code) DO UPDATE SET
          description = EXCLUDED.description,
          raw = EXCLUDED.raw
      `);
    }
  });
}

interface MongoLkpSquishDoc extends MongoDoc {
  squish?: unknown;
  vin_maintenance_id?: unknown;
  maintenance_id?: unknown;
}
async function migrateLkpSquishMaintenance(batch: number) {
  const pg = getPg();
  await streamCollection<MongoLkpSquishDoc>("dataone_lkp_squish_maintenance", batch, async (docs) => {
    for (const d of docs) {
      const squish = toStr(d.squish);
      const vinMaintId = toNum(d.vin_maintenance_id);
      const maintId = toNum(d.maintenance_id);
      if (!squish || vinMaintId == null || maintId == null) continue;
      await pg.execute(sql`
        INSERT INTO dataone_lkp_squish_maintenance (squish, vin_maintenance_id, maintenance_id)
        VALUES (${squish}, ${vinMaintId}, ${maintId})
        ON CONFLICT (squish, vin_maintenance_id, maintenance_id) DO NOTHING
      `);
    }
  });
}

interface MongoPartCrossRefDoc extends MongoDoc {
  shopId?: unknown;
  normalizedPartNumber?: unknown;
  partNumber?: unknown;
  description?: unknown;
  manufacturer?: unknown;
  usedOn?: unknown;
  crossReferences?: unknown;
  workOrderIds?: unknown;
  usageCount?: unknown;
  lastUsedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}
async function migratePartCrossRef(batch: number) {
  await streamCollection<MongoPartCrossRefDoc>("part_cross_ref", batch, async (docs) => {
    // Backfill helper SETS usageCount and REPLACES arrays so re-runs
    // don't inflate counts. The live-write path (lib/job-index.ts)
    // uses pgUpsertPartCrossRef which merges arrays and increments.
    // Issue inserts in parallel within each batch to keep the 100-shape
    // postgres-js pool busy (~10x throughput vs sequential awaits).
    const CONCURRENCY = 32;
    const queue: MongoPartCrossRefDoc[] = [...docs];
    async function worker() {
      while (queue.length) {
        const d = queue.shift();
        if (!d) return;
        const shopId = toNum(d.shopId);
        const normalizedPartNumber = toStr(d.normalizedPartNumber);
        const partNumber = toStr(d.partNumber);
        if (shopId == null || !normalizedPartNumber || !partNumber) continue;
        await pgBackfillPartCrossRef({
          shopId,
          normalizedPartNumber,
          partNumber,
          description: toStr(d.description),
          manufacturer: toStr(d.manufacturer),
          usedOn: toArr(d.usedOn),
          crossReferences: toArr(d.crossReferences),
          workOrderIds: toArr<unknown>(d.workOrderIds).map((x) => String(x)),
          usageCount: toNum(d.usageCount) ?? 0,
          lastUsedAt: toDate(d.lastUsedAt),
          createdAt: toDate(d.createdAt) ?? undefined,
          updatedAt: toDate(d.updatedAt) ?? undefined,
        });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  });
}

interface MongoSmsHistoricalDoc extends MongoDoc {
  shopId?: unknown;
  sourceSystem?: unknown;
  workOrderId?: unknown;
  workOrderNumber?: unknown;
  closedAt?: unknown;
  rawData?: unknown;
}
async function migrateSmsHistorical(batch: number) {
  await streamCollection<MongoSmsHistoricalDoc>("sms_historical_work_orders", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      const sourceSystem = toStr(d.sourceSystem);
      const workOrderId = toStr(d.workOrderId);
      if (shopId == null || !sourceSystem || !workOrderId) continue;
      await pgUpsertSmsHistoricalWorkOrder({
        shopId,
        sourceSystem,
        workOrderId,
        workOrderNumber: toStr(d.workOrderNumber),
        closedAt: toDate(d.closedAt),
        data: (d.rawData ?? d) as Record<string, unknown>,
      });
    }
  });
}

const RUNNERS: Record<EntityName, (b: number) => Promise<void>> = {
  ratelimits: migrateRatelimits,
  viewed_vins: migrateViewedVins,
  sync_metrics: migrateSyncMetrics,
  ingestion_errors: migrateIngestionErrors,
  extension_analytics: migrateExtensionAnalytics,
  data_quality_reports: migrateDataQualityReports,
  system_announcements: migrateAnnouncements,
  knowledge_articles: migrateKnowledgeArticles,
  dataone_cache: migrateDataOneCache,
  dataone_oe: migrateDataOneOe,
  lkp_ymm_maintenance_interval: migrateLkpYmm,
  def_maintenance_event: migrateDefMaintenance,
  dataone_lkp_squish_maintenance: migrateLkpSquishMaintenance,
  part_cross_ref: migratePartCrossRef,
  sms_historical_work_orders: migrateSmsHistorical,
};

async function main() {
  const args = parseArgs();
  console.log(`[wave1-backfill] entities=${args.only.join(",")} batch=${args.batch}`);
  for (const ent of args.only) {
    const fn = RUNNERS[ent as EntityName];
    if (!fn) {
      console.warn(`[wave1-backfill] Unknown entity: ${ent}`);
      continue;
    }
    console.log(`\n=== ${ent} ===`);
    try {
      await fn(args.batch);
    } catch (err) {
      console.error(`[wave1-backfill] ${ent} failed:`, err);
    }
  }
  console.log("\n[wave1-backfill] done");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
