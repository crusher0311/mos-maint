/**
 * Smoke test for the deferred-work latency contract on the Tekmetric webhook
 * route.
 *
 * Run: `npx tsx tests/tekmetric-webhook-latency.smoke.ts`
 *
 * This guards step 6 of task #376: the inline POST handler must return well
 * under the budget Tekmetric expects (500ms in our SLO; their docs warn that
 * slow consumers risk drops/retries), and the heavy work — vehicle/customer
 * enrichment, NIS dual-write into Postgres, VHI rebuild trigger — must
 * actually be deferred via the `__deps.defer` seam rather than awaited inline.
 *
 * The setup mirrors `tests/tekmetric-webhook-idempotency.smoke.ts`:
 *   - Swaps `__deps.getDb` to an in-memory fake mongo.
 *   - Swaps `__deps.defer` so we can capture the deferred callbacks instead of
 *     letting them run on `setImmediate` (we drive them manually after the
 *     200 OK so we can observe and time them deterministically).
 *
 * Sends a terminal-status RO event (`Posted`) and a non-terminal RO event
 * (`In Progress`) — both paths must defer their NIS / enrichment work and
 * both must persist `handlerDurationMs` on the webhook log row.
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

/**
 * Capture-and-replay defer wrapper. The route under test fires
 * `__deps.defer(fn)` instead of awaiting heavy work. In production the seam
 * uses `setImmediate(() => fn().catch(...))`. Here we collect the callbacks
 * synchronously so we can:
 *   (a) assert the inline handler returned BEFORE any of them ran, and
 *   (b) drive them manually so the test stays deterministic.
 */
function withCapturedDefer() {
  const captured: Array<() => any | Promise<any>> = [];
  const original = __deps.defer;
  __deps.defer = (fn) => {
    captured.push(fn);
  };
  return {
    captured,
    /** Drain the queue, awaiting each task. Errors are surfaced. */
    drain: async () => {
      while (captured.length > 0) {
        const fn = captured.shift()!;
        await fn();
      }
    },
    restore: () => {
      __deps.defer = original;
    },
  };
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
  console.log("tekmetric-webhook-latency smoke");

  // --- Case 1: terminal RO (Posted) ---------------------------------------
  // Terminal-status events take the cache-only fast path and currently defer
  // a single piece of heavy work: the NIS dual-write. We assert the inline
  // handler returns < 500ms AND the NIS call was queued, not awaited.
  {
    const tekmetricShopId = 100;
    const roId = 9100;
    const event = {
      event: "RepairOrder.Posted",
      data: {
        repairOrder: {
          id: roId,
          repairOrderNumber: 7777,
          shopId: tekmetricShopId,
          repairOrderStatus: { name: "Posted", code: "POSTED" },
          // Minimal payload — no vehicle/customer enrichment needed.
        },
      },
    };

    const { fake, restore: restoreDb } = withFakeDb({
      shops: [{ shopId: 7, tekmetric: { shopId: tekmetricShopId } }],
      tekmetric_work_orders: [],
      tekmetric_webhook_logs: [],
      dashboard_updates: [],
    });
    const { captured, drain, restore: restoreDefer } = withCapturedDefer();

    try {
      const t0 = Date.now();
      const res = await POST(makeReq(event));
      const inlineMs = Date.now() - t0;

      ok("terminal RO: 200 OK", res.status === 200);
      ok(
        `terminal RO: inline handler returns under 500ms (${inlineMs}ms)`,
        inlineMs < 500,
        `inlineMs=${inlineMs}`,
      );
      ok(
        "terminal RO: at least one task deferred via __deps.defer",
        captured.length >= 1,
        `captured=${captured.length}`,
      );

      // The webhook log row must include handlerDurationMs (step 2).
      const logRows = fake.collections.tekmetric_webhook_logs;
      ok("terminal RO: webhook log row inserted", logRows.length === 1);
      const logRow = logRows[0];
      ok(
        "terminal RO: log row has handlerDurationMs (number)",
        typeof logRow?.handlerDurationMs === "number" &&
          logRow.handlerDurationMs >= 0,
        `handlerDurationMs=${logRow?.handlerDurationMs}`,
      );
      ok(
        "terminal RO: handlerDurationMs is bounded by inline wall clock",
        typeof logRow?.handlerDurationMs === "number" &&
          logRow.handlerDurationMs <= inlineMs + 5, // +5ms slack for clock granularity
        `handlerDurationMs=${logRow?.handlerDurationMs} inlineMs=${inlineMs}`,
      );

      // Drain the deferred queue — should not throw, and should perform the
      // NIS work (which on the fast path is a no-op against fake-mongo since
      // there's no Postgres connection, but the defer machinery itself must
      // be exercised end-to-end).
      let drainErr: any = null;
      try {
        await drain();
      } catch (err) {
        drainErr = err;
      }
      ok(
        "terminal RO: deferred work runs without throwing",
        drainErr === null,
        drainErr ? String(drainErr?.message || drainErr) : undefined,
      );
    } finally {
      restoreDefer();
      restoreDb();
    }
  }

  // --- Case 2: non-terminal RO (In Progress) ------------------------------
  // Non-terminal events take the upsert-with-enrichment path. The enrichment
  // (vehicle/customer fetches against the Tekmetric API) plus the post-enrich
  // NIS dual-write are now wrapped in __deps.defer. We don't supply a
  // vehicleId/customerId here — the goal is to assert that the cache-only
  // post-upsert NIS call is queued, not that enrichment HTTP calls fire.
  {
    const tekmetricShopId = 200;
    const roId = 9200;
    const event = {
      event: "RepairOrder.Updated",
      data: {
        repairOrder: {
          id: roId,
          repairOrderNumber: 8888,
          shopId: tekmetricShopId,
          repairOrderStatus: { name: "In Progress", code: "IN_PROGRESS" },
          // No vehicleId/customerId → enrichment fetches are skipped, but
          // the post-upsert NIS still runs (deferred).
        },
      },
    };

    const { fake, restore: restoreDb } = withFakeDb({
      shops: [{ shopId: 8, tekmetric: { shopId: tekmetricShopId } }],
      tekmetric_work_orders: [],
      tekmetric_webhook_logs: [],
      dashboard_updates: [],
    });
    const { captured, drain, restore: restoreDefer } = withCapturedDefer();

    try {
      const t0 = Date.now();
      const res = await POST(makeReq(event));
      const inlineMs = Date.now() - t0;

      ok("non-terminal RO: 200 OK", res.status === 200);
      ok(
        `non-terminal RO: inline handler returns under 500ms (${inlineMs}ms)`,
        inlineMs < 500,
        `inlineMs=${inlineMs}`,
      );
      ok(
        "non-terminal RO: at least one task deferred via __deps.defer",
        captured.length >= 1,
        `captured=${captured.length}`,
      );

      const logRows = fake.collections.tekmetric_webhook_logs;
      ok("non-terminal RO: webhook log row inserted", logRows.length === 1);
      ok(
        "non-terminal RO: log row has handlerDurationMs",
        typeof logRows[0]?.handlerDurationMs === "number",
        `handlerDurationMs=${logRows[0]?.handlerDurationMs}`,
      );

      // Cache row was upserted inline (drives dashboard freshness).
      const cacheRows = fake.collections.tekmetric_work_orders.filter(
        (r: any) => r.workOrderId === String(roId),
      );
      ok(
        "non-terminal RO: cache row written inline (dashboard freshness)",
        cacheRows.length === 1,
      );

      let drainErr: any = null;
      try {
        await drain();
      } catch (err) {
        drainErr = err;
      }
      ok(
        "non-terminal RO: deferred work runs without throwing",
        drainErr === null,
        drainErr ? String(drainErr?.message || drainErr) : undefined,
      );
    } finally {
      restoreDefer();
      restoreDb();
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
