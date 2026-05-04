/**
 * Wave 1 Mongo↔Postgres parity report (task #342).
 *
 * Captures per-collection row counts and a small spot-sample diff
 * (first N keys present in PG but missing from Mongo, and vice-versa).
 * Output is written to:
 *
 *   docs/db-migration-audit-log/wave1-parity-<ISO>.json
 *
 * and a one-line summary is appended to
 *
 *   docs/db-migration-audit-log/wave1-parity.log
 *
 * so that the read-cutover sign-off has a concrete artifact in repo.
 *
 * Usage:
 *   pnpm tsx scripts/wave1-parity-report.ts            # all 15 entities
 *   pnpm tsx scripts/wave1-parity-report.ts --only=ratelimits,viewed_vins
 *   pnpm tsx scripts/wave1-parity-report.ts --sample=20
 */
import "dotenv/config";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getDb as getMongo } from "@/lib/mongo";
import { getDb as getPg } from "@/lib/db/drizzle";
import { sql } from "drizzle-orm";

type EntitySpec = {
  name: string;
  pgTable: string;
  /** Field(s) used to spot-check existence across stores. */
  sampleKey: (doc: Record<string, unknown>) => string;
  /** SQL projecting the same key from PG. */
  pgSampleSql: string;
};

const ENTITIES: EntitySpec[] = [
  { name: "ratelimits", pgTable: "ratelimits", sampleKey: (d) => String(d.bucketKey ?? d._id), pgSampleSql: "bucket_key" },
  { name: "viewed_vins", pgTable: "viewed_vins", sampleKey: (d) => `${d.shopId}:${d.vin}:${d.roNumber ?? ""}`, pgSampleSql: "shop_id || ':' || vin || ':' || COALESCE(ro_number_key,'')" },
  { name: "sync_metrics", pgTable: "sync_metrics", sampleKey: (d) => String(d._id), pgSampleSql: "id::text" },
  { name: "ingestion_errors", pgTable: "ingestion_errors", sampleKey: (d) => `${d.workerType}:${d.entityType}:${d.entityId}`, pgSampleSql: "worker_type || ':' || entity_type || ':' || entity_id" },
  { name: "extension_analytics", pgTable: "extension_analytics", sampleKey: (d) => String(d._id), pgSampleSql: "id::text" },
  { name: "data_quality_reports", pgTable: "data_quality_reports", sampleKey: (d) => String(d._id), pgSampleSql: "id::text" },
  { name: "system_announcements", pgTable: "system_announcements", sampleKey: (d) => String(d._id), pgSampleSql: "id" },
  { name: "knowledge_articles", pgTable: "knowledge_articles", sampleKey: (d) => String(d._id), pgSampleSql: "id" },
  { name: "dataone_cache", pgTable: "dataone_cache", sampleKey: (d) => String(d.squish), pgSampleSql: "squish" },
  { name: "dataone_oe", pgTable: "dataone_oe", sampleKey: (d) => `${d.shopId}:${d.vin}`, pgSampleSql: "shop_id || ':' || vin" },
  { name: "lkp_ymm_maintenance_interval", pgTable: "lkp_ymm_maintenance_interval", sampleKey: (d) => String(d._id), pgSampleSql: "id::text" },
  { name: "def_maintenance_event", pgTable: "def_maintenance_event", sampleKey: (d) => String(d.eventCode ?? d._id), pgSampleSql: "event_code" },
  { name: "dataone_lkp_squish_maintenance", pgTable: "dataone_lkp_squish_maintenance", sampleKey: (d) => `${d.squish}:${d.vinMaintenanceId}:${d.maintenanceId}`, pgSampleSql: "squish || ':' || vin_maintenance_id || ':' || maintenance_id" },
  { name: "part_cross_ref", pgTable: "part_cross_ref", sampleKey: (d) => `${d.shopId}:${d.normalizedPartNumber}`, pgSampleSql: "shop_id || ':' || normalized_part_number" },
  { name: "sms_historical_work_orders", pgTable: "sms_historical_work_orders", sampleKey: (d) => `${d.shopId}:${d.sourceSystem}:${d.workOrderId}`, pgSampleSql: "shop_id || ':' || source_system || ':' || work_order_id" },
];

type EntityReport = {
  entity: string;
  mongoCount: number;
  pgCount: number;
  countDelta: number;
  sampledMongoKeys: number;
  missingFromPg: string[];
  missingFromMongo: string[];
};

function parseArgs() {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
  const sample = Number(args.find((a) => a.startsWith("--sample="))?.slice(9) ?? "10");
  return { only, sample };
}

async function reportEntity(spec: EntitySpec, sample: number): Promise<EntityReport> {
  const mongo = await getMongo();
  const pg = getPg();

  const mongoCount = await mongo.collection(spec.name).countDocuments();
  const pgCountRow = (await pg.execute(sql.raw(`SELECT COUNT(*)::int AS c FROM ${spec.pgTable}`))) as unknown as { c: number }[];
  const pgCount = Number(pgCountRow[0]?.c ?? 0);

  // Spot sample: take N most-recent Mongo docs, look them up in PG.
  const mongoSample = await mongo.collection(spec.name).find({}).sort({ _id: -1 }).limit(sample).toArray();
  const mongoKeys = mongoSample.map((d) => spec.sampleKey(d as Record<string, unknown>));
  const pgKeyRows = (await pg.execute(
    sql.raw(`SELECT ${spec.pgSampleSql} AS k FROM ${spec.pgTable} ORDER BY 1 DESC LIMIT ${sample * 4}`),
  )) as unknown as { k: string }[];
  const pgKeySet = new Set(pgKeyRows.map((r) => String(r.k)));
  const missingFromPg = mongoKeys.filter((k) => !pgKeySet.has(k));

  // And the reverse: does PG have keys Mongo doesn't?
  const pgSample = (await pg.execute(
    sql.raw(`SELECT ${spec.pgSampleSql} AS k FROM ${spec.pgTable} ORDER BY 1 DESC LIMIT ${sample}`),
  )) as unknown as { k: string }[];
  const mongoKeySetForReverse = new Set(mongoKeys);
  const missingFromMongo = pgSample
    .map((r) => String(r.k))
    .filter((k) => !mongoKeySetForReverse.has(k))
    .slice(0, sample);

  return {
    entity: spec.name,
    mongoCount,
    pgCount,
    countDelta: pgCount - mongoCount,
    sampledMongoKeys: mongoKeys.length,
    missingFromPg,
    missingFromMongo,
  };
}

async function main() {
  const { only, sample } = parseArgs();
  const targets = only ? ENTITIES.filter((e) => only.includes(e.name)) : ENTITIES;
  if (targets.length === 0) {
    console.error("No matching entities for --only filter.");
    process.exit(2);
  }

  const reports: EntityReport[] = [];
  for (const spec of targets) {
    process.stderr.write(`[parity] ${spec.name}…\n`);
    try {
      reports.push(await reportEntity(spec, sample));
    } catch (err) {
      console.error(`[parity] ${spec.name} FAILED:`, err);
      reports.push({
        entity: spec.name,
        mongoCount: -1,
        pgCount: -1,
        countDelta: 0,
        sampledMongoKeys: 0,
        missingFromPg: [],
        missingFromMongo: [],
      });
    }
  }

  const outDir = join(process.cwd(), "docs", "db-migration-audit-log");
  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(outDir, `wave1-parity-${ts}.json`);
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), sampleSize: sample, reports }, null, 2));

  const summary = reports
    .map((r) =>
      `${r.entity} mongo=${r.mongoCount} pg=${r.pgCount} delta=${r.countDelta} ` +
      `sampleMissingInPg=${r.missingFromPg.length}/${r.sampledMongoKeys}`,
    )
    .join("\n");
  console.log(summary);
  appendFileSync(join(outDir, "wave1-parity.log"), `\n=== ${new Date().toISOString()} ===\n${summary}\n`);
  console.error(`\n[parity] full report written to ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
