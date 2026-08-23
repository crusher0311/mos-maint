#!/usr/bin/env tsx
/**
 * Wave 2 Mongo → Postgres backfill (task #343).
 *
 * Streams every document from each Wave 2 Mongo collection into the
 * matching Postgres table defined in `lib/db/schema/wave2.ts`. Mirrors
 * the W1 script (`scripts/wave1-mongo-to-pg-backfill.ts`) so the
 * operational story is the same: idempotent on re-run, scoped via
 * `--only=<csv>`, batched via `--batch=<n>`. Resume mid-collection by
 * setting `WAVE2_SKIP=<n>` (skip first N docs of every entity in the
 * `--only` set).
 *
 * **Schema-only PR.** This script is the destination-side groundwork
 * for the per-sub-group cutover tasks. It is NOT wired into any cron
 * or CI; nothing in production calls it yet. Each sub-group cutover
 * task is responsible for running it (typically `--only=<entity>`)
 * before flipping reads to Postgres.
 *
 * Sub-groups (run independently):
 *   ai-caches:        ai_analysis_cache, maintenance_analysis_cache,
 *                     ai_budget_alerts, vhi_analysis_log,
 *                     concern_conversations, report_approved_items,
 *                     remedied_deferred_work, shop_repair_patterns,
 *                     oem_schedules, oem_carfax_mappings
 *   external-api:     external_api_appointments, external_api_keytags,
 *                     external_api_stickers, sticker_generations,
 *                     sticker_qr_scans, shop_media
 *   audit-notif:      audit_logs, admin_audit_logs, notifications,
 *                     dashboard_updates, support_chat_sessions
 *   queues-locks:     enrichment_queue, extension_prefetch_locks,
 *                     auto_booking_queue
 *                     (tekmetric_drain_lock → pg_try_advisory_lock,
 *                      no backfill needed)
 *   tekmetric-op:     tekmetric_backfill_progress,
 *                     tekmetric_backfill_health_alerts,
 *                     tekmetric_permfailed_ro_alerts,
 *                     tekmetric_skipped_ro_archive,
 *                     tekmetric_catchup_runs,
 *                     tekmetric_mileage_backfill_progress,
 *                     tekmetric_webhook_logs,
 *                     tekmetric_webhook_subscriptions,
 *                     tekmetric_webhook_health_alerts
 *   misc:             platform_plans
 *
 * Usage:
 *   pnpm tsx scripts/wave2-mongo-to-pg-backfill.ts
 *   pnpm tsx scripts/wave2-mongo-to-pg-backfill.ts --only=ai_analysis_cache,maintenance_analysis_cache
 *   pnpm tsx scripts/wave2-mongo-to-pg-backfill.ts --batch=2000
 */
import "dotenv/config";
import { ObjectId, type Document } from "mongodb";
import { sql } from "drizzle-orm";
import { getDb as getMongo } from "@/lib/mongo";
import { getDb as getPg } from "@/lib/db/drizzle";

type EntityName =
  // ai-caches
  | "ai_analysis_cache"
  | "maintenance_analysis_cache"
  | "ai_budget_alerts"
  | "vhi_analysis_log"
  | "concern_conversations"
  | "report_approved_items"
  | "remedied_deferred_work"
  | "shop_repair_patterns"
  | "oem_schedules"
  | "oem_carfax_mappings"
  // external-api
  | "external_api_appointments"
  | "external_api_keytags"
  | "external_api_stickers"
  | "sticker_generations"
  | "sticker_qr_scans"
  | "shop_media"
  // audit-notif
  | "audit_logs"
  | "admin_audit_logs"
  | "notifications"
  | "dashboard_updates"
  | "support_chat_sessions"
  // queues-locks
  | "enrichment_queue"
  | "extension_prefetch_locks"
  | "auto_booking_queue"
  // tekmetric-op
  | "tekmetric_backfill_progress"
  | "tekmetric_backfill_health_alerts"
  | "tekmetric_permfailed_ro_alerts"
  | "tekmetric_skipped_ro_archive"
  | "tekmetric_catchup_runs"
  | "tekmetric_mileage_backfill_progress"
  | "tekmetric_webhook_logs"
  | "tekmetric_webhook_subscriptions"
  | "tekmetric_webhook_health_alerts"
  // misc
  | "platform_plans";

const ALL_ENTITIES: EntityName[] = [
  "ai_analysis_cache",
  "maintenance_analysis_cache",
  "ai_budget_alerts",
  "vhi_analysis_log",
  "concern_conversations",
  "report_approved_items",
  "remedied_deferred_work",
  "shop_repair_patterns",
  "oem_schedules",
  "oem_carfax_mappings",
  "external_api_appointments",
  "external_api_keytags",
  "external_api_stickers",
  "sticker_generations",
  "sticker_qr_scans",
  "shop_media",
  "audit_logs",
  "admin_audit_logs",
  "notifications",
  "dashboard_updates",
  "support_chat_sessions",
  "enrichment_queue",
  "extension_prefetch_locks",
  "auto_booking_queue",
  "tekmetric_backfill_progress",
  "tekmetric_backfill_health_alerts",
  "tekmetric_permfailed_ro_alerts",
  "tekmetric_skipped_ro_archive",
  "tekmetric_catchup_runs",
  "tekmetric_mileage_backfill_progress",
  "tekmetric_webhook_logs",
  "tekmetric_webhook_subscriptions",
  "tekmetric_webhook_health_alerts",
  "platform_plans",
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

/* -------------------------------------------------------------------------- */
/* Coercion helpers (same shape as wave1 script).                             */
/* -------------------------------------------------------------------------- */

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
function toIsoOrNull(v: unknown): string | null {
  return toDate(v)?.toISOString() ?? null;
}
function toIsoOrNow(v: unknown): string {
  return (toDate(v) ?? new Date()).toISOString();
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
function toBoolOrNull(v: unknown): boolean | null {
  if (v === true || v === "true" || v === 1) return true;
  if (v === false || v === "false" || v === 0) return false;
  return null;
}
function toBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}
function toJson(v: unknown): unknown {
  return v ?? null;
}

type MongoDoc = Document & Record<string, unknown>;

async function streamCollection<T extends MongoDoc>(
  name: string,
  batch: number,
  handler: (docs: T[]) => Promise<void>,
) {
  const db = await getMongo();
  const skip = Number(process.env.WAVE2_SKIP ?? 0);
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

/* ========================================================================== */
/* AI / recommendation caches                                                 */
/* ========================================================================== */

async function migrateAiAnalysisCache(batch: number) {
  const pg = getPg();
  await streamCollection("ai_analysis_cache", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      const vin = toStr(d.vin);
      if (shopId == null || !vin) continue;
      const { shopId: _s, vin: _v, _id, ...rest } = d as Record<string, unknown>;
      await pg.execute(sql`
        INSERT INTO ai_analysis_cache (shop_id, vin, payload, schema_version, created_at, updated_at)
        VALUES (${shopId}, ${vin.toUpperCase()}, ${JSON.stringify(rest)}::jsonb,
                ${toNum(d.schemaVersion)},
                ${toIsoOrNow(d.createdAt)}, ${toIsoOrNow(d.updatedAt ?? d.createdAt)})
        ON CONFLICT (shop_id, vin) DO UPDATE SET
          payload = EXCLUDED.payload,
          schema_version = EXCLUDED.schema_version,
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

async function migrateMaintenanceAnalysisCache(batch: number) {
  const pg = getPg();
  await streamCollection("maintenance_analysis_cache", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      const vin = toStr(d.vin);
      if (shopId == null || !vin) continue;
      await pg.execute(sql`
        INSERT INTO maintenance_analysis_cache
          (shop_id, vin, recommendations, show_inspect_items, mileage_at_analysis,
           source, schema_version, analyzed_at, raw)
        VALUES
          (${shopId}, ${vin.toUpperCase()},
           ${JSON.stringify(toJson(d.recommendations) ?? [])}::jsonb,
           ${d.showInspectItems == null ? null : JSON.stringify(d.showInspectItems)}::jsonb,
           ${toNum(d.mileageAtAnalysis)}, ${toStr(d.source)}, ${toNum(d.schemaVersion)},
           ${toIsoOrNow(d.analyzedAt)}, ${JSON.stringify(d)}::jsonb)
        ON CONFLICT (shop_id, vin) DO UPDATE SET
          recommendations = EXCLUDED.recommendations,
          show_inspect_items = EXCLUDED.show_inspect_items,
          mileage_at_analysis = EXCLUDED.mileage_at_analysis,
          source = EXCLUDED.source,
          schema_version = EXCLUDED.schema_version,
          analyzed_at = EXCLUDED.analyzed_at,
          raw = EXCLUDED.raw
      `);
    }
  });
}

async function migrateAiBudgetAlerts(batch: number) {
  const pg = getPg();
  await streamCollection("ai_budget_alerts", batch, async (docs) => {
    for (const d of docs) {
      const alertKey = toStr(d.alertKey);
      const shopId = toNum(d.shopId);
      const dayKey = toStr(d.dayKey);
      if (!alertKey || shopId == null || !dayKey) continue;
      await pg.execute(sql`
        INSERT INTO ai_budget_alerts
          (alert_key, shop_id, day_key, plan, threshold, used_at_alert, "limit", created_at)
        VALUES
          (${alertKey}, ${shopId}, ${dayKey}, ${toStr(d.plan) ?? "unknown"},
           ${toNum(d.threshold) ?? 0.8}, ${toNum(d.usedAtAlert) ?? 0},
           ${toNum(d.limit) ?? 0}, ${toIsoOrNow(d.createdAt)})
        ON CONFLICT (alert_key) DO NOTHING
      `);
    }
  });
}

async function migrateVhiAnalysisLog(batch: number) {
  const pg = getPg();
  await streamCollection("vhi_analysis_log", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const vin = toStr(d.vin);
      if (!vin) continue;
      await pg.execute(sql`
        INSERT INTO vhi_analysis_log
          (backfill_mongo_id, vin, shop_id, sms, sms_shop_id, provider, ro_number,
           mileage, score, tier, summary, authorized_jobs, triggered_by, analyzed_at)
        VALUES
          (${mongoId}, ${vin.toUpperCase()}, ${toNum(d.shopId)}, ${toStr(d.sms)},
           ${toStr(d.smsShopId)}, ${toStr(d.provider)}, ${toStr(d.roNumber)},
           ${toNum(d.mileage)}, ${toNum(d.score)}, ${toStr(d.tier)},
           ${toStr(d.summary)},
           ${JSON.stringify(toJson(d.authorizedJobs) ?? [])}::jsonb,
           ${toStr(d.triggeredBy)}, ${toIsoOrNow(d.analyzedAt)})
        ON CONFLICT (backfill_mongo_id) DO UPDATE SET
          vin = EXCLUDED.vin,
          shop_id = EXCLUDED.shop_id,
          score = EXCLUDED.score,
          tier = EXCLUDED.tier,
          summary = EXCLUDED.summary,
          authorized_jobs = EXCLUDED.authorized_jobs
      `);
    }
  });
}

async function migrateConcernConversations(batch: number) {
  const pg = getPg();
  await streamCollection("concern_conversations", batch, async (docs) => {
    for (const d of docs) {
      const id = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO concern_conversations
          (id, shop_id, mos_shop_id, vin, user_email, concern, symptom_category,
           questions, answered_questions, round_results, review,
           injected_to_protractor, created_at, updated_at)
        VALUES
          (${id}, ${shopId}, ${toNum(d.mosShopId)}, ${toStr(d.vin)},
           ${toStr(d.userEmail)}, ${toStr(d.concern)}, ${toStr(d.symptomCategory)},
           ${d.questions == null ? null : JSON.stringify(d.questions)}::jsonb,
           ${d.answeredQuestions == null ? null : JSON.stringify(d.answeredQuestions)}::jsonb,
           ${d.roundResults == null ? null : JSON.stringify(d.roundResults)}::jsonb,
           ${d.review == null ? null : JSON.stringify(d.review)}::jsonb,
           ${toBool(d.injectedToProtractor)},
           ${toIsoOrNow(d.createdAt)}, ${toIsoOrNow(d.updatedAt ?? d.createdAt)})
        ON CONFLICT (id) DO UPDATE SET
          questions = EXCLUDED.questions,
          answered_questions = EXCLUDED.answered_questions,
          round_results = EXCLUDED.round_results,
          review = EXCLUDED.review,
          injected_to_protractor = EXCLUDED.injected_to_protractor,
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

async function migrateReportApprovedItems(batch: number) {
  const pg = getPg();
  await streamCollection("report_approved_items", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      const vin = toStr(d.vin);
      if (shopId == null || !vin) continue;
      await pg.execute(sql`
        INSERT INTO report_approved_items (shop_id, vin, approved_service_keys, updated_at)
        VALUES (${shopId}, ${vin.toUpperCase()},
                ${JSON.stringify(toJson(d.approvedServiceKeys) ?? [])}::jsonb,
                ${toIsoOrNow(d.updatedAt)})
        ON CONFLICT (shop_id, vin) DO UPDATE SET
          approved_service_keys = EXCLUDED.approved_service_keys,
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

async function migrateRemediedDeferredWork(batch: number) {
  const pg = getPg();
  await streamCollection("remedied_deferred_work", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      const vin = toStr(d.vin);
      const deferredId = toStr(d.deferredId);
      if (shopId == null || !vin || !deferredId) continue;
      await pg.execute(sql`
        INSERT INTO remedied_deferred_work
          (shop_id, vin, deferred_id, carfax_date, carfax_description, remedied_at, raw)
        VALUES
          (${shopId}, ${vin.toUpperCase()}, ${deferredId},
           ${toStr(d.carfaxDate)}, ${toStr(d.carfaxDescription)},
           ${toIsoOrNow(d.remediedAt ?? d.createdAt)}, ${JSON.stringify(d)}::jsonb)
        ON CONFLICT (shop_id, vin, deferred_id) DO UPDATE SET
          carfax_date = EXCLUDED.carfax_date,
          carfax_description = EXCLUDED.carfax_description,
          remedied_at = EXCLUDED.remedied_at,
          raw = EXCLUDED.raw
      `);
    }
  });
}

async function migrateShopRepairPatterns(batch: number) {
  const pg = getPg();
  await streamCollection("shop_repair_patterns", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      const pattern = toStr(d.pattern);
      if (shopId == null || !pattern) continue;
      await pg.execute(sql`
        INSERT INTO shop_repair_patterns
          (backfill_mongo_id, shop_id, pattern, service_name, sample_count,
           confidence, metadata, first_seen_at, last_seen_at)
        VALUES
          (${mongoId}, ${shopId}, ${pattern}, ${toStr(d.serviceName)},
           ${toNum(d.sampleCount) ?? 0}, ${toNum(d.confidence)},
           ${d.metadata == null ? null : JSON.stringify(d.metadata)}::jsonb,
           ${toIsoOrNow(d.firstSeenAt ?? d.createdAt)},
           ${toIsoOrNow(d.lastSeenAt ?? d.updatedAt ?? d.createdAt)})
        ON CONFLICT (shop_id, pattern) DO UPDATE SET
          service_name = EXCLUDED.service_name,
          sample_count = GREATEST(shop_repair_patterns.sample_count, EXCLUDED.sample_count),
          confidence = EXCLUDED.confidence,
          metadata = EXCLUDED.metadata,
          last_seen_at = GREATEST(shop_repair_patterns.last_seen_at, EXCLUDED.last_seen_at)
      `);
    }
  });
}

async function migrateOemSchedules(batch: number) {
  const pg = getPg();
  await streamCollection("oem_schedules", batch, async (docs) => {
    for (const d of docs) {
      const vin = toStr(d.vin);
      if (!vin) continue;
      await pg.execute(sql`
        INSERT INTO oem_schedules (vin, items, source, fetched_at, raw)
        VALUES (${vin.toUpperCase()},
                ${d.items == null ? null : JSON.stringify(d.items)}::jsonb,
                ${toStr(d.source)},
                ${toIsoOrNow(d.fetchedAt ?? d.createdAt)},
                ${JSON.stringify(d)}::jsonb)
        ON CONFLICT (vin) DO UPDATE SET
          items = EXCLUDED.items,
          source = EXCLUDED.source,
          fetched_at = EXCLUDED.fetched_at,
          raw = EXCLUDED.raw
      `);
    }
  });
}

async function migrateOemCarfaxMappings(batch: number) {
  const pg = getPg();
  await streamCollection("oem_carfax_mappings", batch, async (docs) => {
    for (const d of docs) {
      const oemName = toStr(d.oemName);
      const carfaxName = toStr(d.carfaxName);
      if (!oemName || !carfaxName) continue;
      await pg.execute(sql`
        INSERT INTO oem_carfax_mappings (oem_name, carfax_name, category, created_at, updated_at)
        VALUES (${oemName}, ${carfaxName}, ${toStr(d.category)},
                ${toIsoOrNow(d.createdAt)}, ${toIsoOrNow(d.updatedAt)})
        ON CONFLICT (oem_name) DO UPDATE SET
          carfax_name = EXCLUDED.carfax_name,
          category = EXCLUDED.category,
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

/* ========================================================================== */
/* External-API surface                                                       */
/* ========================================================================== */

async function migrateExternalApiAppointments(batch: number) {
  const pg = getPg();
  await streamCollection("external_api_appointments", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO external_api_appointments
          (backfill_mongo_id, shop_id, external_id, provider, customer_id, customer_name,
           vehicle_id, vin, scheduled_date, scheduled_time, service_type,
           is_drop_off, ride_option, payload, created_at)
        VALUES
          (${mongoId}, ${shopId}, ${toStr(d.externalId)}, ${toStr(d.provider) ?? "unknown"},
           ${toStr(d.customerId)}, ${toStr(d.customerName)}, ${toStr(d.vehicleId)},
           ${toStr(d.vin)}, ${toStr(d.scheduledDate)}, ${toStr(d.scheduledTime)},
           ${toStr(d.serviceType)}, ${toBoolOrNull(d.isDropOff)}, ${toStr(d.rideOption)},
           ${JSON.stringify(d)}::jsonb, ${toIsoOrNow(d.createdAt)})
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateExternalApiKeytags(batch: number) {
  const pg = getPg();
  await streamCollection("external_api_keytags", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO external_api_keytags
          (backfill_mongo_id, shop_id, vin, customer_id, payload, created_at)
        VALUES
          (${mongoId}, ${shopId}, ${toStr(d.vin)}, ${toStr(d.customerId)},
           ${JSON.stringify(d)}::jsonb, ${toIsoOrNow(d.createdAt)})
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateExternalApiStickers(batch: number) {
  const pg = getPg();
  await streamCollection("external_api_stickers", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO external_api_stickers
          (backfill_mongo_id, shop_id, vin, customer_id, customer_name,
           vehicle_year, vehicle_make, vehicle_model, current_mileage,
           next_service_mileage, next_service_date, oil_type, oil_brand,
           payload, created_at)
        VALUES
          (${mongoId}, ${shopId}, ${toStr(d.vin)}, ${toStr(d.customerId)}, ${toStr(d.customerName)},
           ${toNum(d.vehicleYear)}, ${toStr(d.vehicleMake)}, ${toStr(d.vehicleModel)},
           ${toNum(d.currentMileage)}, ${toNum(d.nextServiceMileage)},
           ${toStr(d.nextServiceDate)}, ${toStr(d.oilType)}, ${toStr(d.oilBrand)},
           ${JSON.stringify(d)}::jsonb, ${toIsoOrNow(d.createdAt)})
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateStickerGenerations(batch: number) {
  const pg = getPg();
  await streamCollection("sticker_generations", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO sticker_generations
          (backfill_mongo_id, shop_id, generated_at, generated_by, vin,
           vehicle_year, vehicle_make, vehicle_model, size, unit, source)
        VALUES
          (${mongoId}, ${shopId}, ${toIsoOrNow(d.generatedAt)}, ${toStr(d.generatedBy)},
           ${toStr(d.vin)}, ${toNum(d.vehicleYear)}, ${toStr(d.vehicleMake)},
           ${toStr(d.vehicleModel)}, ${toStr(d.size)}, ${toStr(d.unit)}, ${toStr(d.source)})
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateStickerQrScans(batch: number) {
  const pg = getPg();
  await streamCollection("sticker_qr_scans", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO sticker_qr_scans
          (backfill_mongo_id, shop_id, scanned_at, user_agent, referer)
        VALUES
          (${mongoId}, ${shopId}, ${toIsoOrNow(d.scannedAt)},
           ${toStr(d.userAgent)}, ${toStr(d.referer)})
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateShopMedia(batch: number) {
  const pg = getPg();
  await streamCollection("shop_media", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      const type = toStr(d.type);
      const dataUri = toStr(d.dataUri);
      if (shopId == null || !type || !dataUri) continue;
      await pg.execute(sql`
        INSERT INTO shop_media
          (shop_id, type, data_uri, content_type, hovercode_id, updated_by, updated_at)
        VALUES
          (${shopId}, ${type}, ${dataUri}, ${toStr(d.contentType)},
           ${toStr(d.hovercodeId)}, ${toStr(d.updatedBy)}, ${toIsoOrNow(d.updatedAt)})
        ON CONFLICT (shop_id, type) DO UPDATE SET
          data_uri = EXCLUDED.data_uri,
          content_type = EXCLUDED.content_type,
          hovercode_id = EXCLUDED.hovercode_id,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

/* ========================================================================== */
/* Audit / notifications                                                      */
/* ========================================================================== */

async function migrateAuditLogs(batch: number) {
  const pg = getPg();
  await streamCollection("audit_logs", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const targetShopRaw = d.targetShopId;
      const targetShop = targetShopRaw == null ? null : String(targetShopRaw);
      const { _id, createdAt, actorEmail, action, targetShopId, ...rest } =
        d as Record<string, unknown>;
      await pg.execute(sql`
        INSERT INTO audit_logs
          (backfill_mongo_id, actor_email, action, target_shop_id, details, created_at)
        VALUES
          (${mongoId}, ${toStr(actorEmail)}, ${toStr(action)}, ${targetShop},
           ${JSON.stringify(rest)}::jsonb, ${toIsoOrNow(createdAt)})
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateAdminAuditLogs(batch: number) {
  const pg = getPg();
  await streamCollection("admin_audit_logs", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const action = toStr(d.action);
      const adminEmail = toStr(d.adminEmail);
      if (!action || !adminEmail) continue;
      const targetShop = d.targetShopId == null ? null : String(d.targetShopId);
      await pg.execute(sql`
        INSERT INTO admin_audit_logs
          (backfill_mongo_id, action, admin_email, target_shop_id, target_shop_name,
           target_user_email, details, ip_address, user_agent, created_at)
        VALUES
          (${mongoId}, ${action}, ${adminEmail}, ${targetShop},
           ${toStr(d.targetShopName)}, ${toStr(d.targetUserEmail)},
           ${d.details == null ? null : JSON.stringify(d.details)}::jsonb,
           ${toStr(d.ipAddress)}, ${toStr(d.userAgent)}, ${toIsoOrNow(d.createdAt)})
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateNotifications(batch: number) {
  const pg = getPg();
  await streamCollection("notifications", batch, async (docs) => {
    for (const d of docs) {
      const id = objIdToHex(d._id);
      const userId = toStr(d.userId);
      const type = toStr(d.type);
      const title = toStr(d.title);
      const message = toStr(d.message);
      if (!userId || !type || !title || !message) continue;
      await pg.execute(sql`
        INSERT INTO notifications
          (id, user_id, shop_id, type, title, message, link, read, metadata, created_at)
        VALUES
          (${id}, ${userId}, ${toNum(d.shopId)}, ${type}, ${title}, ${message},
           ${toStr(d.link)}, ${toBool(d.read)},
           ${d.metadata == null ? null : JSON.stringify(d.metadata)}::jsonb,
           ${toIsoOrNow(d.createdAt)})
        ON CONFLICT (id) DO UPDATE SET
          read = EXCLUDED.read,
          metadata = EXCLUDED.metadata
      `);
    }
  });
}

async function migrateDashboardUpdates(batch: number) {
  const pg = getPg();
  await streamCollection("dashboard_updates", batch, async (docs) => {
    for (const d of docs) {
      // Mongo uses two writer shapes:
      //   { _id: "lastUpdate", timestamp }
      //   { shopId, lastUpdate }
      // We canonicalize on a single string key. The cutover PR will rewrite
      // the writers to call a repository helper that picks the right key.
      const explicitId = typeof d._id === "string" ? (d._id as string) : null;
      const shopId = toNum(d.shopId);
      const key =
        explicitId ??
        (shopId != null ? `shop:${shopId}` : null);
      if (!key) continue;
      const ts =
        toNum(d.timestamp) ??
        toNum(d.lastUpdate) ??
        toDate(d.updatedAt)?.getTime() ??
        Date.now();
      await pg.execute(sql`
        INSERT INTO dashboard_updates (key, shop_id, timestamp_ms, updated_at)
        VALUES (${key}, ${shopId}, ${ts}, ${toIsoOrNow(d.updatedAt)})
        ON CONFLICT (key) DO UPDATE SET
          shop_id = EXCLUDED.shop_id,
          timestamp_ms = GREATEST(dashboard_updates.timestamp_ms, EXCLUDED.timestamp_ms),
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

async function migrateSupportChatSessions(batch: number) {
  const pg = getPg();
  await streamCollection("support_chat_sessions", batch, async (docs) => {
    for (const d of docs) {
      const sessionId = toStr(d.sessionId);
      const userEmail = toStr(d.userEmail);
      const shopId = toNum(d.shopId);
      if (!sessionId || !userEmail || shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO support_chat_sessions
          (session_id, user_email, shop_id, messages, resolved,
           escalated_to_ticket, created_at, updated_at)
        VALUES
          (${sessionId}, ${userEmail}, ${shopId},
           ${JSON.stringify(toJson(d.messages) ?? [])}::jsonb,
           ${toBool(d.resolved)}, ${toStr(d.escalatedToTicket)},
           ${toIsoOrNow(d.createdAt)}, ${toIsoOrNow(d.updatedAt ?? d.createdAt)})
        ON CONFLICT (session_id) DO UPDATE SET
          messages = EXCLUDED.messages,
          resolved = EXCLUDED.resolved,
          escalated_to_ticket = EXCLUDED.escalated_to_ticket,
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

/* ========================================================================== */
/* Queues & locks                                                             */
/* ========================================================================== */

async function migrateEnrichmentQueue(batch: number) {
  const pg = getPg();
  await streamCollection("enrichment_queue", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      const vin = toStr(d.vin);
      if (shopId == null || !vin) continue;
      await pg.execute(sql`
        INSERT INTO enrichment_queue
          (shop_id, vin, status, priority, attempts, error, oem_fetched, carfax_fetched,
           started_at, completed_at, next_attempt_at, last_attempt_at, created_at, updated_at)
        VALUES
          (${shopId}, ${vin.toUpperCase()},
           ${toStr(d.status) ?? "pending"}, ${toNum(d.priority) ?? 1},
           ${toNum(d.attempts) ?? 0}, ${toStr(d.error)},
           ${toBoolOrNull(d.oemFetched)}, ${toBoolOrNull(d.carfaxFetched)},
           ${toIsoOrNull(d.startedAt)}, ${toIsoOrNull(d.completedAt)},
           ${toIsoOrNull(d.nextAttemptAt)}, ${toIsoOrNull(d.lastAttemptAt)},
           ${toIsoOrNow(d.createdAt)}, ${toIsoOrNow(d.updatedAt ?? d.createdAt)})
        ON CONFLICT (shop_id, vin) DO UPDATE SET
          status = EXCLUDED.status,
          priority = EXCLUDED.priority,
          attempts = EXCLUDED.attempts,
          error = EXCLUDED.error,
          oem_fetched = EXCLUDED.oem_fetched,
          carfax_fetched = EXCLUDED.carfax_fetched,
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at,
          next_attempt_at = EXCLUDED.next_attempt_at,
          last_attempt_at = EXCLUDED.last_attempt_at,
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

async function migrateExtensionPrefetchLocks(batch: number) {
  const pg = getPg();
  await streamCollection("extension_prefetch_locks", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO extension_prefetch_locks (shop_id, started_at)
        VALUES (${shopId}, ${toIsoOrNow(d.startedAt)})
        ON CONFLICT (shop_id) DO UPDATE SET
          started_at = EXCLUDED.started_at
      `);
    }
  });
}

async function migrateAutoBookingQueue(batch: number) {
  const pg = getPg();
  await streamCollection("auto_booking_queue", batch, async (docs) => {
    for (const d of docs) {
      const id = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO auto_booking_queue
          (id, shop_id, status, vin, customer_id, vehicle_id, scheduled_date,
           scheduled_time, service_type, external_appointment_id, provider,
           confirmation_mode, attempts, last_error, data, created_at, updated_at)
        VALUES
          (${id}, ${shopId}, ${toStr(d.status)}, ${toStr(d.vin)},
           ${toStr(d.customerId)}, ${toStr(d.vehicleId)}, ${toStr(d.scheduledDate)},
           ${toStr(d.scheduledTime)}, ${toStr(d.serviceType)},
           ${toStr(d.externalAppointmentId)}, ${toStr(d.provider)},
           ${toStr(d.confirmationMode)}, ${toNum(d.attempts) ?? 0},
           ${toStr(d.lastError)}, ${JSON.stringify(d)}::jsonb,
           ${toIsoOrNow(d.createdAt)}, ${toIsoOrNow(d.updatedAt ?? d.createdAt)})
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          attempts = EXCLUDED.attempts,
          last_error = EXCLUDED.last_error,
          data = EXCLUDED.data,
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

/* ========================================================================== */
/* Tekmetric operational state                                                */
/* ========================================================================== */

async function migrateTekmetricBackfillProgress(batch: number) {
  const pg = getPg();
  await streamCollection("tekmetric_backfill_progress", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      const {
        shopId: _s, _id, startedAt, currentChunkEnd, completed, completedAt,
        complete, logicVersion, lastRunAt, lastError, lastErrorAt,
        recentSkippedRos, lastStaleSkippedRosArchivedAt,
        staleSkippedRosArchivedTotal, ...extra
      } = d as Record<string, unknown>;
      await pg.execute(sql`
        INSERT INTO tekmetric_backfill_progress
          (shop_id, started_at, current_chunk_end, completed, completed_at, complete,
           logic_version, last_run_at, last_error, last_error_at, recent_skipped_ros,
           last_stale_skipped_ros_archived_at, stale_skipped_ros_archived_total, extra)
        VALUES
          (${shopId}, ${toIsoOrNull(startedAt)}, ${toIsoOrNull(currentChunkEnd)},
           ${toBool(completed)}, ${toIsoOrNull(completedAt)}, ${toBoolOrNull(complete)},
           ${toNum(logicVersion)}, ${toIsoOrNull(lastRunAt)}, ${toStr(lastError)},
           ${toIsoOrNull(lastErrorAt)},
           ${JSON.stringify(toJson(recentSkippedRos) ?? [])}::jsonb,
           ${toIsoOrNull(lastStaleSkippedRosArchivedAt)},
           ${toNum(staleSkippedRosArchivedTotal) ?? 0},
           ${JSON.stringify(extra)}::jsonb)
        ON CONFLICT (shop_id) DO UPDATE SET
          started_at = EXCLUDED.started_at,
          current_chunk_end = EXCLUDED.current_chunk_end,
          completed = EXCLUDED.completed,
          completed_at = EXCLUDED.completed_at,
          complete = EXCLUDED.complete,
          logic_version = EXCLUDED.logic_version,
          last_run_at = EXCLUDED.last_run_at,
          last_error = EXCLUDED.last_error,
          last_error_at = EXCLUDED.last_error_at,
          recent_skipped_ros = EXCLUDED.recent_skipped_ros,
          last_stale_skipped_ros_archived_at = EXCLUDED.last_stale_skipped_ros_archived_at,
          stale_skipped_ros_archived_total = EXCLUDED.stale_skipped_ros_archived_total,
          extra = EXCLUDED.extra,
          updated_at = now()
      `);
    }
  });
}

async function migrateTekmetricBackfillHealthAlerts(batch: number) {
  const pg = getPg();
  await streamCollection("tekmetric_backfill_health_alerts", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO tekmetric_backfill_health_alerts
          (shop_id, first_alerted_at, last_alerted_at, alert_count, payload, resolved_at)
        VALUES
          (${shopId}, ${toIsoOrNow(d.firstAlertedAt ?? d.createdAt)},
           ${toIsoOrNow(d.lastAlertedAt ?? d.updatedAt ?? d.createdAt)},
           ${toNum(d.alertCount) ?? 1},
           ${JSON.stringify(d)}::jsonb, ${toIsoOrNull(d.resolvedAt)})
        ON CONFLICT (shop_id) DO UPDATE SET
          last_alerted_at = EXCLUDED.last_alerted_at,
          alert_count = EXCLUDED.alert_count,
          payload = EXCLUDED.payload,
          resolved_at = EXCLUDED.resolved_at
      `);
    }
  });
}

async function migrateTekmetricPermfailedRoAlerts(batch: number) {
  const pg = getPg();
  await streamCollection("tekmetric_permfailed_ro_alerts", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      await pg.execute(sql`
        INSERT INTO tekmetric_permfailed_ro_alerts
          (shop_id, name, current_count, first_alerted_at, last_alerted_at, payload, resolved_at)
        VALUES
          (${shopId}, ${toStr(d.name)}, ${toNum(d.currentCount) ?? 0},
           ${toIsoOrNow(d.firstAlertedAt ?? d.createdAt)},
           ${toIsoOrNow(d.lastAlertedAt ?? d.updatedAt ?? d.createdAt)},
           ${JSON.stringify(d)}::jsonb, ${toIsoOrNull(d.resolvedAt)})
        ON CONFLICT (shop_id) DO UPDATE SET
          name = EXCLUDED.name,
          current_count = EXCLUDED.current_count,
          last_alerted_at = EXCLUDED.last_alerted_at,
          payload = EXCLUDED.payload,
          resolved_at = EXCLUDED.resolved_at
      `);
    }
  });
}

async function migrateTekmetricSkippedRoArchive(batch: number) {
  const pg = getPg();
  await streamCollection("tekmetric_skipped_ro_archive", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      const shopId = toNum(d.shopId);
      const roId = toStr(d.roId);
      if (shopId == null || !roId) continue;
      await pg.execute(sql`
        INSERT INTO tekmetric_skipped_ro_archive
          (backfill_mongo_id, shop_id, ro_id, skipped_at, archived_at, stale,
           permanently_failed, reason, payload)
        VALUES
          (${mongoId}, ${shopId}, ${roId}, ${toIsoOrNull(d.skippedAt)},
           ${toIsoOrNow(d.archivedAt)}, ${toBool(d.stale)},
           ${toBool(d.permanentlyFailed)}, ${toStr(d.reason)},
           ${JSON.stringify(d)}::jsonb)
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateTekmetricCatchupRuns(batch: number) {
  const pg = getPg();
  await streamCollection("tekmetric_catchup_runs", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      await pg.execute(sql`
        INSERT INTO tekmetric_catchup_runs
          (backfill_mongo_id, started_at, finished_at, shops_processed, ros_processed,
           success, summary)
        VALUES
          (${mongoId}, ${toIsoOrNow(d.startedAt)}, ${toIsoOrNull(d.finishedAt)},
           ${toNum(d.shopsProcessed)}, ${toNum(d.rosProcessed)},
           ${toBoolOrNull(d.success)}, ${JSON.stringify(d)}::jsonb)
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateTekmetricMileageBackfillProgress(batch: number) {
  const pg = getPg();
  await streamCollection("tekmetric_mileage_backfill_progress", batch, async (docs) => {
    for (const d of docs) {
      const shopId = toNum(d.shopId);
      if (shopId == null) continue;
      const {
        shopId: _s, _id, cursorRoId, completed, completedAt, lastRunAt,
        rosUpdated, ...extra
      } = d as Record<string, unknown>;
      await pg.execute(sql`
        INSERT INTO tekmetric_mileage_backfill_progress
          (shop_id, cursor_ro_id, completed, completed_at, last_run_at,
           ros_updated, extra)
        VALUES
          (${shopId}, ${toStr(cursorRoId)}, ${toBool(completed)},
           ${toIsoOrNull(completedAt)}, ${toIsoOrNull(lastRunAt)},
           ${toNum(rosUpdated) ?? 0}, ${JSON.stringify(extra)}::jsonb)
        ON CONFLICT (shop_id) DO UPDATE SET
          cursor_ro_id = EXCLUDED.cursor_ro_id,
          completed = EXCLUDED.completed,
          completed_at = EXCLUDED.completed_at,
          last_run_at = EXCLUDED.last_run_at,
          ros_updated = EXCLUDED.ros_updated,
          extra = EXCLUDED.extra,
          updated_at = now()
      `);
    }
  });
}

async function migrateTekmetricWebhookLogs(batch: number) {
  const pg = getPg();
  await streamCollection("tekmetric_webhook_logs", batch, async (docs) => {
    for (const d of docs) {
      const mongoId = objIdToHex(d._id);
      await pg.execute(sql`
        INSERT INTO tekmetric_webhook_logs
          (backfill_mongo_id, tekmetric_shop_id, mos_shop_id, event_type,
           received_at, payload, processed, process_error)
        VALUES
          (${mongoId}, ${toNum(d.tekmetricShopId)}, ${toNum(d.mosShopId)},
           ${toStr(d.eventType)}, ${toIsoOrNow(d.receivedAt ?? d.createdAt)},
           ${JSON.stringify(toJson(d.payload) ?? d)}::jsonb,
           ${toBool(d.processed)}, ${toStr(d.processError)})
        ON CONFLICT (backfill_mongo_id) DO NOTHING
      `);
    }
  });
}

async function migrateTekmetricWebhookSubscriptions(batch: number) {
  const pg = getPg();
  await streamCollection("tekmetric_webhook_subscriptions", batch, async (docs) => {
    for (const d of docs) {
      const tekmetricShopId = toNum(d.tekmetricShopId);
      if (tekmetricShopId == null) continue;
      await pg.execute(sql`
        INSERT INTO tekmetric_webhook_subscriptions
          (tekmetric_shop_id, mos_shop_id, events, public_url,
           first_attempt_at, last_attempt_at, last_result)
        VALUES
          (${tekmetricShopId}, ${toNum(d.mosShopId)},
           ${d.events == null ? null : JSON.stringify(d.events)}::jsonb,
           ${toStr(d.publicUrl)}, ${toIsoOrNull(d.firstAttemptAt)},
           ${toIsoOrNull(d.lastAttemptAt)},
           ${d.lastResult == null ? null : JSON.stringify(d.lastResult)}::jsonb)
        ON CONFLICT (tekmetric_shop_id) DO UPDATE SET
          mos_shop_id = EXCLUDED.mos_shop_id,
          events = EXCLUDED.events,
          public_url = EXCLUDED.public_url,
          last_attempt_at = EXCLUDED.last_attempt_at,
          last_result = EXCLUDED.last_result
      `);
    }
  });
}

async function migrateTekmetricWebhookHealthAlerts(batch: number) {
  const pg = getPg();
  await streamCollection("tekmetric_webhook_health_alerts", batch, async (docs) => {
    for (const d of docs) {
      const tekmetricShopId = toNum(d.tekmetricShopId);
      const alertDate = toStr(d.alertDate);
      if (tekmetricShopId == null || !alertDate) continue;
      await pg.execute(sql`
        INSERT INTO tekmetric_webhook_health_alerts
          (tekmetric_shop_id, alert_date, alerted_at, payload)
        VALUES
          (${tekmetricShopId}, ${alertDate},
           ${toIsoOrNow(d.alertedAt ?? d.createdAt)},
           ${JSON.stringify(d)}::jsonb)
        ON CONFLICT (tekmetric_shop_id, alert_date) DO NOTHING
      `);
    }
  });
}

/* ========================================================================== */
/* Misc                                                                       */
/* ========================================================================== */

async function migratePlatformPlans(batch: number) {
  const pg = getPg();
  await streamCollection("platform_plans", batch, async (docs) => {
    for (const d of docs) {
      const slug = toStr(d.slug);
      if (!slug) continue;
      await pg.execute(sql`
        INSERT INTO platform_plans
          (slug, name, monthly_price, annual_price, stripe_monthly_price_id,
           stripe_annual_price_id, features, raw, created_at, updated_at)
        VALUES
          (${slug}, ${toStr(d.name)}, ${toNum(d.monthlyPrice)}, ${toNum(d.annualPrice)},
           ${toStr(d.stripeMonthlyPriceId)}, ${toStr(d.stripeAnnualPriceId)},
           ${d.features == null ? null : JSON.stringify(d.features)}::jsonb,
           ${JSON.stringify(d)}::jsonb,
           ${toIsoOrNow(d.createdAt)}, ${toIsoOrNow(d.updatedAt)})
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          monthly_price = EXCLUDED.monthly_price,
          annual_price = EXCLUDED.annual_price,
          stripe_monthly_price_id = EXCLUDED.stripe_monthly_price_id,
          stripe_annual_price_id = EXCLUDED.stripe_annual_price_id,
          features = EXCLUDED.features,
          raw = EXCLUDED.raw,
          updated_at = EXCLUDED.updated_at
      `);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Dispatcher                                                                 */
/* -------------------------------------------------------------------------- */

const MIGRATORS: Record<EntityName, (batch: number) => Promise<void>> = {
  ai_analysis_cache: migrateAiAnalysisCache,
  maintenance_analysis_cache: migrateMaintenanceAnalysisCache,
  ai_budget_alerts: migrateAiBudgetAlerts,
  vhi_analysis_log: migrateVhiAnalysisLog,
  concern_conversations: migrateConcernConversations,
  report_approved_items: migrateReportApprovedItems,
  remedied_deferred_work: migrateRemediedDeferredWork,
  shop_repair_patterns: migrateShopRepairPatterns,
  oem_schedules: migrateOemSchedules,
  oem_carfax_mappings: migrateOemCarfaxMappings,
  external_api_appointments: migrateExternalApiAppointments,
  external_api_keytags: migrateExternalApiKeytags,
  external_api_stickers: migrateExternalApiStickers,
  sticker_generations: migrateStickerGenerations,
  sticker_qr_scans: migrateStickerQrScans,
  shop_media: migrateShopMedia,
  audit_logs: migrateAuditLogs,
  admin_audit_logs: migrateAdminAuditLogs,
  notifications: migrateNotifications,
  dashboard_updates: migrateDashboardUpdates,
  support_chat_sessions: migrateSupportChatSessions,
  enrichment_queue: migrateEnrichmentQueue,
  extension_prefetch_locks: migrateExtensionPrefetchLocks,
  auto_booking_queue: migrateAutoBookingQueue,
  tekmetric_backfill_progress: migrateTekmetricBackfillProgress,
  tekmetric_backfill_health_alerts: migrateTekmetricBackfillHealthAlerts,
  tekmetric_permfailed_ro_alerts: migrateTekmetricPermfailedRoAlerts,
  tekmetric_skipped_ro_archive: migrateTekmetricSkippedRoArchive,
  tekmetric_catchup_runs: migrateTekmetricCatchupRuns,
  tekmetric_mileage_backfill_progress: migrateTekmetricMileageBackfillProgress,
  tekmetric_webhook_logs: migrateTekmetricWebhookLogs,
  tekmetric_webhook_subscriptions: migrateTekmetricWebhookSubscriptions,
  tekmetric_webhook_health_alerts: migrateTekmetricWebhookHealthAlerts,
  platform_plans: migratePlatformPlans,
};

async function main() {
  const { only, batch } = parseArgs();
  console.log(
    `[wave2-backfill] entities=${only.join(",")} batch=${batch} skip=${process.env.WAVE2_SKIP ?? 0}`,
  );
  for (const name of only) {
    const fn = MIGRATORS[name];
    if (!fn) {
      console.warn(`[wave2-backfill] unknown entity: ${name} (skipping)`);
      continue;
    }
    console.log(`\n=== ${name} ===`);
    try {
      await fn(batch);
    } catch (err) {
      console.error(`[wave2-backfill] ${name} FAILED:`, err);
      process.exitCode = 1;
    }
  }
  console.log("\n[wave2-backfill] done");
}

main().catch((err) => {
  console.error("[wave2-backfill] fatal:", err);
  process.exit(1);
});
