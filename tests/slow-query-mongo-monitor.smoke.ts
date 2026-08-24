/**
 * Task #1163 — Mongo slow-query capture regression coverage.
 *
 * Drives attachMongoSlowQueryMonitor with a fake event-emitter client
 * through realistic commandStarted/Succeeded/Failed sequences and asserts:
 *  1. Slow commands are captured with target, redacted shape, rowsReturned.
 *  2. Fast commands and ignored commands (getMore, heartbeats) never record.
 *  3. Failed commands are captured with a [FAILED] shape marker.
 *  4. Completions with no matching started entry (shed/unknown) still record
 *     a minimal commandName-only shape.
 *  5. The bounded started-map sheds under storm (cap) but drains on
 *     completion so capacity recovers.
 *  6. Kill switch records nothing.
 *
 * Run: npx tsx tests/slow-query-mongo-monitor.smoke.ts
 */
import assert from "node:assert/strict";
import {
  attachMongoSlowQueryMonitor,
  __getBuffer,
  __resetBuffer,
} from "../lib/slow-query/tracker";

const STARTED_MAP_CAP = 5000; // mirrors lib/slow-query/tracker.ts

type Listener = (ev: any) => void;

/** Minimal fake MongoClient supporting driver command monitoring events. */
function makeFakeClient() {
  const listeners = new Map<string, Listener[]>();
  const client = {
    on(event: string, listener: Listener) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return client;
    },
    emit(event: string, ev: any) {
      for (const l of listeners.get(event) ?? []) l(ev);
    },
  };
  return client;
}

function started(client: any, requestId: number, commandName: string, command: any) {
  client.emit("commandStarted", { requestId, commandName, command });
}
function succeeded(
  client: any,
  requestId: number,
  commandName: string,
  duration: number,
  reply?: any,
) {
  client.emit("commandSucceeded", { requestId, commandName, duration, reply });
}
function failed(client: any, requestId: number, commandName: string, duration: number) {
  client.emit("commandFailed", {
    requestId,
    commandName,
    duration,
    failure: { message: "boom" },
  });
}

async function main() {
  delete process.env.SLOW_QUERY_TRACKING_DISABLED;
  delete process.env.SLOW_QUERY_SAMPLE_RATE;
  process.env.SLOW_QUERY_THRESHOLD_MS = "100";

  // ------------------------------------------- 1. Slow find: full capture
  {
    __resetBuffer();
    const client = makeFakeClient();
    attachMongoSlowQueryMonitor(client);

    started(client, 1, "find", {
      find: "vehicles",
      filter: { vin: "1FTFW1ET5DFC10312", shopId: { $in: [42, 77] } },
      sort: { createdAt: -1 },
      limit: 25,
    });
    succeeded(client, 1, "find", 850, {
      cursor: { firstBatch: [{ a: 1 }, { a: 2 }, { a: 3 }] },
    });

    assert.equal(__getBuffer().length, 1, "slow find captured");
    const rec = __getBuffer()[0];
    assert.equal(rec.db, "mongo");
    assert.equal(rec.operation, "find");
    assert.equal(rec.target, "vehicles");
    assert.equal(rec.durationMs, 850);
    assert.equal(rec.rowsReturned, 3, "rowsReturned from cursor.firstBatch");
    assert.ok(!rec.shape.includes("1FTFW1ET5DFC10312"), "VIN redacted in shape");
    assert.ok(!rec.shape.includes("42"), "shopId values redacted");
    assert.ok(rec.shape.includes("vin"), "filter keys preserved");
    assert.ok(!rec.shape.includes("[FAILED]"));
    assert.ok(rec.shapeHash && rec.shapeHash.length > 0);
    console.log("✓ slow find captured with redacted shape + rowsReturned");
  }

  // -------------------------------- 2. Fast + ignored commands never record
  {
    __resetBuffer();
    const client = makeFakeClient();
    attachMongoSlowQueryMonitor(client);

    // Fast command below threshold
    started(client, 10, "find", { find: "customers", filter: { id: 1 } });
    succeeded(client, 10, "find", 20);
    assert.equal(__getBuffer().length, 0, "fast command not captured");

    // getMore is ignored even when slow (duration belongs to origin find)
    started(client, 11, "getMore", { getMore: 123, collection: "job_index" });
    succeeded(client, 11, "getMore", 5000);
    assert.equal(__getBuffer().length, 0, "getMore ignored even when slow");

    // Heartbeats ignored
    for (const name of ["hello", "ping", "ismaster"]) {
      started(client, 12, name, { [name]: 1 });
      succeeded(client, 12, name, 2000);
    }
    assert.equal(__getBuffer().length, 0, "heartbeat commands ignored");
    console.log("✓ fast, getMore, and heartbeat commands never record");
  }

  // -------------------------------------------- 3. Failed command shapes
  {
    __resetBuffer();
    const client = makeFakeClient();
    attachMongoSlowQueryMonitor(client);

    started(client, 20, "aggregate", {
      aggregate: "normalized_work_orders",
      pipeline: [{ $match: { shopId: 999, "customer.email": "jane@example.com" } }],
    });
    failed(client, 20, "aggregate", 1200);

    assert.equal(__getBuffer().length, 1, "slow failed command captured");
    const rec = __getBuffer()[0];
    assert.equal(rec.target, "normalized_work_orders");
    assert.ok(rec.shape.endsWith("[FAILED]"), "failed shape carries [FAILED] marker");
    assert.ok(!rec.shape.includes("jane@example.com"), "failed shape still redacted");
    assert.ok(!rec.shape.includes("999"));
    assert.equal(rec.rowsReturned, null, "failed command has no rows");

    // Fast failure below threshold → not captured
    started(client, 21, "update", { update: "vehicles", updates: [] });
    failed(client, 21, "update", 10);
    assert.equal(__getBuffer().length, 1, "fast failure not captured");
    console.log("✓ failed commands captured with [FAILED] + redaction");
  }

  // --------------------- 4. Completion without started entry (minimal shape)
  {
    __resetBuffer();
    const client = makeFakeClient();
    attachMongoSlowQueryMonitor(client);

    // Succeeded arrives with no matching started (e.g. shed under storm)
    succeeded(client, 30, "find", 700, { cursor: { firstBatch: [{}] } });
    assert.equal(__getBuffer().length, 1, "orphan completion still captured");
    const rec = __getBuffer()[0];
    assert.equal(rec.operation, "find");
    assert.equal(rec.target, null, "no command body → no target");
    assert.equal(rec.shape, "find", "minimal commandName-only shape");

    // Orphan completion of an IGNORED command stays ignored
    succeeded(client, 31, "getMore", 700);
    assert.equal(__getBuffer().length, 1);

    // Unknown-name orphan
    client.emit("commandSucceeded", { requestId: 32, duration: 700 });
    assert.equal(__getBuffer()[1].operation, "unknown");
    console.log("✓ orphan completions record minimal shapes");
  }

  // ------------------------------------- 5. Started-map cap shedding + drain
  {
    __resetBuffer();
    const client = makeFakeClient();
    attachMongoSlowQueryMonitor(client);

    // Fill the map to the cap with never-completing commands.
    for (let i = 0; i < STARTED_MAP_CAP; i++) {
      started(client, 1000 + i, "find", { find: "vehicles", filter: { i } });
    }
    // Next started is shed: its completion must fall back to the minimal shape.
    const shedId = 999_999;
    started(client, shedId, "find", {
      find: "customers",
      filter: { secret: "SHED_SECRET" },
    });
    succeeded(client, shedId, "find", 900);
    assert.equal(__getBuffer().length, 1);
    assert.equal(
      __getBuffer()[0].shape,
      "find",
      "shed started entry → completion records minimal shape",
    );
    assert.equal(__getBuffer()[0].target, null);

    // Draining one capped-in entry frees capacity: a new started is stored
    // and its completion carries the full shape again.
    succeeded(client, 1000, "find", 1); // fast, just drains the map slot
    started(client, 888_888, "find", { find: "job_index", filter: { vin: "X" } });
    succeeded(client, 888_888, "find", 900);
    const last = __getBuffer()[__getBuffer().length - 1];
    assert.equal(last.target, "job_index", "map capacity recovered after drain");
    assert.ok(last.shape.includes("vin"), "full shape after drain");
    console.log("✓ started-map cap sheds under storm and drains on completion");
  }

  // ------------------------------------------------------- 6. Kill switch
  {
    __resetBuffer();
    const client = makeFakeClient();
    attachMongoSlowQueryMonitor(client);
    process.env.SLOW_QUERY_TRACKING_DISABLED = "1";
    started(client, 40, "find", { find: "vehicles", filter: { vin: "Y" } });
    succeeded(client, 40, "find", 5000);
    failed(client, 41, "find", 5000);
    assert.equal(__getBuffer().length, 0, "kill switch records nothing");
    delete process.env.SLOW_QUERY_TRACKING_DISABLED;
    console.log("✓ kill switch silences Mongo capture");
  }

  delete process.env.SLOW_QUERY_THRESHOLD_MS;
  __resetBuffer();
  console.log("\nAll Mongo slow-query monitor smoke tests passed.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
