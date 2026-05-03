#!/usr/bin/env node
/**
 * One-shot utility to clear STALE drain locks left behind when a previous
 * drain process was SIGKILL'd before its release ran (Render deploy
 * restart, OOM, manual `kill -9`, dropped shell session).
 *
 * Run: `node scripts/clear-stale-drain-locks.mjs`
 *
 * Safe to run AT ANY TIME — including while a healthy drain is active.
 * Only stale locks (older than the same threshold the drain itself uses
 * to detect a dead owner) are touched. A live, refreshing drain is left
 * completely alone.
 *
 * Affects:
 *   - tekmetric_drain_lock      singleton doc (_id: "global"). Deleted
 *                               only when expiresAt has already passed
 *                               (drain refreshes every 60s, expires after
 *                               5 min — so any expired doc is genuinely
 *                               abandoned).
 *
 *   - backfill_progress         per-shop Protractor docs. The "lock" is
 *                               the `inProgress: true` field. We DO NOT
 *                               delete the doc (that would wipe the
 *                               backfill cursor). We unset `inProgress`
 *                               only where lastActivityAt is older than
 *                               STALE_THRESHOLD_MS (30 min — matches
 *                               lib/integrations/protractor/sync.ts).
 *
 * Output reports counts with cosmetic-vs-real distinction so it's clear
 * whether anything actually needed cleaning.
 */

import { MongoClient } from "mongodb";

// Must match lib/integrations/protractor/sync.ts STALE_THRESHOLD_MS and
// scripts/drain-protractor-backfill.ts STALE_LOCK_THRESHOLD_MS
const PROTRACTOR_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function getMongoUri() {
  if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes("localhost")) {
    return process.env.MONGODB_URI;
  }
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  if (username && password) {
    const encoded = encodeURIComponent(password);
    return `mongodb+srv://${username}:${encoded}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  }
  throw new Error(
    "Missing MongoDB credentials — set MONGODB_URI or MONGODB_USERNAME + MONGODB_PASSWORD."
  );
}

const client = new MongoClient(getMongoUri());
await client.connect();
const db = client.db("mos-maintenance-mvp");

const now = new Date();

// --- Tekmetric: only delete the singleton lock if it has actually expired.
const tekLock = await db
  .collection("tekmetric_drain_lock")
  .findOne({ _id: "global" });

let tekDeleted = 0;
if (!tekLock) {
  console.log("tekmetric_drain_lock: no lock present — nothing to clear");
} else {
  const expiresAt = tekLock.expiresAt ? new Date(tekLock.expiresAt) : null;
  const ageMin = expiresAt
    ? ((now.getTime() - expiresAt.getTime()) / 60000).toFixed(1)
    : "?";
  if (!expiresAt || expiresAt <= now) {
    const result = await db
      .collection("tekmetric_drain_lock")
      .deleteOne({ _id: "global", owner: tekLock.owner });
    tekDeleted = result.deletedCount;
    console.log(
      `tekmetric_drain_lock: STALE (owner=${tekLock.owner} expired ${ageMin}min ago) — deleted ${tekDeleted}`
    );
  } else {
    const remainingMin = ((expiresAt.getTime() - now.getTime()) / 60000).toFixed(1);
    console.log(
      `tekmetric_drain_lock: LIVE (owner=${tekLock.owner} expires in ${remainingMin}min) — leaving alone`
    );
  }
}

// --- Protractor: clear stale per-shop inProgress flags WITHOUT deleting
// the backfill_progress docs (which hold the cursor).
const staleCutoff = new Date(now.getTime() - PROTRACTOR_STALE_THRESHOLD_MS);
const staleQuery = {
  inProgress: true,
  $or: [
    { lastActivityAt: { $lt: staleCutoff } },
    { lastActivityAt: { $exists: false } },
  ],
};

const staleDocs = await db
  .collection("backfill_progress")
  .find(staleQuery, { projection: { shopId: 1, lastActivityAt: 1 } })
  .toArray();

const liveCount = await db
  .collection("backfill_progress")
  .countDocuments({ inProgress: true });

const liveButNotStale = liveCount - staleDocs.length;

if (staleDocs.length === 0) {
  console.log(
    `backfill_progress: no stale inProgress flags found (${liveCount} live shop(s) still actively working — leaving alone)`
  );
} else {
  const result = await db.collection("backfill_progress").updateMany(staleQuery, {
    $set: { inProgress: false, staleClearedAt: now },
  });
  console.log(
    `backfill_progress: cleared inProgress on ${result.modifiedCount} stale shop(s) (${liveButNotStale} live shop(s) untouched)`
  );
  for (const doc of staleDocs) {
    const lastActivityMin = doc.lastActivityAt
      ? ((now.getTime() - new Date(doc.lastActivityAt).getTime()) / 60000).toFixed(1)
      : "never";
    console.log(`  - shop=${doc.shopId} lastActivity=${lastActivityMin}min ago`);
  }
}

await client.close();
process.exit(0);
