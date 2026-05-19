#!/usr/bin/env node
// Tekmetric API usage smoke check — task #458.
//
// Verifies that per-call Tekmetric instrumentation is actually landing in
// the unified `api_usage` Mongo collection (provider="tekmetric"). Diagnosis
// #443 (Q2) found the legacy Tekmetric-specific `tekmetric_api_usage`
// collection had 0 lifetime docs — the write path moved to `api_usage` via
// `lib/api-usage-tracker.ts#trackApiRequest('tekmetric', ...)` called from
// `lib/integrations/tekmetric/client.ts` on every request (success, 401,
// 429, 4xx/5xx, and network error paths). The admin Tekmetric usage view
// already reads from the new collection (task #449), but nobody noticed the
// fleet-wide zero counts for weeks because there was no smoke test asserting
// fresh docs were landing. This script closes that gap.
//
// What it checks:
//   - `api_usage` collection exists and is readable
//   - At least one provider="tekmetric" doc has been written in the last 60 min
//   - Per-shop breakdown for the last 60 min (matches what the admin UI shows)
//   - The legacy `tekmetric_api_usage` collection is empty (sanity check —
//     if it suddenly has fresh writes, somebody re-introduced the dead path)
//
// Usage:
//   MONGODB_USERNAME=... MONGODB_PASSWORD=... node scripts/tekmetric-usage-smoke.mjs
//
// Exits 0 if fresh Tekmetric usage docs were found in the last 60 min;
// exits 1 if the collection is empty or no recent writes (instrumentation
// regression). Suitable for a run-book or Better Stack heartbeat.

import { MongoClient } from "mongodb";

const user = encodeURIComponent(process.env.MONGODB_USERNAME || "");
const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || "");
if (!user || !pass) {
  console.error("MONGODB_USERNAME / MONGODB_PASSWORD must be set");
  process.exit(2);
}
const uri = `mongodb+srv://${user}:${pass}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(process.env.MONGODB_DB || "mos-maintenance-mvp");
  const now = new Date();
  const sixtyMinutesAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  const apiUsage = db.collection("api_usage");
  const [total60m, total5m, errors60m, rateLimited60m, topShops, latestRow, legacyCount] =
    await Promise.all([
      apiUsage.countDocuments({ provider: "tekmetric", timestamp: { $gte: sixtyMinutesAgo } }),
      apiUsage.countDocuments({ provider: "tekmetric", timestamp: { $gte: fiveMinutesAgo } }),
      apiUsage.countDocuments({ provider: "tekmetric", timestamp: { $gte: sixtyMinutesAgo }, isError: true }),
      apiUsage.countDocuments({ provider: "tekmetric", timestamp: { $gte: sixtyMinutesAgo }, $or: [{ isRateLimited: true }, { statusCode: 429 }] }),
      apiUsage
        .aggregate([
          { $match: { provider: "tekmetric", timestamp: { $gte: sixtyMinutesAgo }, shopId: { $exists: true, $ne: null } } },
          { $group: { _id: "$shopId", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ])
        .toArray(),
      apiUsage.find({ provider: "tekmetric" }).sort({ timestamp: -1 }).limit(1).toArray(),
      db.collection("tekmetric_api_usage").estimatedDocumentCount().catch(() => 0),
    ]);

  console.log(`api_usage (provider=tekmetric):`);
  console.log(`  last 60 min : ${total60m} docs`);
  console.log(`  last  5 min : ${total5m} docs`);
  console.log(`  errors 60m  : ${errors60m}`);
  console.log(`  429s   60m  : ${rateLimited60m}`);
  console.log(`  latest doc  : ${latestRow[0]?.timestamp ? new Date(latestRow[0].timestamp).toISOString() : "none"}`);

  console.log(`\nTop shops by call volume (last 60 min):`);
  if (topShops.length === 0) {
    console.log("  (none)");
  } else {
    for (const s of topShops) {
      console.log(`  shop=${String(s._id).padStart(6)}  calls=${s.count}`);
    }
  }

  console.log(`\nLegacy tekmetric_api_usage collection: ${legacyCount} docs (expected 0 — write path moved to api_usage)`);
  if (legacyCount > 0) {
    console.warn("  WARN: legacy collection has docs — somebody may have re-introduced the dead write path");
  }

  console.log("");
  if (total60m === 0) {
    console.error("FAIL: 0 Tekmetric usage docs in the last 60 min — instrumentation is silent, admin usage view will read zeroes");
    console.error("      Check that lib/integrations/tekmetric/client.ts is still calling trackApiRequest('tekmetric', ...)");
    console.error("      and that lib/api-usage-tracker.ts#flushToDb is reaching the api_usage collection.");
    process.exit(1);
  }
  console.log(`OK: Tekmetric instrumentation is alive — ${total60m} call records in last 60 min, latest ${Math.round((now.getTime() - new Date(latestRow[0].timestamp).getTime()) / 1000)}s ago`);
  process.exit(0);
} finally {
  await client.close();
}
