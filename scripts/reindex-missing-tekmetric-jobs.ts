/**
 * Recovery for the "webhook received but jobs never indexed" gap.
 *
 * Root cause (see .agents/memory/webhook-indexed-jobs-gap.md): the terminal
 * Tekmetric webhook only filed jobs into `job_index` when the cache row already
 * had a `vin`. The webhook payload carries `vehicleId`, not `vin`, and the
 * separate vehicle enrichment often lags or misses — so posted ROs were silently
 * skipped and their work never became searchable history. The plan/last-performed
 * layer then falls back to CARFAX, showing "last done via CARFAX" for work the
 * shop actually performed. Measured ~9% of posted ROs fleet-wide (up to ~26% at
 * some shops).
 *
 * This script re-files the already-missed ROs. For each posted RO that has
 * `data.jobs` but no `job_index` entry, it resolves the VIN (from the cache row
 * or, if missing, via Tekmetric `getVehicle`), persists it back onto the cache
 * row, then indexes the jobs from the stored payload (no /jobs API call needed).
 *
 * Detection is driven off `tekmetric_webhook_logs` (indexed on receivedAt) via a
 * server-side aggregation — never stream the window client-side (times out).
 *
 * NOTE: dev Mongo IS prod Mongo for this repl — --apply writes to live data.
 * Indexing is idempotent (upsert on shopId+workOrderId+servicePackageId), so
 * batches/reruns are safe.
 *
 * Usage:
 *   # single shop (dry run, then apply)
 *   npx tsx scripts/reindex-missing-tekmetric-jobs.ts --shop=32 --days=8
 *   npx tsx scripts/reindex-missing-tekmetric-jobs.ts --shop=32 --days=8 --apply
 *
 *   # fleet: detect once -> resumable recover batches
 *   npx tsx scripts/reindex-missing-tekmetric-jobs.ts --detect-all --days=8
 *   npx tsx scripts/reindex-missing-tekmetric-jobs.ts --from-file --offset=0   --limit=100 --apply
 *   npx tsx scripts/reindex-missing-tekmetric-jobs.ts --from-file --offset=100 --limit=100 --apply
 */

import fs from "fs";
import { MongoClient, Db } from "mongodb";
import { getVehicle } from "@/lib/integrations/tekmetric/client";
import { indexTekmetricWorkOrderJobs } from "@/lib/integrations/tekmetric/job-index";

const APPLY = process.argv.includes("--apply");
const DETECT_ALL = process.argv.includes("--detect-all");
const FROM_FILE = process.argv.includes("--from-file");
const flag = (name: string) => {
  const f = process.argv.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split("=")[1] : null;
};
const SHOP_ID = flag("shop") ? Number(flag("shop")) : null;
const DAYS = flag("days") ? Number(flag("days")) : 8;
const OFFSET = flag("offset") ? Number(flag("offset")) : 0;
const LIMIT = flag("limit") ? Number(flag("limit")) : 100;
const FILE = flag("file") || "/tmp/fleet_missing.json";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Miss = { internalShopId: number; tekShopId: number; name: string; roId: string };

async function connect(): Promise<{ client: MongoClient; db: Db }> {
  const user = process.env.MONGODB_USERNAME;
  const pass = process.env.MONGODB_PASSWORD;
  if (!user || !pass) throw new Error("Missing MONGODB_USERNAME / MONGODB_PASSWORD");
  const uri = `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(
    pass,
  )}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db("mos-maintenance-mvp") };
}

/** posted RO ids per tekmetric shop in the window (server-side aggregation). */
async function postedByTekShop(db: Db, tekShopId?: number): Promise<Map<number, string[]>> {
  const from = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
  const match: any = {
    receivedAt: { $gte: from },
    "data.shopId": tekShopId != null ? tekShopId : { $ne: null },
    eventType: { $regex: "posted", $options: "i" },
    "data.repairOrderNumber": { $ne: null },
    "data.id": { $ne: null },
  };
  const rows = await db.collection("tekmetric_webhook_logs").aggregate([
    { $match: match },
    { $group: { _id: { shop: "$data.shopId", ro: "$data.id" } } },
    { $group: { _id: "$_id.shop", ros: { $addToSet: "$_id.ro" } } },
  ], { allowDiskUse: true }).toArray();
  const map = new Map<number, string[]>();
  for (const r of rows) map.set(Number((r as any)._id), ((r as any).ros || []).map(String));
  return map;
}

/** tekShopId -> {internalShopId, name} for all Tekmetric shops. */
async function tekShopMap(db: Db): Promise<Map<number, { internalShopId: number; name: string }>> {
  const shops = await db.collection("shops")
    .find({ "tekmetric.shopId": { $ne: null } }, { projection: { shopId: 1, name: 1, "tekmetric.shopId": 1 } })
    .toArray();
  const map = new Map<number, { internalShopId: number; name: string }>();
  for (const s of shops as any[]) {
    map.set(Number(s.tekmetric.shopId), { internalShopId: Number(s.shopId), name: s.name });
  }
  return map;
}

/** which of postedIds are NOT yet in job_index for this internal shop. */
async function missingForShop(db: Db, internalShopId: number, postedIds: string[]): Promise<string[]> {
  if (postedIds.length === 0) return [];
  const idx = await db.collection("job_index")
    .find({ shopId: internalShopId, workOrderId: { $in: postedIds } }, { projection: { workOrderId: 1 } })
    .toArray();
  const have = new Set(idx.map((r: any) => String(r.workOrderId)));
  return postedIds.filter((id) => !have.has(id));
}

type RecoverStat = "filed" | "would_file" | "no_row" | "no_jobs" | "no_vin" | "error";

/** resolve VIN + index one RO. Returns status + jobs filed. */
async function recoverRO(db: Db, internalShopId: number, tekShopId: number, roId: string): Promise<{ status: RecoverStat; jobs: number; num?: any }> {
  const wo: any = (await db.collection("tekmetric_work_orders").findOne({ tekmetricShopId: tekShopId, workOrderId: String(roId) }))
    || (await db.collection("tekmetric_work_orders").findOne({ shopId: { $in: [String(internalShopId), internalShopId] }, workOrderId: String(roId) }));
  if (!wo) return { status: "no_row", jobs: 0 };
  const jobs = Array.isArray(wo.data?.jobs) ? wo.data.jobs : [];
  if (jobs.length === 0) return { status: "no_jobs", jobs: 0, num: wo.workOrderNumber };

  let vin: string | undefined = wo.vin;
  let year = wo.vehicleYear, make = wo.vehicleMake, model = wo.vehicleModel, engine = wo.vehicleEngine;
  const vehicleId = wo.data?.vehicleId ?? wo.vehicleId;

  if (!vin && vehicleId) {
    try {
      const v: any = await getVehicle(vehicleId, internalShopId);
      if (v?.vin) {
        vin = String(v.vin).toUpperCase();
        year = v.year ?? year; make = v.make ?? make; model = v.model ?? model; engine = v.engine ?? engine;
        if (APPLY) {
          const patch: any = { vin, updatedAt: new Date() };
          if (v.year != null) patch.vehicleYear = v.year;
          if (v.make) patch.vehicleMake = v.make;
          if (v.model) patch.vehicleModel = v.model;
          if (v.engine) patch.vehicleEngine = v.engine;
          await db.collection("tekmetric_work_orders").updateOne({ _id: wo._id }, { $set: patch });
        }
      }
      await sleep(120);
    } catch (err: any) {
      console.error(`    RO ${roId}: getVehicle(${vehicleId}) failed: ${err?.message || err}`);
      return { status: "error", jobs: 0, num: wo.workOrderNumber };
    }
  }
  if (!vin) return { status: "no_vin", jobs: 0, num: wo.workOrderNumber };

  if (!APPLY) return { status: "would_file", jobs: jobs.length, num: wo.workOrderNumber };

  const completedDate = wo.completedDate || wo.data?.completedDate || wo.data?.postedDate || wo.updatedDate || new Date().toISOString();
  const mileage = wo.odometer ?? wo.data?.milesOut ?? wo.data?.milesIn ?? null;
  try {
    const n = await indexTekmetricWorkOrderJobs(
      internalShopId, tekShopId, Number(roId), wo.workOrderNumber,
      { vin, year, make, model, engine }, completedDate, mileage,
      { indexedVia: "reindex", preloadedJobs: jobs },
    );
    await db.collection("tekmetric_work_orders").updateOne({ _id: wo._id }, { $set: { jobsIndexed: true } });
    return { status: "filed", jobs: n, num: wo.workOrderNumber };
  } catch (err: any) {
    console.error(`    RO ${roId}: index failed: ${err?.message || err}`);
    return { status: "error", jobs: 0, num: wo.workOrderNumber };
  }
}

async function runShop(db: Db, internalShopId: number, tekShopId: number, name: string, postedIds: string[]) {
  const missing = await missingForShop(db, internalShopId, postedIds);
  console.log(`shop ${internalShopId} "${name}" (tek ${tekShopId}): posted=${postedIds.length} missing=${missing.length}`);
  const tally: Record<string, number> = { filed: 0, would_file: 0, no_row: 0, no_jobs: 0, no_vin: 0, error: 0 };
  let jobsFiled = 0;
  for (const roId of missing) {
    const r = await recoverRO(db, internalShopId, tekShopId, roId);
    tally[r.status]++;
    jobsFiled += r.status === "filed" ? r.jobs : 0;
    if (r.status === "filed") console.log(`  filed RO ${roId} (#${r.num}): ${r.jobs} jobs`);
    else if (r.status === "would_file") console.log(`  [dry] would file RO ${roId} (#${r.num}): ${r.jobs} jobs`);
  }
  console.log(`  => ${JSON.stringify(tally)} jobsFiled=${jobsFiled}`);
  return { tally, jobsFiled };
}

async function main() {
  const { client, db } = await connect();

  // ---- DETECT FLEET: write the flat miss-list to a file ----
  if (DETECT_ALL) {
    console.log(`=== detect-all (last ${DAYS} days) ===`);
    const [posted, shops] = await Promise.all([postedByTekShop(db), tekShopMap(db)]);
    console.log(`tek shops with posted ROs: ${posted.size}`);
    const list: Miss[] = [];
    let noMap = 0;
    for (const [tekShopId, ids] of posted) {
      const s = shops.get(tekShopId);
      if (!s) { noMap++; continue; }
      const missing = await missingForShop(db, s.internalShopId, ids);
      for (const roId of missing) list.push({ internalShopId: s.internalShopId, tekShopId, name: s.name, roId });
    }
    fs.writeFileSync(FILE, JSON.stringify(list, null, 0));
    const byShop = new Map<number, number>();
    for (const m of list) byShop.set(m.internalShopId, (byShop.get(m.internalShopId) || 0) + 1);
    console.log(`total missing ROs: ${list.length} across ${byShop.size} shops (unmapped tek shops: ${noMap})`);
    console.log(`written to ${FILE}`);
    await client.close();
    return;
  }

  // ---- RECOVER FROM FILE: process a slice [OFFSET, OFFSET+LIMIT) ----
  if (FROM_FILE) {
    const all: Miss[] = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const slice = all.slice(OFFSET, OFFSET + LIMIT);
    console.log(`=== ${APPLY ? "APPLY" : "DRY"} from-file ${FILE}: total=${all.length} slice=[${OFFSET},${OFFSET + slice.length}) ===`);
    const tally: Record<string, number> = { filed: 0, would_file: 0, no_row: 0, no_jobs: 0, no_vin: 0, error: 0 };
    let jobsFiled = 0;
    for (const m of slice) {
      const r = await recoverRO(db, m.internalShopId, m.tekShopId, m.roId);
      tally[r.status]++;
      jobsFiled += r.status === "filed" ? r.jobs : 0;
      if (r.status === "filed") console.log(`  filed shop ${m.internalShopId} RO ${m.roId} (#${r.num}): ${r.jobs} jobs`);
    }
    console.log(`\nslice done: ${JSON.stringify(tally)} jobsFiled=${jobsFiled}`);
    if (OFFSET + LIMIT < all.length) console.log(`NEXT: --from-file --offset=${OFFSET + LIMIT} --limit=${LIMIT} --apply`);
    else console.log("ALL SLICES COMPLETE.");
    await client.close();
    return;
  }

  // ---- SINGLE SHOP ----
  if (!SHOP_ID) { console.error("Provide --shop=N, or --detect-all, or --from-file"); await client.close(); process.exit(1); }
  console.log(`=== single shop ${SHOP_ID} (${APPLY ? "APPLY" : "DRY"}), last ${DAYS} days ===`);
  const shops = await tekShopMap(db);
  const entry = [...shops.entries()].find(([, v]) => v.internalShopId === SHOP_ID);
  if (!entry) { console.error(`Shop ${SHOP_ID} has no tekmetric.shopId`); await client.close(); process.exit(1); }
  const [tekShopId, meta] = entry;
  const posted = await postedByTekShop(db, tekShopId);
  await runShop(db, SHOP_ID, tekShopId, meta.name, posted.get(tekShopId) || []);
  await client.close();
}

main().catch((err) => { console.error("FAILED:", err); process.exit(1); });
