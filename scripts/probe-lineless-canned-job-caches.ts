/**
 * Task #916 — fleet sweep for line-less canned-job caches.
 *
 * Shop 219's `protractor_canned_jobs` cache had titles on every item but
 * zero lines everywhere (task #913) — pushing from such a cache produces
 * $0 header-only packages. This script scans EVERY doc in
 * `protractor_canned_jobs` and reports which shops trip
 * `isCannedJobsCacheLineless`.
 *
 * Default mode is READ-ONLY (safe to run any time — dev Mongo IS prod).
 *
 * With `--fix`, each affected shop is re-enriched through the existing
 * enrichment path (same as scripts/enrich-shop-canned-jobs.ts): full
 * /CannedJob/ list fetch + per-template detail enrichment, then a cache
 * write that is skipped if `wouldDowngradeCannedJobsCache` says the new
 * batch is worse than what's there. Run --fix OFF-PEAK only (operator
 * action — it fans out live Protractor API calls per shop).
 *
 * Usage (Render shell / off-peak):
 *   npx tsx scripts/probe-lineless-canned-job-caches.ts            # report only
 *   npx tsx scripts/probe-lineless-canned-job-caches.ts --fix      # report + re-enrich
 *   npx tsx scripts/probe-lineless-canned-job-caches.ts --fix 219 143   # fix only these shopIds
 */
import { getDb } from "@/lib/mongo";
import {
  fetchCannedJobs,
  enrichCannedJobsWithDetails,
  upsertCannedJobsCache,
  isCannedJobsCacheLineless,
  wouldDowngradeCannedJobsCache,
  ProtractorCannedJob,
} from "@/lib/integrations/protractor";

function countWithLines(items: ReadonlyArray<any> | null | undefined): number {
  if (!items) return 0;
  let n = 0;
  for (const it of items) {
    const lineCount =
      (Array.isArray(it?.lines) ? it.lines.length : 0) ||
      (typeof it?.lineCount === "number" ? it.lineCount : 0) ||
      (Array.isArray(it?.ServicePackageLines) ? it.ServicePackageLines.length : 0) ||
      (Array.isArray(it?.ServicePackageLines?.ItemCollection)
        ? it.ServicePackageLines.ItemCollection.length
        : 0);
    if (lineCount > 0) n += 1;
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const onlyShopIds = args
    .filter((a) => a !== "--fix")
    .map((a) => Number(a))
    .filter((n) => Number.isFinite(n) && n > 0);

  const db = await getDb();
  const docs = await db
    .collection("protractor_canned_jobs")
    .find(
      {},
      { projection: { shopId: 1, source: 1, fetchedAt: 1, items: 1 } },
    )
    .toArray();

  console.log(`[lineless-sweep] Scanned ${docs.length} protractor_canned_jobs cache docs.`);

  type Row = {
    shopId: number;
    items: number;
    withLines: number;
    source: string;
    fetchedAt: string;
  };
  const affected: Row[] = [];
  for (const doc of docs) {
    const items = Array.isArray(doc.items) ? doc.items : [];
    if (isCannedJobsCacheLineless(items)) {
      affected.push({
        shopId: doc.shopId,
        items: items.length,
        withLines: countWithLines(items),
        source: doc.source ?? "(none)",
        fetchedAt: doc.fetchedAt ? new Date(doc.fetchedAt).toISOString() : "(none)",
      });
    }
  }

  if (affected.length === 0) {
    console.log("[lineless-sweep] No line-less caches found. Fleet is clean.");
    process.exit(0);
  }

  console.log(`[lineless-sweep] ${affected.length} shop(s) with LINE-LESS canned-job caches:`);
  console.table(affected);

  if (!fix) {
    console.log(
      "[lineless-sweep] Read-only mode. Re-run with --fix (off-peak) to re-enrich affected shops.",
    );
    process.exit(0);
  }

  const targets = onlyShopIds.length
    ? affected.filter((r) => onlyShopIds.includes(r.shopId))
    : affected;

  let fixed = 0;
  let failed = 0;
  for (const row of targets) {
    const shopId = row.shopId;
    console.log(`\n[lineless-sweep] Re-enriching shop ${shopId}...`);
    try {
      const listResult = await fetchCannedJobs(shopId);
      if (!listResult.ok || !listResult.cannedJobs) {
        console.error(`[lineless-sweep] shop ${shopId}: list fetch failed: ${listResult.error}`);
        failed += 1;
        continue;
      }
      const total = listResult.cannedJobs.length;
      const enriched = await enrichCannedJobsWithDetails(shopId, listResult.cannedJobs, {
        filterEmptyTitles: true,
        listSource: listResult.source,
      });
      const newWithLines = countWithLines(enriched);

      const existingDoc = await db
        .collection("protractor_canned_jobs")
        .findOne({ shopId }, { projection: { items: 1 } });
      if (wouldDowngradeCannedJobsCache(existingDoc?.items, enriched)) {
        console.error(
          `[lineless-sweep] shop ${shopId}: SKIPPED write — enrichment result ` +
            `(${enriched.length} items, ${newWithLines} with lines) would downgrade the existing cache.`,
        );
        failed += 1;
        continue;
      }

      await upsertCannedJobsCache(shopId, enriched as ProtractorCannedJob[], {
        source: "enriched",
      });
      const stillLineless = isCannedJobsCacheLineless(enriched);
      console.log(
        `[lineless-sweep] shop ${shopId}: wrote ${enriched.length}/${total} jobs, ` +
          `${newWithLines} with lines${stillLineless ? " — WARN: still line-less (source may genuinely lack lines)" : ""}.`,
      );
      fixed += 1;
    } catch (err: any) {
      console.error(`[lineless-sweep] shop ${shopId}: FAILED:`, err?.message ?? err);
      failed += 1;
    }
  }

  console.log(`\n[lineless-sweep] DONE: ${fixed} re-enriched, ${failed} failed/skipped of ${targets.length} target(s).`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[lineless-sweep] Fatal:", err);
  process.exit(1);
});
