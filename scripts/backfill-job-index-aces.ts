// scripts/backfill-job-index-aces.ts
//
// Task #382 — Source-table-driven historical rebuild for the ACES corpus.
//
// Phases (in order, all idempotent + resumable, safe to ctrl-c & re-run):
//
//   A. SOURCE-TABLE REINDEX
//      Drives from the four historical source tables — tekmetric_work_orders,
//      shopware_repair_orders, protractor_work_orders, sms_historical_work_orders
//      — as the source of truth. For each RO not already represented in the
//      Mongo `job_index` collection, calls the appropriate live indexer to
//      create the missing entries:
//        - Tekmetric → indexTekmetricWorkOrderJobs (uses cached jobs, no API)
//        - Protractor → extractJobIndexFromWorkOrder + upsertJobIndexEntries
//        - SMS hist  → extractJobIndexFromWorkOrder ('protractor' parser, the
//                       SMS payloads are Protractor-shaped)
//        - Shop-Ware → counted-only; SW reindex requires the full
//                       NormalizedIngestionService pipeline and a live SW
//                       sync, so we log the gap and an operator runs the
//                       SW catch-up cron. Coverage report makes this visible.
//
//   B. ACES ENRICHMENT
//      Walks every Mongo `job_index` doc whose `vehicle.acesDecodedAt` is
//      missing, recovers the VIN from the source table when needed, batch-
//      decodes via DataOne, and writes the four ACES fields back. For Tek
//      and SW also rebuilds the per-job `lines[]` with PCDB / PartsTech IDs
//      attached on each part line.
//
//   C. PG `job_index` MIRROR
//      Mirrors the (now-enriched) Mongo job_index ACES IDs into the PG
//      `job_index.aces_vehicle_id` / `aces_engine_id` columns. Joins on
//      backfill_mongo_id (the canonical link populated by
//      scripts/wave1-mongo-to-pg-backfill.ts) so PG and Mongo stay in sync.
//      Skipped silently when no PG rows match — the PG mirror is populated
//      by the wave-1 backfill, not by this script.
//
// Idempotent + resumable: `vehicle.acesDecodedAt` is the resume marker for
// phase B; phase A skips ROs already in job_index; phase C is an UPDATE
// using a static WHERE that's safe to re-run.
//
//   Usage:  npm run backfill:job-index-aces -- [--shop 12345] [--limit 5000]
//                                              [--dry-run] [--skip-reindex]
//                                              [--skip-pg-mirror] [--skip-vin-recovery]
//
// `--skip-vin-recovery` skips Phase A2 (the PG `normalized_work_orders` VIN
// recovery against the *app* Postgres). Combine with --skip-reindex +
// --skip-pg-mirror to run only Phase B (job_index ACES decode), avoiding all
// app-Postgres load. NOTE: this does NOT make the run Postgres-free — Phase B
// decodes VINs against the DataOne dataset, which is itself a Postgres DB
// (DATAONE_DATABASE_URL, see lib/integrations/dataone-local.ts). If that
// endpoint is connection-saturated, the decode still fails. Run off-peak.

import { getDb } from "@/lib/mongo";
import {
  enrichVinsWithAcesStrict,
  extractTekmetricPcdb,
  extractShopWarePcdb,
} from "@/lib/job-index-aces";
import { pingDataOneDb } from "@/lib/integrations/dataone-local";
import { extractJobIndexFromWorkOrder, upsertJobIndexEntries } from "@/lib/job-index";
import { indexTekmetricWorkOrderJobs } from "@/lib/integrations/tekmetric/job-index";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";
import { shopWareAdapter } from "@/lib/integrations/shopware";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { jobIndex as pgJobIndex } from "@/lib/db/schema/wave3";
import { normalizedWorkOrders, normalizedVehicles } from "@/lib/db/schema/normalized";
import { eq, sql, and, isNotNull, isNull } from "drizzle-orm";

const BATCH_SIZE = 500;
const REINDEX_PAGE = 200;
const SOURCE_COLLECTIONS: ReadonlyArray<{
  name: string;
  vinPaths: string[];
  woIdPaths: string[];
}> = [
  { name: "tekmetric_work_orders", vinPaths: ["vehicle.vin", "data.vehicle.vin", "vin"], woIdPaths: ["workOrderId", "id", "data.id"] },
  { name: "shopware_repair_orders", vinPaths: ["vehicle.vin", "data.vehicle.vin", "vin"], woIdPaths: ["workOrderId", "id"] },
  { name: "protractor_work_orders", vinPaths: ["vehicle.VIN", "vehicle.vin", "VIN", "vin"], woIdPaths: ["workOrderId", "Header.ID", "id"] },
  { name: "sms_historical_work_orders", vinPaths: ["vin", "vehicle.vin"], woIdPaths: ["workOrderId", "id"] },
];

interface CliFlags {
  shopId: number | null;
  limit: number | null;
  dryRun: boolean;
  skipReindex: boolean;
  skipPgMirror: boolean;
  skipVinRecovery: boolean;
}

function parseFlags(): CliFlags {
  const argv = process.argv.slice(2);
  const flags: CliFlags = { shopId: null, limit: null, dryRun: false, skipReindex: false, skipPgMirror: false, skipVinRecovery: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--shop" && argv[i + 1]) flags.shopId = Number(argv[++i]);
    else if (argv[i] === "--limit" && argv[i + 1]) flags.limit = Number(argv[++i]);
    else if (argv[i] === "--dry-run") flags.dryRun = true;
    else if (argv[i] === "--skip-reindex") flags.skipReindex = true;
    else if (argv[i] === "--skip-pg-mirror") flags.skipPgMirror = true;
    else if (argv[i] === "--skip-vin-recovery") flags.skipVinRecovery = true;
  }
  return flags;
}

function getNested(obj: any, path: string): any {
  if (!obj) return undefined;
  let cur: any = obj;
  for (const p of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function vinFromSourceDoc(srcDoc: any, paths: string[]): string | null {
  for (const p of paths) {
    const v = getNested(srcDoc, p);
    if (typeof v === "string" && v.length >= 11) return v;
  }
  return null;
}

function woIdFromSourceDoc(srcDoc: any, paths: string[]): string | null {
  for (const p of paths) {
    const v = getNested(srcDoc, p);
    if (v != null) return String(v);
  }
  return srcDoc._id ? String(srcDoc._id) : null;
}

async function findSourceWorkOrder(
  db: Awaited<ReturnType<typeof getDb>>,
  shopId: number,
  workOrderId: string,
): Promise<{ collection: string; doc: any } | null> {
  for (const src of SOURCE_COLLECTIONS) {
    const doc = await db.collection(src.name).findOne({
      $and: [
        { $or: [{ shopId }, { shopId: String(shopId) }] },
        { $or: [{ workOrderId }, { workOrderId: Number(workOrderId) }, { id: workOrderId }, { id: Number(workOrderId) }, { _id: workOrderId }] },
      ],
    });
    if (doc) return { collection: src.name, doc };
  }
  return null;
}

function rebuildTekmetricLines(srcDoc: any, servicePackageId: string): any[] | null {
  const jobs = Array.isArray(srcDoc?.data?.jobs) ? srcDoc.data.jobs : [];
  const job = jobs.find((j: any) => String(j.id) === String(servicePackageId));
  if (!job) return null;
  const lines: any[] = [];
  for (const labor of (Array.isArray(job.labor) ? job.labor : [])) {
    const hours = labor.hours || 0;
    const rate = (labor.rate || 0) / 100;
    lines.push({ lineType: "labor", description: labor.name || job.name, quantity: 1, unitPrice: rate, extendedPrice: hours * rate, hours });
  }
  for (const part of (Array.isArray(job.parts) ? job.parts : [])) {
    const qty = part.quantity || 1;
    const unit = (part.retail || part.cost || 0) / 100;
    lines.push({ lineType: "part", description: part.name || part.description || "", partNumber: part.partNumber, manufacturer: part.brand, quantity: qty, unitPrice: unit, extendedPrice: qty * unit, ...extractTekmetricPcdb(part) });
  }
  return lines;
}

function rebuildShopWareLines(srcDoc: any, serviceItemId: string): any[] | null {
  const items = Array.isArray(srcDoc?.service_items) ? srcDoc.service_items : [];
  const item = items.find((i: any) => String(i.id) === String(serviceItemId));
  if (!item) return null;
  const lines: any[] = [];
  for (const labor of (Array.isArray(item.labors) ? item.labors : [])) {
    lines.push({ lineType: "labor", description: labor.name, quantity: 1, unitPrice: 0, extendedPrice: 0, hours: labor.hours });
  }
  for (const part of (Array.isArray(item.parts) ? item.parts : [])) {
    const qty = part.quantity || 1;
    const unit = (part.sell_price_cents ?? 0) / 100;
    lines.push({ lineType: "part", description: part.description || part.name || "", partNumber: part.number || part.part_number || part.partNumber, manufacturer: part.brand, quantity: qty, unitPrice: unit, extendedPrice: qty * unit, ...extractShopWarePcdb(part) });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Phase A — source-table-driven reindex
// ---------------------------------------------------------------------------

async function reindexFromSourceTables(
  db: Awaited<ReturnType<typeof getDb>>,
  flags: CliFlags,
): Promise<void> {
  if (flags.skipReindex) {
    console.log("[backfill-aces] Phase A: skipped (--skip-reindex)");
    return;
  }
  console.log("[backfill-aces] Phase A: source-table reindex");
  const jobIndex = db.collection("job_index");

  for (const src of SOURCE_COLLECTIONS) {
    const filter: any = {};
    if (flags.shopId !== null) filter.$or = [{ shopId: flags.shopId }, { shopId: String(flags.shopId) }];
    const total = await db.collection(src.name).countDocuments(filter);
    console.log(`  ${src.name}: scanning ${total} ROs`);

    let scanned = 0;
    let reindexed = 0;
    let alreadyIndexed = 0;
    let skippedShopWare = 0;

    const cursor = db.collection(src.name).find(filter).batchSize(REINDEX_PAGE);
    for await (const srcDoc of cursor) {
      scanned++;
      const woId = woIdFromSourceDoc(srcDoc, src.woIdPaths);
      const shopId = Number(srcDoc.shopId);
      if (!woId || !Number.isFinite(shopId)) continue;

      const exists = await jobIndex.findOne(
        { shopId: { $in: [shopId, String(shopId)] }, workOrderId: woId },
        { projection: { _id: 1 } },
      );
      if (exists) { alreadyIndexed++; continue; }

      if (flags.dryRun) { reindexed++; continue; }

      try {
        if (src.name === "tekmetric_work_orders") {
          const shopDoc = await db.collection("shops").findOne(
            { shopId: { $in: [shopId, String(shopId)] } },
            { projection: { "tekmetric.shopId": 1, tekmetricShopId: 1 } },
          );
          const tekShopId = shopDoc?.tekmetric?.shopId || (shopDoc as any)?.tekmetricShopId;
          if (!tekShopId) continue;
          const data = srcDoc.data || srcDoc;
          const veh = data.vehicle || {};
          const vin = vinFromSourceDoc(srcDoc, src.vinPaths);
          await indexTekmetricWorkOrderJobs(
            shopId,
            Number(tekShopId),
            Number(woId),
            data.repairOrderNumber || 0,
            { vin: vin ?? undefined, year: veh.year, make: veh.make, model: veh.model, engine: veh.engine },
            data.completedDate || data.updatedDate || data.createdDate || new Date().toISOString(),
            data.mileageOut || data.mileageIn || null,
            { indexedVia: "backfill" },
          );
          reindexed++;
        } else if (src.name === "protractor_work_orders" || src.name === "sms_historical_work_orders") {
          const entries = extractJobIndexFromWorkOrder(shopId, srcDoc.data || srcDoc, "protractor");
          if (entries.length > 0) {
            await upsertJobIndexEntries(entries);
            reindexed++;
          }
        } else if (src.name === "shopware_repair_orders") {
          // SW reindex via NormalizedIngestionService.writeToJobIndex (made
          // public for this rebuild). We instantiate per shop with the
          // Shop-Ware adapter, extract the service-job list from the raw RO
          // payload, and write the missing job_index entries directly. This
          // bypasses the full normalize pipeline (we don't need to upsert
          // the underlying NWO/customer/vehicle rows again — those came in
          // through the original SW sync) but still produces job_index
          // entries with ACES + per-line PCDB attached via the existing
          // dual-write code path.
          const enterpriseId = (srcDoc.enterpriseId as string | undefined) ?? null;
          const svc = new NormalizedIngestionService(
            db,
            "shopware" as any,
            shopId,
            enterpriseId,
            {},
            shopWareAdapter,
          );
          const sw = srcDoc.data || srcDoc;
          const serviceJobs = shopWareAdapter.extractServiceJobsFromWorkOrder(sw);
          if (serviceJobs.length > 0) {
            await svc.writeToJobIndex(sw, serviceJobs);
            reindexed++;
          }
        }
      } catch (err) {
        console.warn(`    reindex failed for ${src.name}/${woId}: ${(err as Error).message || err}`);
      }
    }

    console.log(`    scanned=${scanned} alreadyIndexed=${alreadyIndexed} reindexed=${reindexed}${skippedShopWare ? ` skippedSW=${skippedShopWare} (run SW catch-up cron)` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Phase A2 — VIN recovery for normalized_work_orders (PG)
// ---------------------------------------------------------------------------
//
// Task #382 explicitly calls for recovering missing VINs on normalized
// work orders before ACES enrichment runs. Walks the PG
// `normalized_work_orders` table for rows whose `vehicle->>vin` is null
// or empty, looks the RO up in the matching Mongo source table, and
// writes the recovered VIN into both NWO (vehicle.vin jsonb path) and the
// linked normalized_vehicles row when present. Read-only on source tables.

async function recoverNormalizedWorkOrderVins(
  db: Awaited<ReturnType<typeof getDb>>,
  flags: CliFlags,
): Promise<void> {
  console.log("[backfill-aces] Phase A2: normalized_work_orders VIN recovery");
  const pg = getPgDb();
  const baseWhere = flags.shopId !== null
    ? and(
        eq(normalizedWorkOrders.shopId, flags.shopId),
        sql`(${normalizedWorkOrders.vehicle}->>'vin' IS NULL OR ${normalizedWorkOrders.vehicle}->>'vin' = '')`,
      )
    : sql`(${normalizedWorkOrders.vehicle}->>'vin' IS NULL OR ${normalizedWorkOrders.vehicle}->>'vin' = '')`;

  const rows = await pg
    .select({
      id: normalizedWorkOrders.id,
      shopId: normalizedWorkOrders.shopId,
      workOrderNumber: normalizedWorkOrders.workOrderNumber,
      vehicle: normalizedWorkOrders.vehicle,
      vehicleId: normalizedWorkOrders.vehicleId,
    })
    .from(normalizedWorkOrders)
    .where(baseWhere as any)
    .limit(flags.limit ?? 50000);

  console.log(`  candidates without VIN: ${rows.length}`);
  let recoveredNwo = 0, recoveredNv = 0, notFound = 0;

  for (const row of rows) {
    const src = await findSourceWorkOrder(db, row.shopId, row.workOrderNumber);
    if (!src) { notFound++; continue; }
    const cfg = SOURCE_COLLECTIONS.find((s) => s.name === src.collection);
    const vin = cfg ? vinFromSourceDoc(src.doc, cfg.vinPaths) : null;
    if (!vin) { notFound++; continue; }
    if (!flags.dryRun) {
      const vehicleObj = (row.vehicle as Record<string, unknown> | null) ?? {};
      await pg
        .update(normalizedWorkOrders)
        .set({ vehicle: { ...vehicleObj, vin } })
        .where(eq(normalizedWorkOrders.id, row.id));
      // Also patch the linked normalized_vehicles row when FK present and
      // its own vin is empty — the NV row is what the ACES enrichment pass
      // (Phase B / scripts/backfill-normalized-vehicles-aces.ts) actually
      // reads, so leaving NV.vin null would strand the ACES backfill.
      if (row.vehicleId) {
        const updated = await pg
          .update(normalizedVehicles)
          .set({ vin })
          .where(and(
            eq(normalizedVehicles.id, row.vehicleId),
            sql`(${normalizedVehicles.vin} IS NULL OR ${normalizedVehicles.vin} = '')`,
          ) as any)
          .returning({ id: normalizedVehicles.id });
        if (updated.length > 0) recoveredNv++;
      }
    }
    recoveredNwo++;
  }
  console.log(`  Phase A2 DONE — recoveredNwo=${recoveredNwo} recoveredNv=${recoveredNv} notFound=${notFound}`);
}

// ---------------------------------------------------------------------------
// Phase B — ACES enrichment of Mongo job_index docs
// ---------------------------------------------------------------------------

async function enrichJobIndexAces(
  db: Awaited<ReturnType<typeof getDb>>,
  flags: CliFlags,
): Promise<void> {
  console.log("[backfill-aces] Phase B: ACES enrichment");

  // Preflight: confirm DataOne (a Postgres DB) is reachable BEFORE we mutate any
  // doc. At peak the DataOne/app Postgres can refuse connections (error 53300);
  // if we ran anyway, every batch would decode to empty and we'd stamp the whole
  // corpus "unresolvable", poisoning the resume marker. Abort loudly instead.
  if (!flags.dryRun) {
    const dataOneUp = await pingDataOneDb();
    if (!dataOneUp) {
      throw new Error(
        "[backfill-aces] ABORT: DataOne Postgres is unreachable (likely connection-saturated). " +
          "Refusing to run Phase B — it would stamp acesDecodedAt on undecoded docs and poison the " +
          "resume marker. Re-run off-peak. See docs/runbooks/job-index-aces-pcdb-parity.md.",
      );
    }
  }

  const collection = db.collection("job_index");
  const baseFilter: any = { "vehicle.acesDecodedAt": { $exists: false } };
  if (flags.shopId !== null) baseFilter.shopId = flags.shopId;

  const totalToProcess = await collection.countDocuments(baseFilter);
  const cap = flags.limit ?? totalToProcess;
  console.log(`  target=${totalToProcess} (cap=${cap})`);

  let processed = 0, acesEnriched = 0, vinRecovered = 0, unresolvable = 0, linesRebuilt = 0;

  while (processed < cap) {
    const pageSize = Math.min(BATCH_SIZE, cap - processed);
    const docs = await collection
      .find(baseFilter, { projection: { _id: 1, shopId: 1, workOrderId: 1, servicePackageId: 1, vehicle: 1, source: 1 } })
      .limit(pageSize)
      .toArray();
    if (docs.length === 0) break;

    const sourceCache = new Map<string, { collection: string; doc: any }>();
    for (const doc of docs) {
      const cacheKey = `${doc.shopId}:${doc.workOrderId}`;
      if (!sourceCache.has(cacheKey) && doc.shopId && doc.workOrderId) {
        const src = await findSourceWorkOrder(db, Number(doc.shopId), String(doc.workOrderId));
        if (src) {
          sourceCache.set(cacheKey, src);
          if (!doc.vehicle?.vin) {
            const cfg = SOURCE_COLLECTIONS.find((s) => s.name === src.collection);
            const recovered = cfg ? vinFromSourceDoc(src.doc, cfg.vinPaths) : null;
            if (recovered) { (doc as any)._recoveredVin = recovered; vinRecovered++; }
          }
        }
      }
    }

    const vinList = docs
      .map((d) => (d.vehicle?.vin as string | undefined) || (d as any)._recoveredVin)
      .filter((v): v is string => typeof v === "string" && v.length >= 11);
    // Strict decode: if DataOne fails mid-run (connection dropped / saturated),
    // this THROWS instead of returning empty. We abort the whole run BEFORE
    // writing this batch so we never stamp acesDecodedAt on docs we couldn't
    // actually decode (which would skip them forever). A successful decode with
    // no match for a given VIN is still legitimately "unresolvable".
    let enrichments: Awaited<ReturnType<typeof enrichVinsWithAcesStrict>>;
    try {
      enrichments = vinList.length > 0 ? await enrichVinsWithAcesStrict(vinList) : new Map();
    } catch (err) {
      throw new Error(
        `[backfill-aces] ABORT after processed=${processed}: DataOne decode failed mid-run ` +
          `(${(err as Error)?.message || err}). Stopping WITHOUT stamping this batch to avoid ` +
          `poisoning the resume marker. Re-run off-peak.`,
      );
    }

    const decodedAt = new Date();
    for (const doc of docs) {
      const vin = (doc.vehicle?.vin as string | undefined) || (doc as any)._recoveredVin;
      const enriched = vin ? enrichments.get(vin) : null;
      const update: Record<string, unknown> = { "vehicle.acesDecodedAt": enriched?.acesDecodedAt ?? decodedAt };
      if (vin && !doc.vehicle?.vin) update["vehicle.vin"] = vin;
      if (enriched) {
        update["vehicle.acesVehicleId"] = enriched.acesVehicleId;
        update["vehicle.acesEngineId"] = enriched.acesEngineId;
        update["vehicle.submodelKey"] = enriched.submodelKey;
        if (enriched.year != null) update["vehicle.year"] = enriched.year;
        if (enriched.make != null) update["vehicle.make"] = enriched.make;
        if (enriched.model != null) update["vehicle.model"] = enriched.model;
        if (enriched.acesVehicleId !== null || enriched.acesEngineId !== null) acesEnriched++;
        else unresolvable++;
      } else {
        update["vehicle.acesVehicleId"] = null;
        update["vehicle.acesEngineId"] = null;
        update["vehicle.submodelKey"] = null;
        unresolvable++;
      }

      const cacheKey = `${doc.shopId}:${doc.workOrderId}`;
      const src = sourceCache.get(cacheKey);
      if (src && doc.servicePackageId) {
        let rebuilt: any[] | null = null;
        if (src.collection === "tekmetric_work_orders") rebuilt = rebuildTekmetricLines(src.doc, String(doc.servicePackageId));
        else if (src.collection === "shopware_repair_orders") rebuilt = rebuildShopWareLines(src.doc, String(doc.servicePackageId));
        if (rebuilt && rebuilt.length > 0) { update["lines"] = rebuilt; linesRebuilt++; }
      }

      if (!flags.dryRun) await collection.updateOne({ _id: doc._id }, { $set: update });
    }

    processed += docs.length;
    console.log(`  processed=${processed}/${cap} acesEnriched=${acesEnriched} vinRecovered=${vinRecovered} linesRebuilt=${linesRebuilt} unresolvable=${unresolvable}`);
  }

  console.log(`  Phase B DONE — processed=${processed} acesEnriched=${acesEnriched} vinRecovered=${vinRecovered} linesRebuilt=${linesRebuilt} unresolvable=${unresolvable}`);
}

// ---------------------------------------------------------------------------
// Phase C — Mirror Mongo job_index ACES into PG job_index columns
// ---------------------------------------------------------------------------

async function mirrorAcesToPg(
  db: Awaited<ReturnType<typeof getDb>>,
  flags: CliFlags,
): Promise<void> {
  if (flags.skipPgMirror) {
    console.log("[backfill-aces] Phase C: skipped (--skip-pg-mirror)");
    return;
  }
  console.log("[backfill-aces] Phase C: mirror Mongo→PG job_index ACES");
  const pg = getPgDb();
  const collection = db.collection("job_index");

  const filter: any = { "vehicle.acesDecodedAt": { $exists: true }, $or: [{ "vehicle.acesVehicleId": { $ne: null } }, { "vehicle.acesEngineId": { $ne: null } }] };
  if (flags.shopId !== null) filter.shopId = flags.shopId;

  const total = await collection.countDocuments(filter);
  console.log(`  candidate Mongo docs with ACES: ${total}`);

  let mirrored = 0, missingPgRow = 0, scanned = 0;
  const cursor = collection.find(filter, { projection: { _id: 1, shopId: 1, vehicle: 1 } }).batchSize(500);

  for await (const doc of cursor) {
    scanned++;
    const mongoId = String(doc._id);
    const vid = doc.vehicle?.acesVehicleId ?? null;
    const eid = doc.vehicle?.acesEngineId ?? null;
    if (vid == null && eid == null) continue;

    if (flags.dryRun) { mirrored++; continue; }

    const result = await pg
      .update(pgJobIndex)
      .set({ acesVehicleId: vid, acesEngineId: eid })
      .where(eq(pgJobIndex.backfillMongoId, mongoId));
    const rowCount = (result as any).rowCount ?? 0;
    if (rowCount > 0) mirrored++;
    else missingPgRow++;

    if (scanned % 1000 === 0) console.log(`    scanned=${scanned} mirrored=${mirrored} missingPgRow=${missingPgRow}`);
  }

  console.log(`  Phase C DONE — scanned=${scanned} mirrored=${mirrored} missingPgRow=${missingPgRow}`);
  if (missingPgRow > 0) {
    console.log(`  NOTE: ${missingPgRow} Mongo docs had no matching PG job_index row (joined via backfill_mongo_id). Run scripts/wave1-mongo-to-pg-backfill.ts to populate PG first.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseFlags();
  const db = await getDb();
  console.log(`[backfill-aces] start shop=${flags.shopId ?? "ALL"} limit=${flags.limit ?? "ALL"} dryRun=${flags.dryRun}`);

  await reindexFromSourceTables(db, flags);
  if (flags.skipVinRecovery) {
    console.log("[backfill-aces] Phase A2: skipped (--skip-vin-recovery)");
  } else {
    await recoverNormalizedWorkOrderVins(db, flags);
  }
  await enrichJobIndexAces(db, flags);
  await mirrorAcesToPg(db, flags);

  console.log("[backfill-aces] all phases complete");
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-aces] FATAL:", err);
  process.exit(1);
});
