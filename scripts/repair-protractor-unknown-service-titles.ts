/**
 * Task #891 repair: re-title `normalized_service_jobs` rows stuck at
 * 'Unknown Service' for Protractor shops.
 *
 * Background
 * ----------
 * The Protractor normalized adapter's `mapServiceJob` built the title from
 * `sp.Name || sp.Description || sp.ServiceDescription` and never checked
 * `sp.ServicePackageHeader?.Title` — the field where Protractor actually
 * carries the service name. Every ingested row therefore landed as
 * 'Unknown Service' (shop 66: 8,454/8,454 rows). The adapter is now fixed,
 * so newly ingested rows get real titles — this script repairs the rows
 * ingested before the fix.
 *
 * Title sources (in order):
 *   1. The legacy Mongo `job_index` collection, which reads
 *      `ServicePackageHeader.Title` correctly and is keyed by
 *      `servicePackageId` — the same source ID stored in
 *      `normalized_service_jobs.job_number`.
 *   2. Fallback: the raw Protractor payload stored on the parent work order
 *      in the Mongo `normalized_work_orders` shadow
 *      (`rawPayload.ServicePackages.ItemCollection[].ServicePackageHeader.Title`,
 *      matched by package ID). Covers rows whose package never made it into
 *      job_index (e.g. outside the backfill horizon).
 *
 * SAFETY — this is a PRODUCTION data operation (operator-gated)
 * -------------------------------------------------------------
 *   - DEFAULTS TO DRY RUN. Writes only with `--confirm`.
 *   - Chunked per shop AND per batch: the shared PG has a ~2-minute
 *     statement timeout, so updates go out in bounded VALUES batches
 *     (default 500 rows) with a sleep between batches.
 *   - Only touches rows where provenance sourceSystem = 'protractor' AND
 *     title = 'Unknown Service'. Never overwrites a real title.
 *   - Skips rows whose job_index counterpart has no usable title.
 *
 * Usage
 * -----
 *   tsx scripts/repair-protractor-unknown-service-titles.ts                # DRY RUN, all protractor shops
 *   tsx scripts/repair-protractor-unknown-service-titles.ts --shop=66      # DRY RUN, one shop
 *   tsx scripts/repair-protractor-unknown-service-titles.ts --shop=66 --confirm
 *   tsx scripts/repair-protractor-unknown-service-titles.ts --batch=500 --sleep=500 --confirm
 */

import fs from "fs";
import { getDb as getMongoDb } from "../lib/mongo";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

// Dedicated client: big shops' candidate scans can exceed the DB's default
// ~2-minute statement timeout, so raise it for this session only.
function getPgDb() {
  const url = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Missing database URL. Set DATAONE_DATABASE_URL or DATABASE_URL.");
  const client = postgres(url, {
    max: 1,
    idle_timeout: 30,
    connect_timeout: 30,
    connection: { statement_timeout: 600000 },
  });
  return drizzle(client);
}

interface Args {
  shop?: number;
  batch: number;
  sleepMs: number;
  confirm: boolean;
  resumeFile?: string;
}

function posInt(flag: string, v: string | undefined, { allowZero = false } = {}): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
    console.error(`Invalid value for --${flag}: ${JSON.stringify(v)}`);
    process.exit(1);
  }
  return n;
}

function parseArgs(): Args {
  const out: Args = { batch: 500, sleepMs: 500, confirm: false };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    switch (k) {
      case "shop": out.shop = posInt("shop", v); break;
      case "batch": out.batch = posInt("batch", v); break;
      case "sleep": out.sleepMs = posInt("sleep", v, { allowZero: true }); break;
      case "confirm": out.confirm = true; break;
      case "resume-file": out.resumeFile = v; break;
      default: console.warn(`Unknown arg: --${k}`);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs();
  const pg = getPgDb();
  const mongo = await getMongoDb();

  console.log(`Mode: ${args.confirm ? "LIVE WRITE" : "DRY RUN (pass --confirm to write)"}`);

  // Discover affected Protractor shops (or use --shop).
  let shopIds: number[];
  if (args.shop != null) {
    shopIds = [args.shop];
  } else {
    const res = (await pg.execute(sql`
      SELECT DISTINCT shop_id
      FROM normalized_service_jobs
      WHERE title = 'Unknown Service'
        AND provenance->>'sourceSystem' = 'protractor'
      ORDER BY shop_id
    `)) as unknown as Array<{ shop_id: number | string }>;
    shopIds = res.map((r) => Number(r.shop_id));
  }
  console.log(`Shops to repair: ${shopIds.join(", ") || "(none)"}`);

  let totalUpdated = 0;
  let totalNoTitle = 0;

  for (const shopId of shopIds) {
    console.log(`\n=== Shop ${shopId} ===`);
    let lastId = "";
    if (args.resumeFile && fs.existsSync(args.resumeFile)) {
      lastId = fs.readFileSync(args.resumeFile, "utf8").trim();
      if (lastId) console.log(`  resuming after id ${lastId} (from ${args.resumeFile})`);
    }
    let shopUpdated = 0;
    let shopNoTitle = 0;

    for (;;) {
      // Keyset-paginated candidate scan — bounded statements only.
      const rows = (await pg.execute(sql`
        SELECT id, job_number, work_order_id
        FROM normalized_service_jobs
        WHERE shop_id = ${shopId}
          AND title = 'Unknown Service'
          AND provenance->>'sourceSystem' = 'protractor'
          AND id > ${lastId}
        ORDER BY id
        LIMIT ${args.batch}
      `)) as unknown as Array<{ id: string; job_number: string | null; work_order_id: string | null }>;
      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;
      if (args.resumeFile) fs.writeFileSync(args.resumeFile, lastId);

      const spIds = rows.map((r) => r.job_number).filter((v): v is string => !!v);
      const titleBySp = new Map<string, string>();
      if (spIds.length > 0) {
        const docs = await mongo
          .collection("job_index")
          .find(
            { shopId, servicePackageId: { $in: spIds } },
            { projection: { servicePackageId: 1, "job.title": 1 } },
          )
          .toArray();
        for (const d of docs) {
          const t = (d as any)?.job?.title?.trim?.();
          if (t && t !== "Unknown Service") titleBySp.set(String((d as any).servicePackageId), t);
        }
      }

      // Fallback: for rows job_index couldn't title, read the parent WO's raw
      // Protractor payload from the Mongo normalized_work_orders shadow and
      // match the package by ID.
      const unresolved = rows.filter((r) => !(r.job_number && titleBySp.has(r.job_number)));
      const woIds = Array.from(
        new Set(unresolved.map((r) => r.work_order_id).filter((v): v is string => !!v)),
      );
      if (woIds.length > 0) {
        const woDocs = await mongo
          .collection("normalized_work_orders")
          .find(
            { _id: { $in: woIds as any[] }, shopId },
            { projection: { "rawPayload.ServicePackages": 1 } },
          )
          .toArray();
        for (const doc of woDocs) {
          const packages = (doc as any)?.rawPayload?.ServicePackages?.ItemCollection;
          if (!Array.isArray(packages)) continue;
          for (const sp of packages) {
            const spId = sp?.ID != null ? String(sp.ID) : "";
            const t = (sp?.ServicePackageHeader?.Title ?? "").toString().trim();
            if (spId && t && !titleBySp.has(spId)) titleBySp.set(spId, t);
          }
        }
      }

      const updates = rows
        .map((r) => ({ id: r.id, title: r.job_number ? titleBySp.get(r.job_number) : undefined }))
        .filter((u): u is { id: string; title: string } => !!u.title);
      shopNoTitle += rows.length - updates.length;

      if (updates.length > 0) {
        if (args.confirm) {
          const values = sql.join(
            updates.map((u) => sql`(${u.id}, ${u.title})`),
            sql`, `,
          );
          await pg.execute(sql`
            UPDATE normalized_service_jobs AS t
            SET title = v.title, updated_at = NOW()
            FROM (VALUES ${values}) AS v(id, title)
            WHERE t.id = v.id AND t.title = 'Unknown Service'
          `);
        } else {
          for (const u of updates.slice(0, 3)) {
            console.log(`  [dry-run] would set ${u.id} -> ${JSON.stringify(u.title)}`);
          }
        }
        shopUpdated += updates.length;
      }

      console.log(`  batch: scanned=${rows.length} titled=${updates.length} (cumulative updated=${shopUpdated}, unresolvable=${shopNoTitle})`);
      if (args.sleepMs > 0) await sleep(args.sleepMs);
    }

    console.log(`Shop ${shopId} done: ${args.confirm ? "updated" : "would update"}=${shopUpdated}, no-title-source=${shopNoTitle}`);
    totalUpdated += shopUpdated;
    totalNoTitle += shopNoTitle;
  }

  console.log(`\nTOTAL: ${args.confirm ? "updated" : "would update"}=${totalUpdated}, unresolvable=${totalNoTitle}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
