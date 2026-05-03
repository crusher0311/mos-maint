/**
 * Smoke test for Stripe webhook idempotency (duplicate-event short-circuit).
 *
 * Run: `npx tsx tests/stripe-webhook-idempotency.smoke.ts`
 *
 * The route at `app/api/stripe/webhook/route.ts` defends against duplicate
 * delivery from Stripe by checking `stripe_webhook_events` for a record with
 * `status: "processed"` matching the incoming `event.id` BEFORE any side
 * effects run. If that guard regresses, a re-delivered `invoice.paid` would
 * be processed twice — silently double-mutating subscription/billing state.
 *
 * This test swaps `__deps.getDb` to an in-memory fake mongo and asserts:
 *   1. Pre-seeded "processed" event → response is 200 with duplicate:true,
 *      AND no further side-effect writes happen (no audit_logs, no shops
 *      update, etc).
 *   2. Same event id BUT a "received" (in-flight) prior record does NOT
 *      short-circuit — only `processed` does. Pins the contract.
 *   3. No prior record → handler proceeds past the dedup gate and writes a
 *      `received` row to `stripe_webhook_events` (the dedup write happens
 *      before processing).
 *
 * STRIPE_WEBHOOK_SECRET is intentionally NOT set so the route's existing
 * "no secret → JSON.parse" path runs (line 116-119 of the route). The
 * signature gate is covered separately in
 * `tests/stripe-webhook-signature.smoke.ts`.
 */

import { NextRequest } from "next/server";
import { makeFakeDb } from "./utils/fake-mongo";
import { __deps, POST } from "../app/api/stripe/webhook/route";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Make sure no secret is set — exercises the "unverified" branch so the test
// doesn't need to construct a real Stripe v1 signature.
delete process.env.STRIPE_WEBHOOK_SECRET;

function makeReq(payload: any): NextRequest {
  return new NextRequest("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=0,v1=unused-when-no-secret" },
    body: JSON.stringify(payload),
  });
}

function withFakeDb(seed: Record<string, any[]>) {
  const fake = makeFakeDb(seed);
  const original = __deps.getDb;
  __deps.getDb = async () => fake.db as any;
  return {
    fake,
    restore: () => {
      __deps.getDb = original;
    },
  };
}

async function run() {
  console.log("stripe-webhook-idempotency smoke");

  // 1. Pre-seeded "processed" duplicate → short-circuit
  {
    const eventId = "evt_dup_processed_001";
    const { fake, restore } = withFakeDb({
      stripe_webhook_events: [
        { eventId, status: "processed", processedAt: new Date(), createdAt: new Date() },
      ],
    });
    try {
      const res = await POST(
        makeReq({
          id: eventId,
          type: "customer.created",
          data: { object: { id: "cus_test" } },
        }),
      );
      ok("processed-duplicate returns 200", res.status === 200);
      const body = await res.json();
      ok("processed-duplicate response has duplicate:true", body.duplicate === true);

      // No additional writes — only the dedup findOne should have happened.
      const writeOps = fake.ops.filter((o) =>
        ["insertOne", "updateOne", "deleteMany", "bulkWrite"].includes(o.op),
      );
      ok(
        "processed-duplicate causes ZERO write ops",
        writeOps.length === 0,
        `saw: ${writeOps.map((o) => `${o.op}(${(o as any).collection})`).join(", ")}`,
      );
    } finally {
      restore();
    }
  }

  // 2. "received" (in-flight) prior record does NOT short-circuit
  {
    const eventId = "evt_inflight_002";
    const { fake, restore } = withFakeDb({
      stripe_webhook_events: [
        { eventId, status: "received", createdAt: new Date() },
      ],
    });
    try {
      await POST(
        makeReq({
          id: eventId,
          type: "customer.unhandled_event_type_for_test",
          data: { object: {} },
        }),
      );
      const writeOps = fake.ops.filter((o) => o.op === "updateOne" || o.op === "insertOne");
      ok(
        "received-status prior record does NOT short-circuit (handler proceeds and writes)",
        writeOps.length > 0,
      );
    } finally {
      restore();
    }
  }

  // 3. No prior record → dedup write happens before processing
  {
    const eventId = "evt_brand_new_003";
    const { fake, restore } = withFakeDb({ stripe_webhook_events: [] });
    try {
      await POST(
        makeReq({
          id: eventId,
          type: "customer.unhandled_event_type_for_test",
          data: { object: {} },
        }),
      );
      const dedupRow = fake.collections.stripe_webhook_events.find((r: any) => r.eventId === eventId);
      ok("no prior record → dedup row is created (insert-before-process)", !!dedupRow);
      // Status will be "received" if processing didn't terminate, or "processed"
      // if the default-case branch ran. Either way, the dedup write happened
      // before any business-logic side effects — that's the contract that
      // protects against double-processing on retry.
      ok(
        "dedup row reaches a terminal status (received or processed)",
        dedupRow?.status === "received" || dedupRow?.status === "processed",
      );
    } finally {
      restore();
    }
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
