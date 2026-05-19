import { MongoClient } from "mongodb";
import { writeFileSync } from "fs";

const u = `mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
const c = new MongoClient(u);
await c.connect();
const db = c.db("mos-maintenance-mvp");

const now = Date.now();
const fmt = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—");
const days = (d) => (d ? ((now - new Date(d).getTime()) / 86_400_000).toFixed(1) : null);

// Q1: per-shop snapshot
const rows = await db.collection("tekmetric_backfill_progress").find({}).toArray();
const shops = await db.collection("shops").find({
  $or: [
    { "tekmetric.shopId": { $exists: true, $ne: null } },
    { tekmetricShopId: { $exists: true, $ne: null } },
  ],
}).project({ shopId: 1, name: 1, tekmetric: 1, tekmetricShopId: 1, tekmetricBackfillComplete: 1, createdAt: 1 }).toArray();
const shopMap = new Map(shops.map((s) => [Number(s.shopId), s]));

const enriched = rows.map((r) => {
  const shop = shopMap.get(Number(r.shopId));
  const mosShopId = shop?.tekmetric?.shopId || shop?.tekmetricShopId || null;
  const cursorAgeDays = r.currentChunkEnd ? ((now - new Date(r.currentChunkEnd).getTime()) / 86_400_000).toFixed(1) : null;
  const daysSinceRun = days(r.lastRunAt);
  const daysSinceActivity = days(r.lastActivityAt || r.lastCursorMoveAt || r.lastRunAt);
  const inFlightActive = r.inFlightUntil && new Date(r.inFlightUntil).getTime() > now;
  const inFlightExpired = r.inFlightUntil && new Date(r.inFlightUntil).getTime() <= now;

  let category = "other";
  if (r.completed) category = "completed";
  else if (!shop) category = "orphan-no-shop-row";
  else if (!mosShopId) category = "orphan-no-tekmetric-link";
  else if (!r.lastRunAt) category = "never-started";
  else if (r.fullPageMode) {
    const fpAgeDays = r.lastFullPageRunAt ? ((now - new Date(r.lastFullPageRunAt).getTime()) / 86_400_000) : 999;
    category = fpAgeDays > 1 ? "fullpage-jammed" : "fullpage-running";
  } else if (r.lastError) category = "stuck-on-error";
  else if (r.consecutiveChunkErrors >= 3) category = "consecutive-chunk-errors";
  else if (daysSinceRun && Number(daysSinceRun) > 3) category = "frozen-cursor-no-error";
  else category = "running-normally";

  return {
    shopId: Number(r.shopId),
    mosShopId,
    name: shop?.name || `shop ${r.shopId}`,
    category,
    completed: !!r.completed,
    fullPageMode: !!r.fullPageMode,
    needsFullPageReindex: !!r.needsFullPageReindex,
    fullPageNextPage: r.fullPageNextPage ?? null,
    fullPageTotalPages: r.fullPageTotalPages ?? null,
    lastFullPageRunAt: r.lastFullPageRunAt || null,
    currentChunkEnd: r.currentChunkEnd || null,
    cursorAgeDays,
    lastRunAt: r.lastRunAt || null,
    daysSinceRun,
    lastActivityAt: r.lastActivityAt || null,
    daysSinceActivity,
    lastError: r.lastError ? String(r.lastError).slice(0, 240) : null,
    lastErrorAt: r.lastErrorAt || null,
    consecutiveChunkErrors: r.consecutiveChunkErrors || 0,
    consecutiveRoSkipRuns: r.consecutiveRoSkipRuns || 0,
    recentSkippedRosCount: Array.isArray(r.recentSkippedRos) ? r.recentSkippedRos.length : 0,
    totalJobsIndexed: r.totalJobsIndexed || 0,
    inFlightUntil: r.inFlightUntil || null,
    inFlightOwner: r.inFlightOwner || null,
    inFlightStartedAt: r.inFlightStartedAt || null,
    inFlightActive,
    inFlightExpired,
    logicVersion: r.logicVersion ?? null,
    autoClearedErrorAt: r.autoClearedErrorAt || null,
    prePassDone: !!r.prePassDone,
    prePassNextPage: r.prePassNextPage ?? null,
    vehiclesPrePassDone: !!r.vehiclesPrePassDone,
    customersPrePassDone: !!r.customersPrePassDone,
    queuedAt: r.queuedAt || null,
  };
});

const incomplete = enriched.filter((e) => !e.completed);
const summary = {};
for (const e of incomplete) summary[e.category] = (summary[e.category] || 0) + 1;

console.log("=== Q1: per-shop snapshot summary ===");
console.log(`Total progress rows: ${rows.length}`);
console.log(`Completed:           ${enriched.filter((e) => e.completed).length}`);
console.log(`Incomplete:          ${incomplete.length}`);
console.log("By category:", summary);

// Q5: full-page worker
const fpShops = incomplete.filter((e) => e.fullPageMode);
console.log("\n=== Q5: full-page mode shops ===");
console.log(`Count: ${fpShops.length}`);
for (const s of fpShops) {
  console.log(`  shop=${s.shopId} ${s.name.slice(0,25)} | page ${s.fullPageNextPage}/${s.fullPageTotalPages} | lastFP=${fmt(s.lastFullPageRunAt)} | inFlightExpired=${s.inFlightExpired} | jobs=${s.totalJobsIndexed}`);
}

// Q7: consecutive chunk errors
const errShops = incomplete.filter((e) => e.consecutiveChunkErrors >= 3 || e.lastError);
console.log(`\n=== Q7: shops with errors (count=${errShops.length}) ===`);
for (const s of errShops.slice(0, 30)) {
  console.log(`  shop=${s.shopId} ${s.name.slice(0,25)} | consec=${s.consecutiveChunkErrors} | lastErrAt=${fmt(s.lastErrorAt)} | err=${s.lastError?.slice(0,140)}`);
}

// Q8: rate limiter buckets
const buckets = await db.collection("tekmetric_rate_buckets").find({}).sort({ _id: -1 }).limit(60).toArray();
console.log(`\n=== Q8: tekmetric_rate_buckets (recent ${buckets.length}) ===`);
const overcap = buckets.filter((b) => (b.count || 0) > 8);
console.log(`Buckets total: ${buckets.length}, over cap (>8): ${overcap.length}`);
const max = Math.max(0, ...buckets.map((b) => b.count || 0));
console.log(`Max count seen: ${max}`);
console.log("Sample (last 10):", buckets.slice(0, 10).map((b) => `${b._id}=${b.count}`).join(" "));

// Q3: skipped ROs aggregate
console.log("\n=== Q3: recentSkippedRos aggregate ===");
const allSkipped = incomplete.flatMap((e) => {
  const r = rows.find((x) => Number(x.shopId) === e.shopId);
  return (r?.recentSkippedRos || []).map((s) => ({ shopId: e.shopId, ...s }));
});
console.log(`Total entries on live recentSkippedRos: ${allSkipped.length}`);
const errSig = {};
for (const s of allSkipped) {
  const sig = (s.error || "unknown").slice(0, 80);
  errSig[sig] = (errSig[sig] || 0) + 1;
}
const sortedSig = Object.entries(errSig).sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log("Top error signatures:");
for (const [sig, n] of sortedSig) console.log(`  ${n.toString().padStart(4)} × ${sig}`);

// archive collection
const archiveCount = await db.collection("tekmetric_skipped_ro_archive").estimatedDocumentCount();
const archiveSince = new Date(now - 7 * 86_400_000);
const archiveRecent = await db.collection("tekmetric_skipped_ro_archive").countDocuments({ archivedAt: { $gte: archiveSince } });
console.log(`Archive total: ${archiveCount}, archived in last 7d: ${archiveRecent}`);

// Q6: queue order (mimic getShopsNeedingBackfill)
console.log("\n=== Q6: queue order (next 30 picks) ===");
const queue = incomplete
  .filter((e) => e.category !== "orphan-no-shop-row" && e.category !== "orphan-no-tekmetric-link" && !e.fullPageMode)
  .sort((a, b) => {
    if (!a.lastRunAt && b.lastRunAt) return -1;
    if (a.lastRunAt && !b.lastRunAt) return 1;
    if (a.lastRunAt && b.lastRunAt) {
      const diff = new Date(a.lastRunAt).getTime() - new Date(b.lastRunAt).getTime();
      if (diff !== 0) return diff;
    }
    return 0;
  });
console.log(`Total chunker-eligible incomplete: ${queue.length}`);
console.log("Top 30:");
for (const e of queue.slice(0, 30)) {
  console.log(`  shop=${e.shopId} ${e.name.slice(0,25).padEnd(25)} | lastRun=${fmt(e.lastRunAt)} | cat=${e.category} | jobs=${e.totalJobsIndexed}`);
}

// Q2: Are chunks running? Check api_usage / sync_metrics
const apiUsageCount = await db.collection("api_usage").countDocuments({
  service: "tekmetric",
  timestamp: { $gte: new Date(now - 86_400_000) },
}).catch(() => -1);
console.log(`\n=== Q2 (partial): tekmetric api_usage entries in last 24h: ${apiUsageCount} ===`);

// cron_runs collection
const cronRuns = await db.collection("cron_runs")
  .find({ name: { $in: ["tekmetric-backfill", "weekend-backfill-boost", "monday-backfill-catchup-boost", "fullpage-backfill-tekmetric", "new-shop-backfill-fastpath"] }, startedAt: { $gte: new Date(now - 7 * 86_400_000) } })
  .sort({ startedAt: -1 })
  .toArray()
  .catch(() => []);
console.log(`\n=== Q2: cron_runs for backfill (7d, count=${cronRuns.length}) ===`);
const byName = {};
for (const r of cronRuns) {
  byName[r.name] = byName[r.name] || { total: 0, success: 0, error: 0, lastStart: null };
  byName[r.name].total++;
  if (r.success) byName[r.name].success++; else byName[r.name].error++;
  if (!byName[r.name].lastStart || new Date(r.startedAt) > new Date(byName[r.name].lastStart)) byName[r.name].lastStart = r.startedAt;
}
console.log(JSON.stringify(byName, null, 2));

// Save evidence
writeFileSync(
  ".local/tasks/diagnose-backfill-evidence/per-shop-snapshot.json",
  JSON.stringify({ generatedAt: new Date(now).toISOString(), summary, rows: enriched }, null, 2),
);
writeFileSync(
  ".local/tasks/diagnose-backfill-evidence/skipped-ros-error-signatures.json",
  JSON.stringify({ totalLiveEntries: allSkipped.length, archiveTotal: archiveCount, archivedLast7d: archiveRecent, topSignatures: sortedSig }, null, 2),
);
writeFileSync(
  ".local/tasks/diagnose-backfill-evidence/rate-buckets-sample.json",
  JSON.stringify({ sample: buckets.slice(0, 30), overcapCount: overcap.length, maxCount: max }, null, 2),
);
writeFileSync(
  ".local/tasks/diagnose-backfill-evidence/cron-runs-7d.json",
  JSON.stringify({ byName, recent: cronRuns.slice(0, 50) }, null, 2),
);

console.log("\nEvidence written to .local/tasks/diagnose-backfill-evidence/");

await c.close();
