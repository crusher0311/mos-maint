#!/usr/bin/env node
/**
 * One-shot utility to clear stale drain locks left behind when a previous
 * drain process was SIGKILL'd before its SIGTERM release ran (e.g. Render
 * deploy restart, OOM, manual `kill -9`).
 *
 * Run: `node scripts/clear-stale-drain-locks.mjs`
 *
 * Clears:
 *   - tekmetric_drain_lock           (global lease used by drain-tekmetric)
 *   - protractor_backfill_locks      (per-shop locks used by cron + drain)
 *
 * Safe to run anytime no drain is currently running. Output reports how
 * many docs were deleted from each collection.
 */

import { MongoClient } from "mongodb";

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
  throw new Error("Missing MongoDB credentials");
}

const client = new MongoClient(getMongoUri());
await client.connect();
const db = client.db("mos-maintenance-mvp");

const tek = await db.collection("tekmetric_drain_lock").deleteMany({});
console.log(`tekmetric_drain_lock: deleted ${tek.deletedCount}`);

const pro = await db.collection("protractor_backfill_locks").deleteMany({});
console.log(`protractor_backfill_locks: deleted ${pro.deletedCount}`);

await client.close();
process.exit(0);
