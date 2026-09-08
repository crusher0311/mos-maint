/**
 * Static migration guard only; it performs no database operations.
 *
 * The optional hook-real-pg-test must additionally SET ROLE to a synthetic
 * non-owner equivalent of Supabase anon/authenticated, insert as the owner,
 * and prove SELECT returns zero rows (or permission denied) for every table.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  appfueledUrlConnections,
  appfueledUrlRateBuckets,
  appfueledUrlReceipts,
  appfueledVehicleUrls,
} from "../lib/db/schema/appfueled-url-events";

const names = [
  "appfueled_url_connections",
  "appfueled_url_receipts",
  "appfueled_vehicle_urls",
  "appfueled_url_rate_buckets",
];
const migration = readFileSync("drizzle/0036_task1257_appfueled_url_events.sql", "utf8");

for (const name of names) {
  assert.match(migration, new RegExp(
    `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;`,
  ), `${name} must deny Supabase API roles by default`);
  assert.doesNotMatch(migration, new RegExp(
    `CREATE\\s+POLICY[\\s\\S]{0,200}(?:ON\\s+)?${name}`,
    "i",
  ), `${name} must not have a public RLS policy`);
}

for (const table of [
  appfueledUrlConnections,
  appfueledUrlReceipts,
  appfueledVehicleUrls,
  appfueledUrlRateBuckets,
]) {
  const config = getTableConfig(table);
  assert.equal(config.enableRLS, true, `${config.name} Drizzle schema must mirror migration RLS`);
  assert.equal(config.policies.length, 0, `${config.name} must remain deny-by-default`);
}

console.log("✓ AppFueled URL event tables are deny-by-default RLS");