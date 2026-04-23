// Task #36 verification driver: invokes `backfillShopChunk` directly for the
// 18 shops that task #23 left with the synthetic "task #23 manual probe ..."
// lastError marker, so each shop produces either:
//   - totalJobsIndexed > 0 (a real chunk ran), OR
//   - a real lastError from `backfillShopChunkInner` ("chunk threw:" /
//     "chunk had errors, holding cursor"). NB: "force-skipped bad
//     window ..." is intentionally NOT accepted as a real error — it
//     indicates the cron skipped past a bad window without proving the
//     shop actually attempted indexing in this task.
//
// Why drive it from a script instead of waiting for cron?
//   1. The synthetic markers were stamped with lastErrorAt = now, so the
//      cron's 6-hour ERROR_AUTO_CLEAR_HOURS gate keeps them ineligible.
//   2. The probe also stamped lastRunAt = now, which moved the 18 shops
//      from the high-priority "never_started" bucket to the bottom of
//      the "stalled" queue (sorted by oldest lastRunAt). With
//      MAX_SHOPS_PER_RUN=5 and many older-stalled shops ahead of them
//      (32, 36, 37, 54, 57, 73, 74, 75, 78, 28, 82, 83, 84, 85, 100),
//      the probed shops would wait many cron cycles before being picked.
//
// This script bypasses both gates by calling backfillShopChunk directly,
// which is exactly what the cron's per-shop loop does.
//
// The script is idempotent and self-resuming: each shop's
// `currentChunkEnd` cursor is preserved on the progress row, so a
// re-run picks up where the previous attempt left off (or simply
// confirms the marker is gone if the previous run already cleared it).
// On exit, the script re-fetches every progress row and exits non-zero
// if any of the 18 shops still carry the task #23 synthetic
// "task #23 manual probe ..." prefix on `lastError`.
//
// Each chunk takes ~10–15 minutes wall-clock under Tekmetric's 600
// req/min quota (most of the time is spent in 429 backoffs on
// per-RO `/jobs`, `/vehicles`, `/customers` lookups). All 18 shops
// sequentially is therefore a multi-hour run; do NOT wire this to a
// short-lived foreground bash invocation. Run it from a Replit
// workflow or a long-lived shell, and let it finish.
//
// Usage: npx tsx scripts/drive-task-23-restarted-shops.ts

import { appendFileSync } from "fs";
import { getDb } from "../lib/mongo";
import { backfillShopChunk } from "../app/api/cron/tekmetric-backfill/route";

const SHOP_IDS = [86, 87, 88, 90, 92, 93, 94, 95, 96, 97, 98, 99, 101, 102, 103, 104, 106, 107];
const PROGRESS_FILE = ".local/logs/drive-task-23.progress.jsonl";
// Marker text that the task #23 restart script wrote to lastError. The
// final assertion treats any shop still carrying this prefix as a
// verification failure, since the whole point of this script is to
// replace the synthetic marker with a real chunk outcome.
const TASK_23_SYNTHETIC_PREFIX = "task #23 manual probe";

function record(obj: Record<string, any>) {
  try {
    appendFileSync(PROGRESS_FILE, JSON.stringify({ at: new Date().toISOString(), ...obj }) + "\n");
  } catch {}
}

async function main() {
  const db = await getDb();
  const startedAt = Date.now();

  const shops = await db
    .collection("shops")
    .find({ shopId: { $in: SHOP_IDS } })
    .toArray();
  const byId = new Map<number, any>();
  for (const s of shops) byId.set(Number(s.shopId), s);

  const summary: Array<Record<string, any>> = [];
  record({ event: "start", shops: SHOP_IDS });

  for (const shopId of SHOP_IDS) {
    const shop = byId.get(shopId);
    if (!shop) {
      summary.push({ shopId, status: "no_shop_doc" });
      console.log(`[drive] shop=${shopId} SKIP — no shop doc`);
      record({ event: "skip", shopId, reason: "no_shop_doc" });
      continue;
    }
    const tekmetricShopId = shop.tekmetric?.shopId ?? shop.tekmetricShopId;
    if (!tekmetricShopId) {
      summary.push({ shopId, status: "no_tekmetric_link" });
      console.log(`[drive] shop=${shopId} SKIP — no tekmetric link`);
      record({ event: "skip", shopId, reason: "no_tekmetric_link" });
      continue;
    }

    const t0 = Date.now();
    console.log(`\n[drive] shop=${shopId} (tek=${tekmetricShopId}) starting chunk...`);
    record({ event: "shop_start", shopId, tekmetricShopId });
    try {
      const result = await backfillShopChunk(db, shopId, Number(tekmetricShopId));
      const dt = Date.now() - t0;
      const entry = {
        shopId,
        status: "ok",
        ms: dt,
        jobsIndexed: result.jobsIndexed,
        skipped: result.skipped,
        normalizedCount: result.normalizedCount,
        complete: result.complete,
        message: result.message,
      };
      summary.push(entry);
      console.log(`[drive] shop=${shopId} OK in ${dt}ms — ${result.message}`);
      record({ event: "shop_done", ...entry });
    } catch (err: any) {
      const dt = Date.now() - t0;
      const msg = err?.message ? String(err.message).slice(0, 300) : String(err).slice(0, 300);
      summary.push({ shopId, status: "threw", ms: dt, error: msg });
      console.log(`[drive] shop=${shopId} THREW in ${dt}ms — ${msg}`);
      record({ event: "shop_threw", shopId, ms: dt, error: msg });
      // backfillShopChunk's wrapper already recorded the error to the
      // progress row, so we just continue to the next shop.
    }
  }
  record({ event: "end", elapsedSec: Math.round((Date.now() - startedAt) / 1000) });

  console.log("\n" + "=".repeat(72));
  console.log("Per-shop summary:");
  console.log("=".repeat(72));
  for (const r of summary) console.log(JSON.stringify(r));

  // Final assertion: re-fetch the progress rows and verify each of the
  // 18 shops now satisfies the task #36 acceptance criteria — either
  //   (a) totalJobsIndexed > 0, or
  //   (b) a real lastError from `backfillShopChunkInner` (i.e. NOT the
  //       task #23 synthetic "task #23 manual probe ..." marker).
  // Anything still carrying the synthetic prefix is a verification
  // failure; exit non-zero so a CI / cron / re-runner notices.
  const finalRows = await db
    .collection("tekmetric_backfill_progress")
    .find({ shopId: { $in: SHOP_IDS } })
    .toArray();
  const byFinal = new Map<number, any>();
  for (const r of finalRows) byFinal.set(Number(r.shopId), r);

  console.log("\n" + "=".repeat(72));
  console.log("Final acceptance check:");
  console.log("=".repeat(72));
  // Accepted real-error prefixes from backfillShopChunkInner. Anything
  // else on lastError (including null when jobs==0) is treated as a
  // failure — the task #36 acceptance criterion requires concrete
  // evidence that the shop actually attempted indexing.
  const REAL_ERROR_PREFIXES = ["chunk threw:", "chunk had errors, holding cursor"];
  const failures: Array<{ shopId: number; reason: string; lastError: string | null; jobs: number }> = [];
  for (const shopId of SHOP_IDS) {
    const row = byFinal.get(shopId);
    const jobs = Number(row?.totalJobsIndexed || 0);
    const err = row?.lastError ? String(row.lastError) : null;
    const stillSynthetic = !!err && err.startsWith(TASK_23_SYNTHETIC_PREFIX);
    const isRealError = !!err && REAL_ERROR_PREFIXES.some(p => err.startsWith(p));
    let pass = false;
    let reason = "";
    if (!row) {
      reason = "no progress row";
    } else if (stillSynthetic) {
      reason = "still has task #23 synthetic marker";
    } else if (jobs > 0) {
      pass = true;
      reason = `jobsIndexed=${jobs}`;
    } else if (isRealError) {
      pass = true;
      reason = `real lastError: ${err!.slice(0, 80)}`;
    } else if (err) {
      reason = `unrecognized lastError prefix (not jobs>0 and not a real chunk error): ${err.slice(0, 80)}`;
    } else {
      // No jobs and lastError cleared (e.g. by the cron's auto-clear).
      // The task #36 acceptance criterion requires either jobs>0 or a
      // real chunk error, so this state does NOT count as verified.
      reason = `jobs=0 and lastError=null — no evidence shop attempted indexing (cursor=${row.currentChunkEnd?.toISOString?.() ?? row.currentChunkEnd})`;
    }
    console.log(`  shop=${shopId}  ${pass ? "PASS" : "FAIL"}  jobs=${jobs}  ${reason}`);
    if (!pass) failures.push({ shopId, reason, lastError: err, jobs });
  }

  console.log(`\nTotal elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`Verification: ${failures.length === 0 ? "ALL 18 SHOPS PASS" : `${failures.length}/${SHOP_IDS.length} FAILED`}`);
  record({ event: "verification", failures, allPass: failures.length === 0 });

  if (failures.length > 0) {
    console.error("Re-run this script to retry failed shops; each chunk advances the cursor and replaces lastError, so re-runs are idempotent.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error("drive-task-23-restarted-shops failed:", err);
  process.exit(1);
});
