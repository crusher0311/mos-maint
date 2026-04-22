// Tekmetric job_index mileage backfill
// Usage: npx tsx scripts/job-index-mileage-backfill-tekmetric.ts [--shop=82] [--limit-ros=500] [--dry-run]
//
// Why: ~688k job_index rows across 29 shops are missing the `mileage` field
// because earlier backfills lost it. The parent `tekmetric_work_orders` docs
// for those historical ROs also lack mileage, so the only authoritative source
// is the Tekmetric API (`GET /repair-orders/{id}` returns `milesIn` / `milesOut`).
//
// Strategy:
//   1. Group missing-mileage rows by (shopId, workOrderId).
//   2. For each unique (shopId, workOrderId) pair, hit Tekmetric once and
//      bulk-update every job_index row sharing that workOrderId.
//   3. Throttle to ~5 req/sec per shop and persist progress in
//      `tekmetric_mileage_backfill_progress` so crashes/restarts resume cleanly.
//   4. Mark each row with `mileageBackfilledAt` so re-runs skip it cheaply.
//
// Backlog ref: IMPROVEMENT_BACKLOG.md item #9.

import { getDb } from "../lib/mongo";

const TEKMETRIC_API_BASE = "https://shop.tekmetric.com/api/v1";
const TEKMETRIC_API_TOKEN = process.env.TEKMETRIC_API_TOKEN;

type Args = {
  shop?: number;
  limitRos?: number;
  dryRun: boolean;
  reqsPerSec: number;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { dryRun: false, reqsPerSec: 5 };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--shop=")) out.shop = Number(a.slice(7));
    else if (a.startsWith("--limit-ros=")) out.limitRos = Number(a.slice(12));
    else if (a.startsWith("--rate=")) out.reqsPerSec = Number(a.slice(7));
  }
  return out;
}

async function tekmetricFetchRO(roId: number): Promise<{
  milesIn: number | null;
  milesOut: number | null;
} | null> {
  const url = `${TEKMETRIC_API_BASE}/repair-orders/${roId}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TEKMETRIC_API_TOKEN}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 1000, 30000);
      console.log(`  [429] RO ${roId}: waiting ${waitMs}ms before retry ${attempt}`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} for RO ${roId}: ${text.slice(0, 200)}`);
    }
    const body: any = await res.json();
    return {
      milesIn: typeof body?.milesIn === "number" ? body.milesIn : (typeof body?.mileageIn === "number" ? body.mileageIn : null),
      milesOut: typeof body?.milesOut === "number" ? body.milesOut : (typeof body?.mileageOut === "number" ? body.mileageOut : null),
    };
  }
  throw new Error(`RO ${roId}: exhausted retries`);
}

async function main() {
  const args = parseArgs();
  console.log("=== Tekmetric job_index Mileage Backfill ===");
  console.log("Args:", args);

  if (!TEKMETRIC_API_TOKEN) {
    console.error("Missing TEKMETRIC_API_TOKEN");
    process.exit(1);
  }

  const db = await getDb();
  const jobIndex = db.collection("job_index");
  const progressColl = db.collection("tekmetric_mileage_backfill_progress");

  // shopId is stored as both number and string across job_index docs in
  // production (~580k numeric, ~145k string), so every shop filter must
  // match either type or we silently skip whole shops.
  const shopIdFilter = (s: number | string) => ({ $in: [Number(s), String(s)] });

  // Per-shop scope
  const shopMatch: any = { sourceSystem: "tekmetric" };
  if (args.shop) shopMatch.shopId = shopIdFilter(args.shop);
  const shopIdsRaw: any[] = await jobIndex.distinct("shopId", {
    ...shopMatch,
    $or: [{ mileage: null }, { mileage: { $exists: false } }],
  });
  // Distinct returns both types — collapse to unique numeric ids.
  const shopIds = Array.from(
    new Set(shopIdsRaw.map((v) => Number(v)).filter((n) => Number.isFinite(n))),
  ).sort((a, b) => a - b);
  console.log(`Shops to process: ${shopIds.join(", ")}`);

  const minIntervalMs = Math.max(1, Math.floor(1000 / args.reqsPerSec));

  let grandFetched = 0;
  let grandUpdated = 0;
  let grandSkipped = 0;

  for (const shopId of shopIds) {
    console.log(`\n--- Shop ${shopId} ---`);

    // Resume: load progress doc
    const progressId = `tekmetric:${shopId}`;
    const prog = await progressColl.findOne({ _id: progressId as any });
    const completed = new Set<string>(prog?.completedWorkOrderIds || []);
    const apiNotFound = new Set<string>(prog?.apiNotFoundWorkOrderIds || []);
    if (completed.size || apiNotFound.size) {
      console.log(`  Resuming: ${completed.size} already done, ${apiNotFound.size} 404'd`);
    }

    // Distinct workOrderIds with missing mileage for this shop
    const workOrderIds: string[] = await jobIndex.distinct("workOrderId", {
      shopId: shopIdFilter(shopId),
      sourceSystem: "tekmetric",
      $or: [{ mileage: null }, { mileage: { $exists: false } }],
    });
    // Filter out empties + already-completed + 404'd
    const todo = workOrderIds
      .map(String)
      .filter((id) => id && id !== "null" && id !== "undefined")
      .filter((id) => !completed.has(id) && !apiNotFound.has(id));
    console.log(`  Distinct WOs: ${workOrderIds.length} total, ${todo.length} to process`);

    const limit = args.limitRos ? Math.min(args.limitRos, todo.length) : todo.length;
    let lastReqAt = 0;
    let processedThisShop = 0;

    for (let i = 0; i < limit; i++) {
      const woId = todo[i];
      const roIdNum = Number(woId);
      if (!Number.isFinite(roIdNum)) {
        grandSkipped++;
        continue;
      }

      // Throttle
      const wait = lastReqAt + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastReqAt = Date.now();

      let mileage: number | null = null;
      try {
        const ro = await tekmetricFetchRO(roIdNum);
        if (ro === null) {
          apiNotFound.add(woId);
          grandSkipped++;
          processedThisShop++;
        } else {
          mileage =
            (typeof ro.milesOut === "number" && ro.milesOut > 0 ? ro.milesOut : null) ??
            (typeof ro.milesIn === "number" && ro.milesIn > 0 ? ro.milesIn : null);
          grandFetched++;
          processedThisShop++;
        }
      } catch (err: any) {
        console.log(`  [error] RO ${woId}: ${err.message}`);
        // don't mark completed; will retry on next run
        continue;
      }

      if (mileage != null) {
        if (args.dryRun) {
          console.log(`  [dry-run] would update WO ${woId} -> mileage ${mileage}`);
          completed.add(woId);
        } else {
          // job_index.workOrderId is uniformly string in production today, but
          // include numeric variant defensively for any future writers.
          const woIdAsNum = Number(woId);
          const woIdMatch = Number.isFinite(woIdAsNum) ? { $in: [woId, woIdAsNum] } : woId;
          const res = await jobIndex.updateMany(
            {
              shopId: shopIdFilter(shopId),
              sourceSystem: "tekmetric",
              workOrderId: woIdMatch,
              $or: [{ mileage: null }, { mileage: { $exists: false } }],
            },
            {
              $set: {
                mileage,
                "vehicle.mileage": mileage,
                mileageBackfilledAt: new Date(),
              },
              $unset: { mileageBackfillTriedAt: "" },
            },
          );
          grandUpdated += res.modifiedCount;
          // Only mark completed if we actually patched rows OR if the rows
          // were already mileage-populated (matchedCount tells us they
          // exist but weren't missing). If matched=0, leave it unmarked so
          // a future re-run can recheck (e.g. after fixing a type bug).
          if (res.modifiedCount > 0 || res.matchedCount === 0) {
            completed.add(woId);
          } else {
            console.log(`  [warn] WO ${woId}: API gave mileage=${mileage} but updateMany matched 0 rows (skipping completion mark)`);
          }
        }
      } else {
        // RO existed but had no usable mileage — don't keep retrying it
        completed.add(woId);
      }

      // Persist progress every 50 WOs
      if (!args.dryRun && processedThisShop % 50 === 0) {
        await progressColl.updateOne(
          { _id: progressId as any },
          {
            $set: {
              shopId,
              completedWorkOrderIds: Array.from(completed),
              apiNotFoundWorkOrderIds: Array.from(apiNotFound),
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true },
        );
      }

      if (processedThisShop % 100 === 0) {
        console.log(`  Progress: ${processedThisShop}/${limit} WOs (fetched=${grandFetched}, updated=${grandUpdated}, skipped=${grandSkipped})`);
      }
    }

    // Final flush for this shop
    if (!args.dryRun) {
      await progressColl.updateOne(
        { _id: progressId as any },
        {
          $set: {
            shopId,
            completedWorkOrderIds: Array.from(completed),
            apiNotFoundWorkOrderIds: Array.from(apiNotFound),
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
    }

    console.log(`  Shop ${shopId} done. Processed ${processedThisShop} WOs (cumulative: fetched=${grandFetched}, updated=${grandUpdated}, skipped=${grandSkipped})`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`ROs fetched from Tekmetric: ${grandFetched}`);
  console.log(`job_index rows updated:     ${grandUpdated}`);
  console.log(`Skipped (404 / non-numeric): ${grandSkipped}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
