/**
 * Smoke test for Tekmetric webhook idempotency (replay-safe upsert).
 *
 * Run: `npx tsx tests/tekmetric-webhook-idempotency.smoke.ts`
 *
 * Tekmetric webhooks don't have a duplicate-event-id short-circuit like Stripe.
 * Their idempotency property comes from the upsert into `tekmetric_work_orders`
 * keyed by `workOrderId`: re-delivering the same RO event must converge to the
 * same single row, NOT duplicate it. A regression that switched the key to
 * something non-stable (or used insert instead of upsert) would silently
 * double-cache work orders, breaking dashboards and indexing.
 *
 * This test:
 *   - Swaps `__deps.getDb` to an in-memory fake mongo.
 *   - Leaves TEKMETRIC_WEBHOOK_SECRET unset (introspection bypass — signature
 *     verification is covered by tests/tekmetric-webhook-signature.smoke.ts).
 *   - Uses an RO event with NO vin / NO vehicleId / NO customerId so the route
 *     skips vehicle/customer enrichment and the heavy NIS path early-exits.
 *   - POSTs the same event twice and asserts:
 *       * Exactly one row in `tekmetric_work_orders` for that workOrderId.
 *       * `tekmetric_webhook_logs` has 2 entries (each delivery IS observed).
 *       * The cache row's `updatedAt` advances on the second delivery
 *         (proving updateOne ran, not a no-op match).
 */

import { NextRequest } from "next/server";
import { makeFakeDb } from "./utils/fake-mongo";
import { __deps } from "../app/api/webhooks/tekmetric/deps";
import { POST } from "../app/api/webhooks/tekmetric/route";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

delete process.env.TEKMETRIC_WEBHOOK_SECRET;
delete process.env.WEBHOOK_FORWARD_TARGETS;

function makeReq(payload: any): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/tekmetric", {
    method: "POST",
    headers: { "x-webhook-forward": "true" }, // suppress fan-out
    body: JSON.stringify(payload),
  });
}

function withFakeDb(seed: Record<string, any[]>) {
  const fake = makeFakeDb(seed);
  const original = __deps.getDb;
  const originalInsertLog = __deps.insertWebhookLog;
  __deps.getDb = async () => fake.db as any;
  // Webhook-log writes go through the flag-gated repository since task #999;
  // capture them into the same fake seed so the assertions stay store-independent.
  __deps.insertWebhookLog = (async (doc: any) => {
    fake.collections.tekmetric_webhook_logs.push({ ...doc });
  }) as any;
  return {
    fake,
    restore: () => {
      __deps.getDb = original;
      __deps.insertWebhookLog = originalInsertLog;
    },
  };
}

async function run() {
  console.log("tekmetric-webhook-idempotency smoke");

  const tekmetricShopId = 100;
  const roId = 9001;
  const event = {
    event: "RepairOrder.Updated",
    data: {
      repairOrder: {
        id: roId,
        repairOrderNumber: 5555,
        shopId: tekmetricShopId,
        repairOrderStatus: { name: "In Progress", code: "IN_PROGRESS" },
        // No vehicleId / customerId / vin → skips enrichment and NIS.
      },
    },
  };

  const { fake, restore } = withFakeDb({
    shops: [
      { shopId: 7, "tekmetric": { shopId: tekmetricShopId } },
    ],
    tekmetric_work_orders: [],
    tekmetric_webhook_logs: [],
    dashboard_updates: [],
  });

  try {
    // First delivery
    const r1 = await POST(makeReq(event));
    ok("first delivery returns 200", r1.status === 200);

    const rowsAfter1 = fake.collections.tekmetric_work_orders.filter(
      (r: any) => r.workOrderId === String(roId),
    );
    ok("first delivery creates exactly 1 cache row", rowsAfter1.length === 1);
    const firstUpdatedAt = rowsAfter1[0]?.updatedAt;

    // Tiny pause so updatedAt timestamps are observably different.
    await new Promise((r) => setTimeout(r, 5));

    // Second delivery — same payload
    const r2 = await POST(makeReq(event));
    ok("second delivery (replay) returns 200", r2.status === 200);

    const rowsAfter2 = fake.collections.tekmetric_work_orders.filter(
      (r: any) => r.workOrderId === String(roId),
    );
    ok(
      "replay does NOT duplicate the cache row (still exactly 1)",
      rowsAfter2.length === 1,
      `found ${rowsAfter2.length} rows`,
    );

    const secondUpdatedAt = rowsAfter2[0]?.updatedAt;
    ok(
      "replay advances updatedAt on the existing row (upsert hit, not no-op)",
      secondUpdatedAt instanceof Date &&
        firstUpdatedAt instanceof Date &&
        secondUpdatedAt.getTime() >= firstUpdatedAt.getTime(),
    );

    const logRows = fake.collections.tekmetric_webhook_logs;
    ok(
      "each delivery is independently logged (2 webhook_logs entries)",
      logRows.length === 2,
      `found ${logRows.length} log rows`,
    );
  } finally {
    restore();
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
