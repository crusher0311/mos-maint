/**
 * Task #931 — backfill `listSource` onto existing shops' canned-job caches.
 *
 * Task #925 stamps `listSource` on `protractor_canned_jobs` docs at write
 * time, but shops that synced before that deploy keep an untagged doc until
 * their next sync/enrich cycle. Until then the create-WO push path still
 * falls back to the three-endpoint trial-and-error chain.
 *
 * This one-time sweep finds cache docs missing `listSource`, resolves the
 * list source per shop via fetchCannedJobs (LIST call only — cheap, no
 * per-template detail fan-out), and $sets `listSource` ONLY. Items are
 * never touched, so an "enriched" cache can't be downgraded.
 *
 * CAUTION: dev Mongo IS prod Mongo in this repl. Default mode is DRY-RUN
 * (it still makes the read-only Protractor list calls, but writes nothing).
 * The live write run is operator-gated — pass --apply only with sign-off.
 *
 * Usage (Render shell / off-peak):
 *   npx tsx scripts/backfill-canned-jobs-list-source.ts                # dry-run, all untagged shops
 *   npx tsx scripts/backfill-canned-jobs-list-source.ts 219 143        # dry-run, only these shopIds
 *   npx tsx scripts/backfill-canned-jobs-list-source.ts --apply        # WRITE listSource (operator-gated)
 *   npx tsx scripts/backfill-canned-jobs-list-source.ts --apply 219    # write for one shop
 */
import { fetchCannedJobs } from "@/lib/integrations/protractor";
import {
  findCannedJobsCachesMissingListSource,
  setCannedJobsCacheListSourceIfMissing,
} from "@/lib/data/repositories/protractor-canned-jobs";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlyShopIds = args
    .filter((a) => a !== "--apply")
    .map((a) => Number(a))
    .filter((n) => Number.isFinite(n) && n > 0);

  // Only docs missing the tag — never re-resolve/overwrite an existing value.
  const docs = await findCannedJobsCachesMissingListSource(
    onlyShopIds.length ? onlyShopIds : undefined,
  );

  console.log(
    `[listsource-backfill] ${docs.length} cache doc(s) missing listSource` +
      (onlyShopIds.length ? ` (restricted to shopIds: ${onlyShopIds.join(", ")})` : "") +
      `. Mode: ${apply ? "APPLY (writes enabled)" : "DRY-RUN (no writes)"}.`,
  );
  if (docs.length === 0) {
    console.log("[listsource-backfill] Nothing to do. Fleet is fully tagged.");
    process.exit(0);
  }

  let updated = 0;
  let skipped = 0;
  for (const doc of docs) {
    const shopId: number = doc.shopId;
    if (!Number.isFinite(shopId) || shopId <= 0) {
      console.error(`[listsource-backfill] SKIP doc with bad shopId: ${String(doc.shopId)}`);
      skipped += 1;
      continue;
    }
    try {
      const listResult = await fetchCannedJobs(shopId);
      if (!listResult.ok || !listResult.source) {
        console.error(
          `[listsource-backfill] shop ${shopId}: SKIP — list fetch ${listResult.ok ? "returned no source" : `failed: ${listResult.error}`}` +
            " (shop may be disconnected or endpoint chain exhausted).",
        );
        skipped += 1;
        continue;
      }

      if (!apply) {
        console.log(
          `[listsource-backfill] shop ${shopId}: would set listSource="${listResult.source}" ` +
            `(cache source=${doc.source ?? "(none)"}, fetchedAt=${doc.fetchedAt ? new Date(doc.fetchedAt).toISOString() : "(none)"}) [dry-run]`,
        );
        updated += 1;
        continue;
      }

      // $set listSource ONLY — items/source/fetchedAt untouched. The repo
      // helper guards on listSource still being absent so a concurrent
      // sync/enrich that already stamped a value is never overwritten.
      const wrote = await setCannedJobsCacheListSourceIfMissing(shopId, listResult.source);
      if (wrote) {
        console.log(`[listsource-backfill] shop ${shopId}: set listSource="${listResult.source}".`);
        updated += 1;
      } else {
        console.log(
          `[listsource-backfill] shop ${shopId}: no-op (doc gone or already tagged by a concurrent sync).`,
        );
        skipped += 1;
      }
    } catch (err: any) {
      console.error(`[listsource-backfill] shop ${shopId}: FAILED:`, err?.message ?? err);
      skipped += 1;
    }
  }

  console.log(
    `\n[listsource-backfill] DONE: ${updated} ${apply ? "updated" : "would update"}, ` +
      `${skipped} skipped/failed of ${docs.length} doc(s).` +
      (apply ? "" : " Re-run with --apply (operator sign-off + off-peak) to write."),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[listsource-backfill] Fatal:", err);
  process.exit(1);
});
