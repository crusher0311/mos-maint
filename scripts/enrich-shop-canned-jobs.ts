/**
 * One-arg trigger for the Protractor canned-jobs deep sync (task #405).
 *
 * Mirrors what `app/api/protractor/canned-jobs/enrich/route.ts` does, but
 * takes a shopId on the CLI so platform admins can run it for any shop
 * from the Render shell without having to log in as that shop's user.
 *
 * Usage (Render shell):
 *   npx tsx scripts/enrich-shop-canned-jobs.ts 116
 *
 * Side effects:
 *   - Runs the task #405 one-shot cleanup (idempotent, gated by
 *     migration_markers — only the very first call after deploy across
 *     all shops actually deletes anything).
 *   - Fetches the full /CannedJob/ list for the shop.
 *   - Enriches every job via /ServicePackage/CannedJob/{id} (the
 *     correct endpoint — see PROTRACTOR_API_REFERENCE.md).
 *   - Writes the enriched result to `protractor_canned_jobs` with
 *     source: "enriched".
 */
import {
  fetchCannedJobs,
  enrichCannedJobsWithDetails,
  upsertCannedJobsCache,
  clearPoisonedTemplate404sOnce,
  ProtractorCannedJob,
} from "@/lib/integrations/protractor";

async function main() {
  const arg = process.argv[2];
  const shopId = Number(arg);
  if (!arg || !Number.isFinite(shopId) || shopId <= 0) {
    console.error("Usage: npx tsx scripts/enrich-shop-canned-jobs.ts <shopId>");
    process.exit(2);
  }

  console.log(`[enrich-shop-canned-jobs] Starting deep sync for shop ${shopId}...`);

  // Step 0: task #405 one-shot cleanup of poisoned is404 entries.
  try {
    const cleanup = await clearPoisonedTemplate404sOnce();
    if (cleanup.skipped) {
      console.log("[enrich-shop-canned-jobs] Task #405 cleanup already ran (skipped).");
    } else {
      console.log(
        `[enrich-shop-canned-jobs] Task #405 cleanup ran: ${cleanup.deletedCount} ` +
          `poisoned entries deleted across ${cleanup.byShop?.length ?? 0} shops.`,
      );
    }
  } catch (err: any) {
    console.error("[enrich-shop-canned-jobs] Task #405 cleanup failed (continuing):", err?.message);
  }

  // Step 1: pull the list.
  const listResult = await fetchCannedJobs(shopId);
  if (!listResult.ok || !listResult.cannedJobs) {
    console.error(`[enrich-shop-canned-jobs] List fetch failed: ${listResult.error}`);
    process.exit(1);
  }
  const total = listResult.cannedJobs.length;
  console.log(`[enrich-shop-canned-jobs] Fetched ${total} jobs from /CannedJob/, starting enrichment...`);

  // Step 2: enrich (uses the new /ServicePackage/CannedJob/{id} path).
  const enriched = await enrichCannedJobsWithDetails(shopId, listResult.cannedJobs, {
    filterEmptyTitles: true,
  });

  // Step 3: persist with source: "enriched" so fetchCannedJobsWithCache
  // short-circuits to this result instead of clobbering it with the
  // titles-empty basic list.
  await upsertCannedJobsCache(shopId, enriched as ProtractorCannedJob[], { source: "enriched" });

  console.log(
    `[enrich-shop-canned-jobs] DONE shop=${shopId}: ` +
      `${enriched.length} kept / ${total} total (${total ? Math.round((enriched.length / total) * 100) : 0}% retention).`,
  );

  if (total > 0 && enriched.length === 0) {
    console.error(
      `[enrich-shop-canned-jobs] WARN: enrichment kept 0 of ${total} jobs — ` +
        "check BetterStack for [Protractor:CannedJobDetail] shape diagnostic.",
    );
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[enrich-shop-canned-jobs] Fatal:", err);
  process.exit(1);
});
