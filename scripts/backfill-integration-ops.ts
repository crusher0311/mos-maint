#!/usr/bin/env tsx
/**
 * Integration operational stores Mongo → Postgres backfill (task #999).
 *
 * Covers the DURABLE operational stores that have no mirror spec in
 * `scripts/wave2-mongo-to-pg-backfill.ts` / `scripts/backfill-mongo-to-supabase.ts`:
 *
 *   api_usage                        → api_usage                (large append-only log)
 *   tekmetric_tokens                 → tekmetric_tokens         (single global doc, shop_id=0 sentinel)
 *   protractor_webhook_subscriptions → protractor_webhook_subscriptions
 *   autovitals_appointments          → autovitals_appointments
 *   autovitals_inspections           → autovitals_inspections
 *
 * Transient state (drain locks, rate-limit slots, backfill progress
 * heartbeats) is deliberately NOT backfilled — those cut over as a pure
 * flag flip, per the cron-lock / rate-bucket precedent.
 *
 * Chunked + resumable: walks each collection in `_id` order, upserts
 * idempotently (ON CONFLICT DO UPDATE), and checkpoints the last
 * migrated `_id` per spec in the `integration_ops_backfill_state` PG
 * table after every batch, so a killed run resumes where it left off.
 * Re-running a completed spec is a cheap no-op tail scan.
 *
 * Operator-only; run off-peak (dev Mongo IS prod):
 *   pnpm tsx scripts/backfill-integration-ops.ts                 # all specs
 *   pnpm tsx scripts/backfill-integration-ops.ts --only=api_usage
 *   pnpm tsx scripts/backfill-integration-ops.ts --only=api_usage --batch=2000
 *   pnpm tsx scripts/backfill-integration-ops.ts --restart       # ignore checkpoints
 */
import "dotenv/config";
import { ObjectId, type Document } from "mongodb";
import { sql } from "drizzle-orm";
import { getDb as getMongo } from "@/lib/mongo";
import { getDb as getPg, getClient } from "@/lib/db/drizzle";

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith("--only="));
const batchArg = args.find((a) => a.startsWith("--batch="));
const restart = args.includes("--restart");
const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : null;
const BATCH = batchArg ? Math.max(100, parseInt(batchArg.slice(8), 10) || 1000) : 1000;

function d(v: unknown): Date | null {
  if (!v) return null;
  const dt = v instanceof Date ? v : new Date(v as string);
  return isNaN(dt.getTime()) ? null : dt;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}
function j(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

interface Spec {
  key: string;
  mongoName: string;
  /** Upsert one batch of Mongo docs into PG. */
  upsert: (docs: Document[]) => Promise<void>;
}

const pgq = () => getClient();

const SPECS: Spec[] = [
  {
    key: "api_usage",
    mongoName: "api_usage",
    async upsert(docs) {
      const q = pgq();
      for (const doc of docs) {
        const {
          _id, provider, shopId, shopName, endpoint, method, statusCode,
          isError, isRateLimited, errorMessage, errorCode, latencyMs,
          requestId, sourceWorker, timestamp, ...rest
        } = doc as any;
        await q`
          INSERT INTO api_usage (id, provider, shop_id, shop_name, endpoint, method,
            status_code, is_error, is_rate_limited, error_message, error_code,
            latency_ms, request_id, source_worker, "timestamp", extra)
          VALUES (${String(_id)}, ${provider ?? "unknown"}, ${num(shopId)}, ${shopName ?? null},
            ${endpoint ?? null}, ${method ?? null}, ${num(statusCode)},
            ${Boolean(isError)}, ${Boolean(isRateLimited)}, ${errorMessage ?? null},
            ${errorCode ?? null}, ${num(latencyMs)}, ${requestId ?? null},
            ${sourceWorker ?? null}, ${d(timestamp) ?? new Date(0)},
            ${Object.keys(rest).length ? j(rest) : null})
          ON CONFLICT (id) DO UPDATE SET
            provider = EXCLUDED.provider, shop_id = EXCLUDED.shop_id,
            shop_name = EXCLUDED.shop_name, endpoint = EXCLUDED.endpoint,
            method = EXCLUDED.method, status_code = EXCLUDED.status_code,
            is_error = EXCLUDED.is_error, is_rate_limited = EXCLUDED.is_rate_limited,
            error_message = EXCLUDED.error_message, error_code = EXCLUDED.error_code,
            latency_ms = EXCLUDED.latency_ms, request_id = EXCLUDED.request_id,
            source_worker = EXCLUDED.source_worker, "timestamp" = EXCLUDED."timestamp",
            extra = EXCLUDED.extra
        `;
      }
    },
  },
  {
    key: "tekmetric_tokens",
    mongoName: "tekmetric_tokens",
    async upsert(docs) {
      const q = pgq();
      for (const doc of docs) {
        const { _id, accessToken, refreshToken, tokenType, expiresAt, scope, ...rest } =
          doc as any;
        // Mongo keeps a single global doc keyed { tokenKey: "current" };
        // the PG table is keyed by shop_id — the global doc maps to the
        // shop_id = 0 sentinel (see lib/data/repositories/tekmetric-ops.ts).
        await q`
          INSERT INTO tekmetric_tokens (shop_id, access_token, refresh_token,
            token_type, expires_at, scope, raw, updated_at)
          VALUES (0, ${accessToken ?? ""}, ${refreshToken ?? null}, ${tokenType ?? null},
            ${d(expiresAt)}, ${scope ?? null}, ${j({ ...rest, _id: String(_id) })}, now())
          ON CONFLICT (shop_id) DO UPDATE SET
            access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
            token_type = EXCLUDED.token_type, expires_at = EXCLUDED.expires_at,
            scope = EXCLUDED.scope, raw = EXCLUDED.raw, updated_at = now()
        `;
      }
    },
  },
  {
    key: "protractor_webhook_subscriptions",
    mongoName: "protractor_webhook_subscriptions",
    async upsert(docs) {
      const q = pgq();
      for (const doc of docs) {
        const { _id, shopId, token, callbackUrl, url, active, verifiedAt, lastCheckedAt, ...rest } =
          doc as any;
        const sid = num(shopId);
        if (sid === null) continue;
        await q`
          INSERT INTO protractor_webhook_subscriptions (shop_id, token, url, active,
            verified_at, last_checked_at, payload, created_at, updated_at)
          VALUES (${sid}, ${token ?? null}, ${callbackUrl ?? url ?? null},
            ${active === undefined ? true : Boolean(active)}, ${d(verifiedAt)},
            ${d(lastCheckedAt)}, ${j({ ...rest, _id: String(_id) })}, now(), now())
          ON CONFLICT (shop_id) DO UPDATE SET
            token = EXCLUDED.token, url = EXCLUDED.url, active = EXCLUDED.active,
            verified_at = EXCLUDED.verified_at, last_checked_at = EXCLUDED.last_checked_at,
            payload = EXCLUDED.payload, updated_at = now()
        `;
      }
    },
  },
  {
    key: "autovitals_appointments",
    mongoName: "autovitals_appointments",
    async upsert(docs) {
      const q = pgq();
      for (const doc of docs) {
        const {
          _id, shopId, appointmentId, vehicleId, vin, customerId, customerName,
          customerPhone, status, promisedTime, serviceAdvisorId, technicianId,
          concern, mileageIn, createdAt, updatedAt, ...rest
        } = doc as any;
        const aid = num(appointmentId);
        if (shopId === undefined || shopId === null || aid === null) continue;
        await q`
          INSERT INTO autovitals_appointments (shop_id, appointment_id, vehicle_id, vin,
            customer_id, customer_name, customer_phone, status, promised_time,
            service_advisor_id, technician_id, concern, mileage_in, payload,
            created_at, updated_at)
          VALUES (${String(shopId)}, ${aid}, ${num(vehicleId)}, ${vin ?? null},
            ${num(customerId)}, ${customerName ?? null}, ${customerPhone ?? null},
            ${status ?? null}, ${promisedTime ?? null}, ${num(serviceAdvisorId)},
            ${num(technicianId)}, ${concern ?? null}, ${num(mileageIn)},
            ${Object.keys(rest).length ? j(rest) : null},
            ${d(createdAt) ?? new Date()}, ${d(updatedAt) ?? new Date()})
          ON CONFLICT (shop_id, appointment_id) DO UPDATE SET
            vehicle_id = EXCLUDED.vehicle_id, vin = EXCLUDED.vin,
            customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
            customer_phone = EXCLUDED.customer_phone, status = EXCLUDED.status,
            promised_time = EXCLUDED.promised_time,
            service_advisor_id = EXCLUDED.service_advisor_id,
            technician_id = EXCLUDED.technician_id, concern = EXCLUDED.concern,
            mileage_in = EXCLUDED.mileage_in, payload = EXCLUDED.payload,
            updated_at = EXCLUDED.updated_at
        `;
      }
    },
  },
  {
    key: "autovitals_inspections",
    mongoName: "autovitals_inspections",
    async upsert(docs) {
      const q = pgq();
      for (const doc of docs) {
        const {
          _id, shopId, appointmentId, inspectionResultId, completedAt,
          technicianId, technicianName, items, createdAt, updatedAt, ...rest
        } = doc as any;
        const aid = num(appointmentId);
        if (shopId === undefined || shopId === null || aid === null) continue;
        await q`
          INSERT INTO autovitals_inspections (shop_id, appointment_id,
            inspection_result_id, completed_at, technician_id, technician_name,
            items, payload, created_at, updated_at)
          VALUES (${String(shopId)}, ${aid}, ${num(inspectionResultId)},
            ${completedAt != null ? String(completedAt) : null}, ${num(technicianId)},
            ${technicianName ?? null}, ${j(items)},
            ${Object.keys(rest).length ? j(rest) : null},
            ${d(createdAt) ?? new Date()}, ${d(updatedAt) ?? new Date()})
          ON CONFLICT (shop_id, appointment_id) DO UPDATE SET
            inspection_result_id = EXCLUDED.inspection_result_id,
            completed_at = EXCLUDED.completed_at,
            technician_id = EXCLUDED.technician_id,
            technician_name = EXCLUDED.technician_name,
            items = EXCLUDED.items, payload = EXCLUDED.payload,
            updated_at = EXCLUDED.updated_at
        `;
      }
    },
  },
];

async function ensureStateTable(): Promise<void> {
  await pgq()`
    CREATE TABLE IF NOT EXISTS integration_ops_backfill_state (
      spec text PRIMARY KEY,
      last_id text,
      migrated bigint DEFAULT 0 NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL
    )
  `;
}

async function loadCheckpoint(spec: string): Promise<{ lastId: string | null; migrated: number }> {
  if (restart) return { lastId: null, migrated: 0 };
  const rows = await pgq()`
    SELECT last_id, migrated FROM integration_ops_backfill_state WHERE spec = ${spec}
  `;
  return rows.length
    ? { lastId: (rows[0].last_id as string) ?? null, migrated: Number(rows[0].migrated) }
    : { lastId: null, migrated: 0 };
}

async function saveCheckpoint(spec: string, lastId: string, migrated: number): Promise<void> {
  await pgq()`
    INSERT INTO integration_ops_backfill_state (spec, last_id, migrated, updated_at)
    VALUES (${spec}, ${lastId}, ${migrated}, now())
    ON CONFLICT (spec) DO UPDATE SET
      last_id = EXCLUDED.last_id, migrated = EXCLUDED.migrated, updated_at = now()
  `;
}

async function runSpec(spec: Spec): Promise<void> {
  const mongo = await getMongo();
  const col = mongo.collection(spec.mongoName);
  const total = await col.estimatedDocumentCount();
  let { lastId, migrated } = await loadCheckpoint(spec.key);
  console.log(
    `[${spec.key}] starting — ~${total} docs in Mongo, resume-from=${lastId ?? "<begin>"}, already-migrated=${migrated}`,
  );

  for (;;) {
    const filter: Document = lastId ? { _id: { $gt: new ObjectId(lastId) } } : {};
    const docs = await col.find(filter).sort({ _id: 1 }).limit(BATCH).toArray();
    if (docs.length === 0) break;
    await spec.upsert(docs);
    migrated += docs.length;
    lastId = String(docs[docs.length - 1]._id);
    await saveCheckpoint(spec.key, lastId, migrated);
    console.log(`[${spec.key}] migrated=${migrated} last_id=${lastId}`);
  }
  console.log(`[${spec.key}] DONE — migrated=${migrated}`);
}

async function main() {
  await ensureStateTable();
  const specs = only ? SPECS.filter((s) => only.includes(s.key)) : SPECS;
  if (only && specs.length !== only.length) {
    const known = new Set(SPECS.map((s) => s.key));
    throw new Error(`Unknown --only spec(s): ${only.filter((k) => !known.has(k)).join(",")}`);
  }
  for (const spec of specs) await runSpec(spec);
  console.log("All specs complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed (safe to re-run — resumes from checkpoint):", err);
  process.exit(1);
});
