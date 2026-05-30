#!/usr/bin/env tsx
/**
 * Protractor New-Shop Drain Sweep (task #547) — CLI operator trigger.
 *
 * One-shot sweep that drives every incomplete, recently-onboarded Protractor
 * shop to completion in a single pass, independent of the cron scheduler
 * (does NOT need ENABLE_INPROCESS_CRON). Built for weekend onboarding where
 * several new Protractor shops come online and need their history pulled now.
 *
 * Safe to re-run: already-complete shops are skipped, and the per-shop
 * in-flight/stale lock + Protractor rate limiter (inside runProtractorBackfill)
 * prevent double-running a shop or breaching the API ceiling even if the cron
 * is running concurrently.
 *
 * Usage:
 *   npm run sweep:protractor-new-shops
 *   npm run sweep:protractor-new-shops -- 12 34 56     # explicit shopIds
 *   PROTRACTOR_NEW_SHOP_SWEEP_DAYS=21 npm run sweep:protractor-new-shops
 *
 * Env knobs:
 *   PROTRACTOR_NEW_SHOP_SWEEP_DAYS        (default 14)  onboarding window
 *   PROTRACTOR_NEW_SHOP_SWEEP_PARALLELISM (default 3)   concurrent shops
 *   PROTRACTOR_NEW_SHOP_SWEEP_MAX_ITERS   (default 12)  drive iters per shop
 *   PROTRACTOR_NEW_SHOP_SWEEP_SHOP_IDS    (optional csv) explicit shopId list
 */

import { sweepNewProtractorShops } from "@/lib/integrations/protractor/new-shop-sweep";

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseShopIds(): number[] {
  const fromArgs = process.argv
    .slice(2)
    .flatMap((a) => a.split(","))
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (fromArgs.length > 0) return fromArgs;

  return (process.env.PROTRACTOR_NEW_SHOP_SWEEP_SHOP_IDS || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

let stopRequested = false;

async function main() {
  log("===== Protractor New-Shop Drain Sweep =====");

  process.on("SIGINT", () => {
    log("SIGINT received — finishing in-flight shops then exiting");
    stopRequested = true;
  });
  process.on("SIGTERM", () => {
    log("SIGTERM received — finishing in-flight shops then exiting");
    stopRequested = true;
  });

  const shopIds = parseShopIds();

  const summary = await sweepNewProtractorShops({
    shopIds: shopIds.length > 0 ? shopIds : undefined,
    shouldStop: () => stopRequested,
    log,
  });

  log("");
  log("===== SWEEP COMPLETE =====");
  log(
    `mode=${summary.usedExplicitShopIds ? "explicit-shopIds" : `window(${summary.windowDays}d)`} ` +
      `swept=${summary.swept} complete=${summary.completed} ` +
      `pending=${summary.stillPending} errored=${summary.errored} stopped=${summary.stopped}`,
  );
  log(
    `chunks=${summary.totalChunks} jobs=${summary.totalJobsIndexed} ` +
      `elapsed=${(summary.durationMs / 1000 / 60).toFixed(1)}min`,
  );

  const errored = summary.perShop.filter((r) => r.finalState === "error");
  if (errored.length > 0) {
    log("");
    log("Errored shops:");
    for (const r of errored) {
      log(`  shop=${r.shopId} (${r.name}) err="${r.error}"`);
    }
  }

  const pending = summary.perShop.filter((r) => r.finalState === "still_pending");
  if (pending.length > 0) {
    log("");
    log("Still-pending shops (hit max-iteration cap; re-run to continue):");
    for (const r of pending) {
      log(
        `  shop=${r.shopId} (${r.name}) iters=${r.iterations} chunks=${r.chunksProcessed} jobs=${r.totalJobsIndexed}`,
      );
    }
  }

  process.exit(errored.length > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`FATAL: ${err?.message || String(err)}`);
  console.error(err);
  process.exit(2);
});
