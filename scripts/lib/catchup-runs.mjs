// Helpers for persisting the Tekmetric catch-up script's end-of-run summary
// (task #181). Lives next to the script so the .mjs runner can `import` it
// directly without going through the TS build, and is re-imported by the
// regression smoke test under tests/.
//
// The catch-up script's SUMMARY block is currently stdout-only. If the
// operator's terminal/SSH session dies or the logfile gets rotated, they
// have to re-run the whole multi-hour catch-up to figure out which shops
// still need follow-up. Persisting a small, structured record per run into
// a Mongo collection lets the admin sync-health view (and a future API
// consumer) read back the last few runs without grepping a log.

// Keep the most-recent N runs in `tekmetric_catchup_runs`. Twenty is the
// number called out in task #181 — enough to cover several weeks of
// daily / on-demand catch-ups while keeping the collection tiny.
export const CATCHUP_RUN_RETENTION = 20;

export const CATCHUP_RUN_COLLECTION = "tekmetric_catchup_runs";

/**
 * Build the structured summary record that matches what the SUMMARY block
 * prints to stdout. Pure: no Mongo / Date.now calls; the caller passes in
 * the start/finish timestamps so a single source of truth is shared across
 * the persisted record, the printed log, and the API response.
 *
 * `results` is the list of per-shop outcomes from `processShop` (each
 * entry has `shopId`, `outcome`, and an optional `reason`).
 */
export function buildCatchupRunSummary({
  results,
  dryRun,
  onlyShops,
  skipShops,
  startedAt,
  finishedAt,
  prodBaseUrl,
}) {
  const safeArr = Array.isArray(results) ? results : [];
  const completed = safeArr.filter((r) => r?.outcome === "completed");
  const recovered = safeArr.filter((r) => r?.outcome === "recovered");
  const needsFollowup = safeArr.filter((r) => r?.outcome === "needs-followup");
  const dryRunOutcomes = safeArr.filter((r) => r?.outcome === "dry-run");

  const shopIds = (rs) => rs.map((r) => Number(r.shopId)).filter((n) => Number.isFinite(n));
  const followupShopIds = shopIds(needsFollowup);

  const suggestedRerunCommand = followupShopIds.length > 0
    ? `ONLY_SHOPS=${followupShopIds.join(",")} node scripts/tekmetric-catchup.mjs`
    : null;

  const startedAtDate = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const finishedAtDate = finishedAt instanceof Date ? finishedAt : new Date(finishedAt);
  const durationMs = Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime());

  return {
    startedAt: startedAtDate,
    finishedAt: finishedAtDate,
    durationMs,
    prodBaseUrl: prodBaseUrl || null,
    dryRun: !!dryRun,
    filters: {
      onlyShops: Array.isArray(onlyShops) ? [...onlyShops] : [],
      skipShops: Array.isArray(skipShops) ? [...skipShops] : [],
    },
    totals: {
      processed: safeArr.length,
      completed: completed.length,
      recovered: recovered.length,
      needsFollowup: needsFollowup.length,
      dryRun: dryRunOutcomes.length,
    },
    completedShopIds: shopIds(completed),
    recoveredShopIds: shopIds(recovered),
    dryRunShopIds: shopIds(dryRunOutcomes),
    needsFollowup: needsFollowup.map((r) => ({
      shopId: Number(r.shopId),
      reason: r.reason || null,
    })),
    suggestedRerunCommand,
  };
}

/**
 * Persist a summary record into the catchup-runs collection and prune
 * everything past the retention window. Insert-then-prune (rather than
 * cap-then-insert) keeps the most-recent run safe even if the prune query
 * fails partway through. Errors are returned, never thrown — the script
 * has already completed real work by the time we get here, so a Mongo
 * hiccup writing the artifact must not poison its exit code.
 */
export async function persistCatchupRunSummary(db, summary, { keep = CATCHUP_RUN_RETENTION } = {}) {
  if (!db || typeof db.collection !== "function") {
    return { ok: false, error: "no db" };
  }
  try {
    const coll = db.collection(CATCHUP_RUN_COLLECTION);
    const insertRes = await coll.insertOne({ ...summary });
    // Prune older runs beyond the retention window. Sort by startedAt desc
    // (with _id as a stable tie-break) so two back-to-back runs at the same
    // millisecond don't accidentally evict each other.
    const keepDocs = await coll
      .find({}, { projection: { _id: 1 } })
      .sort({ startedAt: -1, _id: -1 })
      .limit(keep)
      .toArray();
    const keepIds = keepDocs.map((d) => d._id);
    let prunedCount = 0;
    if (keepIds.length > 0) {
      const delRes = await coll.deleteMany({ _id: { $nin: keepIds } });
      prunedCount = delRes?.deletedCount ?? 0;
    }
    return { ok: true, insertedId: insertRes?.insertedId ?? null, prunedCount };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
