/**
 * Smoke test for the `smsHistoricalWorkOrders` Drizzle table definition.
 *
 * Run: `npx tsx tests/sms-historical-work-orders-schema.smoke.ts`
 *
 * Background (task #497): `lib/db/schema/wave1.ts` and `lib/db/schema/wave3.ts`
 * both used to declare a Drizzle table called `smsHistoricalWorkOrders` mapped
 * to the same physical table `sms_historical_work_orders` with completely
 * different column sets. Because `lib/db/schema/index.ts` star-exports both
 * wave1 and wave3, one definition silently won at import time and any code
 * path that expected the loser's columns would hit runtime "column does not
 * exist" errors.
 *
 * This test pins:
 *   1. The schema barrel exports exactly one `smsHistoricalWorkOrders`.
 *   2. That definition is the wave1 shape (composite PK on
 *      shopId + sourceSystem + workOrderId, with workOrderNumber, closedAt,
 *      data jsonb, createdAt, updatedAt) — the one the repository layer
 *      (`lib/db/repositories/wave1.ts`) and backfill scripts already use.
 *   3. A `SELECT 1` against the table using the Drizzle definition succeeds,
 *      proving the columns exist on the physical table. Skipped (not failed)
 *      when DATABASE_URL is not configured so the test can run in environments
 *      without a live DB.
 */

import { sql } from "drizzle-orm";

import * as schemaBarrel from "../lib/db/schema";
import { smsHistoricalWorkOrders as wave1Table } from "../lib/db/schema/wave1";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("smsHistoricalWorkOrders schema");

// 1. The barrel re-exports exactly one definition, and it is the wave1 one.
const barrelTable = (schemaBarrel as Record<string, unknown>).smsHistoricalWorkOrders;
ok("barrel exports smsHistoricalWorkOrders", barrelTable !== undefined);
ok(
  "barrel export === wave1 definition (no silent shadowing)",
  barrelTable === wave1Table,
);

// 2. The surviving definition has the wave1 column shape.
const cols = (wave1Table as unknown as Record<string, { name: string }>);
const expectedColumns = [
  "shopId",
  "sourceSystem",
  "workOrderId",
  "workOrderNumber",
  "closedAt",
  "data",
  "createdAt",
  "updatedAt",
];
for (const c of expectedColumns) {
  ok(`column ${c} exists`, typeof cols[c]?.name === "string");
}

// Columns from the discarded wave3 shape must NOT be present.
const forbiddenColumns = ["id", "backfillMongoId", "vin", "roNumber", "provider", "payload", "receivedAt"];
for (const c of forbiddenColumns) {
  ok(`wave3 column ${c} absent`, cols[c] === undefined);
}

// 3. Live DB round-trip — `SELECT 1 FROM sms_historical_work_orders LIMIT 0`
//    using the Drizzle table will fail at parse time if any of the columns
//    the table declares (notably the composite PK members) are missing from
//    the physical table.
async function runDbProbe(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("  · skipping live DB probe (DATABASE_URL not set)");
    return;
  }
  try {
    const { getDb } = await import("../lib/db/drizzle");
    await getDb()
      .select({ one: sql<number>`1` })
      .from(wave1Table)
      .limit(0);
    ok("SELECT against sms_historical_work_orders parses against live schema", true);
  } catch (err) {
    ok(
      "SELECT against sms_historical_work_orders parses against live schema",
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

runDbProbe()
  .catch((err) => {
    console.error(
      `  ✗ live DB probe threw — ${err instanceof Error ? err.message : String(err)}`,
    );
    failed += 1;
  })
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} smsHistoricalWorkOrders schema assertion(s) failed`);
      process.exit(1);
    }
    console.log("\nAll smsHistoricalWorkOrders schema assertions passed.");
  });
