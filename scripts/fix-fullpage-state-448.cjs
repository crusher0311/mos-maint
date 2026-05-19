#!/usr/bin/env node
/**
 * Task #448 — one-off repair of the 4 corrupted full-page-backfill
 * progress rows identified in #443 diagnosis (Q5):
 *
 *   - Shop 82, 122: in-flight lock held for days, last real page
 *     progress 2026-05-10. Clear the lock fields so the next cron tick
 *     acquires cleanly. The new heartbeat-staleness check
 *     (lib/integrations/tekmetric/inflight-lock.ts) prevents this from
 *     recurring once deployed, but the existing stale fields still need
 *     a one-time clear because some are within their 6-min TTL window
 *     and would otherwise block the first post-deploy tick.
 *
 *   - Shop 112, 123: `fullPageTotalPages = 0` while
 *     `fullPageNextPage > 0` — corrupted state from a prior bad API
 *     response. Reset `fullPageNextPage = 0` and unset
 *     `fullPageTotalPages` so the chunker re-walks from page 0 with a
 *     fresh totalPages from Tekmetric. The chunker is idempotent
 *     (contentHash skip on unchanged rows) so re-walking is safe.
 *
 * Usage:
 *   DRY_RUN=1 node scripts/fix-fullpage-state-448.cjs   (preview)
 *           node scripts/fix-fullpage-state-448.cjs     (apply)
 *
 * Idempotent: safe to re-run. Re-running after the chunker has made
 * real progress on a target shop is also safe — it just resets that
 * shop's full-page cursor and locks again (next run re-indexes).
 */

const { MongoClient } = require("mongodb");

const STUCK_LOCK_SHOPS = [82, 122];
const CORRUPT_TOTALPAGES_SHOPS = [112, 123];
const DRY_RUN = process.env.DRY_RUN === "1";

function getUri() {
  if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes("localhost")) {
    return process.env.MONGODB_URI;
  }
  const u = process.env.MONGODB_USERNAME;
  const p = process.env.MONGODB_PASSWORD;
  if (!u || !p) throw new Error("Missing MONGODB_USERNAME/PASSWORD");
  return `mongodb+srv://${u}:${encodeURIComponent(p)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
}

function fmt(d) {
  return d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—";
}

(async () => {
  const client = new MongoClient(getUri());
  await client.connect();
  const db = client.db("mos-maintenance-mvp");
  const progress = db.collection("tekmetric_backfill_progress");

  console.log(`mode: ${DRY_RUN ? "DRY-RUN" : "APPLY"}\n`);

  console.log("== Clear stuck in-flight locks ==");
  for (const shopId of STUCK_LOCK_SHOPS) {
    const before = await progress.findOne({ shopId });
    if (!before) {
      console.log(`Shop ${shopId}: NO progress row, skipping`);
      continue;
    }
    console.log(
      `Shop ${shopId}: inFlightOwner=${before.inFlightOwner || "—"} inFlightUntil=${fmt(before.inFlightUntil)} inFlightStartedAt=${fmt(before.inFlightStartedAt)} lastFullPageRunAt=${fmt(before.lastFullPageRunAt)} fullPageNextPage=${before.fullPageNextPage} fullPageTotalPages=${before.fullPageTotalPages}`,
    );
    if (DRY_RUN) {
      console.log(`  would $unset inFlightUntil/inFlightStartedAt/inFlightOwner/inFlightHeartbeatAt`);
      continue;
    }
    const res = await progress.updateOne(
      { shopId },
      {
        $unset: {
          inFlightUntil: "",
          inFlightStartedAt: "",
          inFlightOwner: "",
          inFlightHeartbeatAt: "",
        },
      },
    );
    console.log(`  cleared (matched=${res.matchedCount} modified=${res.modifiedCount})`);
  }

  console.log("\n== Reset corrupted totalPages=0 + advance-with-no-cap state ==");
  for (const shopId of CORRUPT_TOTALPAGES_SHOPS) {
    const before = await progress.findOne({ shopId });
    if (!before) {
      console.log(`Shop ${shopId}: NO progress row, skipping`);
      continue;
    }
    console.log(
      `Shop ${shopId}: fullPageNextPage=${before.fullPageNextPage} fullPageTotalPages=${before.fullPageTotalPages} lastFullPageRunAt=${fmt(before.lastFullPageRunAt)} fullPageMode=${before.fullPageMode}`,
    );
    if (DRY_RUN) {
      console.log(`  would set fullPageNextPage=0, $unset fullPageTotalPages + lock fields, ensure fullPageMode=true`);
      continue;
    }
    const res = await progress.updateOne(
      { shopId },
      {
        $set: {
          fullPageNextPage: 0,
          fullPageMode: true,
        },
        $unset: {
          fullPageTotalPages: "",
          inFlightUntil: "",
          inFlightStartedAt: "",
          inFlightOwner: "",
          inFlightHeartbeatAt: "",
        },
      },
    );
    console.log(`  reset (matched=${res.matchedCount} modified=${res.modifiedCount})`);
  }

  console.log("\ndone.");
  await client.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
