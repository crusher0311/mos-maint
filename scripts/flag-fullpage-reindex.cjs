#!/usr/bin/env node
// One-off: flag Casey shops 122/123/112 + Duxler 82 for full-page
// reindex. The new fullpage-backfill-tekmetric cron (every 2 min) will
// pick them up and start draining. Idempotent: safe to re-run.
//
// Usage: DRY_RUN=1 node scripts/flag-fullpage-reindex.cjs   (preview)
//        node scripts/flag-fullpage-reindex.cjs              (apply)

const { MongoClient } = require("mongodb");

const SHOP_IDS = [122, 123, 112, 82];
const DRY_RUN = process.env.DRY_RUN === "1";

function getUri() {
  if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes("localhost")) return process.env.MONGODB_URI;
  const u = process.env.MONGODB_USERNAME;
  const p = process.env.MONGODB_PASSWORD;
  if (!u || !p) throw new Error("Missing MONGODB_USERNAME/PASSWORD");
  return `mongodb+srv://${u}:${encodeURIComponent(p)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
}

(async () => {
  const client = new MongoClient(getUri());
  await client.connect();
  const db = client.db("mos-maintenance-mvp");
  const shops = db.collection("shops");
  const progress = db.collection("tekmetric_backfill_progress");

  console.log(`mode: ${DRY_RUN ? "DRY-RUN" : "APPLY"}\n`);

  for (const shopId of SHOP_IDS) {
    const shop = await shops.findOne({ shopId }, { projection: { name: 1, "tekmetric.shopId": 1 } });
    const bf = await progress.findOne({ shopId });
    const tag = `Shop ${shopId} (${shop?.name || "?"})`;
    if (!shop) {
      console.log(`${tag}: NOT FOUND, skipping`);
      continue;
    }
    if (!shop.tekmetric?.shopId) {
      console.log(`${tag}: not a Tekmetric shop, skipping`);
      continue;
    }
    console.log(`${tag}:`);
    console.log(`  before: completed=${bf?.completed} jobs=${bf?.totalJobsIndexed || 0} processed=${bf?.processedCount || 0} fullPageMode=${bf?.fullPageMode || false}`);

    if (DRY_RUN) {
      console.log(`  would set fullPageMode=true, fullPageNextPage=0, needsFullPageReindex=true`);
      continue;
    }

    const now = new Date();
    const res = await progress.updateOne(
      { shopId },
      {
        $set: {
          shopId,
          fullPageMode: true,
          fullPageNextPage: 0,
          needsFullPageReindex: true,
          fullPageQueuedAt: now,
          fullPageQueueReason: `manual flag via flag-fullpage-reindex.cjs (bulk-migrated history not visible to date-window chunker)`,
        },
      },
      { upsert: true },
    );
    const after = await progress.findOne({ shopId });
    console.log(`  after:  fullPageMode=${after?.fullPageMode} fullPageNextPage=${after?.fullPageNextPage} matched=${res.matchedCount} upserted=${res.upsertedCount ? 1 : 0}`);
  }

  await client.close();
  console.log(`\ndone.`);
})().catch((e) => { console.error(e); process.exit(1); });
