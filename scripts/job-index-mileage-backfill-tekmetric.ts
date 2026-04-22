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

// Use the centralized Tekmetric client so this script shares the same
// rate-limit budget, OAuth token, retry logic, and observability metrics as
// the cron jobs and app routes. Going through tekmetricRequest is the ONLY
// way to safely call Tekmetric from anywhere in this codebase — raw fetch
// bypasses the in-process rate limiter and causes 429 storms.
import { tekmetricRequest } from "@/lib/integrations/tekmetric/client";
import { getValidToken } from "@/lib/tekmetric-auth";

type Args = {
  shop?: number;
  limitRos?: number;
  dryRun: boolean;
  reqsPerSec: number;
  // Off-hours window. Default 20:00–05:00 America/New_York so we don't
  // hammer Tekmetric during shop business hours. Pass --any-time to disable.
  windowStartHourET: number;
  windowEndHourET: number;
  ignoreWindow: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = {
    dryRun: false,
    // Tekmetric's sustained rate limit is ~1-2 req/sec in practice. Default
    // to 2 so we stay under it without baked-in backoff churn. Override via
    // --rate=N if you want to push harder.
    reqsPerSec: 2,
    windowStartHourET: 20, // 8pm ET
    windowEndHourET: 5,    // 5am ET (next day)
    ignoreWindow: false,
  };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--any-time") out.ignoreWindow = true;
    else if (a.startsWith("--shop=")) out.shop = Number(a.slice(7));
    else if (a.startsWith("--limit-ros=")) out.limitRos = Number(a.slice(12));
    else if (a.startsWith("--rate=")) out.reqsPerSec = Number(a.slice(7));
    else if (a.startsWith("--window-start=")) out.windowStartHourET = Number(a.slice(15));
    else if (a.startsWith("--window-end=")) out.windowEndHourET = Number(a.slice(13));
  }
  return out;
}

// Returns the current hour (0-23) in America/New_York, accounting for DST.
function currentHourET(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  // Some browsers/runtimes emit "24" at midnight — normalize.
  const n = parseInt(h, 10);
  return n === 24 ? 0 : n;
}

function isInsideWindow(args: Args): boolean {
  if (args.ignoreWindow) return true;
  const h = currentHourET();
  const { windowStartHourET: s, windowEndHourET: e } = args;
  // Wrap-around window (e.g. 20→5)
  if (s > e) return h >= s || h < e;
  // Same-day window (e.g. 1→5)
  return h >= s && h < e;
}

function msUntilWindowOpens(args: Args): number {
  // Compute ms until the next ET hour matching args.windowStartHourET.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parseInt(fmt.find((p) => p.type === t)?.value ?? "0", 10);
  const h = get("hour") === 24 ? 0 : get("hour");
  const m = get("minute");
  const s = get("second");
  const secondsSinceMidnightET = h * 3600 + m * 60 + s;
  const targetSecondsET = args.windowStartHourET * 3600;
  let deltaSec = targetSecondsET - secondsSinceMidnightET;
  if (deltaSec <= 0) deltaSec += 86400;
  return deltaSec * 1000;
}

// Track when the centralized rate limiter says "budget exhausted" so the
// main loop can pause the whole run for a longer cooldown rather than
// burning through the remaining ROs as no-ops.
let budgetExhaustedHits = 0;

async function tekmetricFetchRO(roId: number, shopId: number): Promise<
  | { milesIn: number | null; milesOut: number | null }
  | "budget_exhausted"
  | null
> {
  try {
    const body: any = await tekmetricRequest(`/repair-orders/${roId}`, {}, shopId);
    budgetExhaustedHits = 0;
    return {
      milesIn: typeof body?.milesIn === "number" ? body.milesIn : (typeof body?.mileageIn === "number" ? body.mileageIn : null),
      milesOut: typeof body?.milesOut === "number" ? body.milesOut : (typeof body?.mileageOut === "number" ? body.mileageOut : null),
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    // 404 — RO no longer exists in Tekmetric.
    if (/error 404/i.test(msg)) return null;
    // The centralized rate limiter ran out of budget; signal cooldown.
    if (/rate limit budget exhausted/i.test(msg)) {
      budgetExhaustedHits++;
      console.log(`  [budget] RO ${roId}: ${msg} (consecutive=${budgetExhaustedHits})`);
      return "budget_exhausted";
    }
    // 429 storms (after tekmetricRequest's own 5 retries).
    if (/error 429/i.test(msg)) {
      budgetExhaustedHits++;
      console.log(`  [429-exhausted] RO ${roId}: ${msg} (consecutive=${budgetExhaustedHits})`);
      return "budget_exhausted";
    }
    // Anything else — log and move on so one bad RO doesn't kill the run.
    console.log(`  [error] RO ${roId}: ${msg.slice(0, 200)}`);
    return null;
  }
}

async function main() {
  const args = parseArgs();
  console.log("=== Tekmetric job_index Mileage Backfill ===");
  console.log("Args:", args);

  if (!process.env.TEKMETRIC_CLIENT_ID || !process.env.TEKMETRIC_CLIENT_SECRET) {
    console.error("Missing TEKMETRIC_CLIENT_ID and/or TEKMETRIC_CLIENT_SECRET");
    process.exit(1);
  }
  // Prime the OAuth token so we fail fast if creds are bad.
  try {
    await getValidToken();
    console.log("[auth] OAuth token acquired.");
  } catch (e: any) {
    console.error("[auth] Failed to acquire Tekmetric OAuth token:", e?.message || e);
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
      // Off-hours gate: pause until the window re-opens. We check before each
      // RO so a long-running backfill cleanly pauses at 5am ET and resumes
      // at 8pm ET without any external scheduler. Persists progress before
      // sleeping so an OS-level kill during the pause doesn't lose state.
      if (!isInsideWindow(args)) {
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
        const sleepMs = msUntilWindowOpens(args);
        const wakeAt = new Date(Date.now() + sleepMs).toISOString();
        console.log(`  [window] Outside ${args.windowStartHourET}:00–${args.windowEndHourET}:00 ET. Sleeping ${(sleepMs/3600000).toFixed(1)}h until ${wakeAt}.`);
        // Wake every 5 minutes to recheck (handles DST shifts cleanly).
        const checkIntervalMs = 5 * 60 * 1000;
        const sleepEnd = Date.now() + sleepMs;
        while (Date.now() < sleepEnd) {
          await new Promise((r) => setTimeout(r, Math.min(checkIntervalMs, sleepEnd - Date.now())));
          if (isInsideWindow(args)) break;
        }
        console.log(`  [window] Resuming.`);
      }

      const woId = todo[i];
      const roIdNum = Number(woId);
      if (!Number.isFinite(roIdNum)) {
        grandSkipped++;
        continue;
      }

      // Cross-call cooldown: if Tekmetric has been throttling us back-to-back,
      // pause the whole run for several minutes so the quota window can reset.
      // 5 consecutive 429s ≈ a hard quota wall, not a momentary blip.
      if (budgetExhaustedHits >= 3) {
        const cooldownMin = Math.min(15, 2 * Math.floor(budgetExhaustedHits / 3));
        console.log(`  [cooldown] ${budgetExhaustedHits} consecutive budget-exhausted/429 errors — sleeping ${cooldownMin} min before next request.`);
        // Persist progress before the long pause so a kill is safe.
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
        await new Promise((r) => setTimeout(r, cooldownMin * 60 * 1000));
        consecutive429s = 0;
      }

      // Throttle
      const wait = lastReqAt + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastReqAt = Date.now();

      let mileage: number | null = null;
      try {
        const ro = await tekmetricFetchRO(roIdNum, shopId);
        if (ro === "budget_exhausted") {
          // Don't mark completed — let the next iteration's cooldown
          // logic kick in based on budgetExhaustedHits.
          continue;
        }
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
