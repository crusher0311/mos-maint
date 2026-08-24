/**
 * Task #1161 — slow-query analyzer regression coverage.
 *
 * Covers:
 *  1. Sanitizers never leak parameter values (Mongo command shapes + SQL text).
 *  2. Threshold / kill-switch gating (disabled hot path records nothing).
 *  3. Buffer flush batching + failure re-buffering.
 *  4. PG instrumentation: timing wrapper captures slow queries, kill switch
 *     returns the stock client untouched, chained builder methods survive.
 *  5. Spike alerter: pages once, dedups while sustained, auto-clears.
 *
 * Run: npx tsx tests/slow-query-analyzer.smoke.ts
 */
import assert from "node:assert/strict";
import {
  sanitizeMongoCommand,
  sanitizeSqlText,
  sqlTargetTable,
  sqlOperation,
  mongoCommandCollection,
  shapeHash,
  slowQueryThresholdMs,
  slowQueryTrackingEnabled,
  isIgnoredMongoCommand,
} from "../lib/slow-query/core";
import {
  __deps as trackerDeps,
  __getBuffer,
  __resetBuffer,
  flushSlowQueryBuffer,
  recordSlowQuery,
  instrumentPgClientForSlowQueries,
} from "../lib/slow-query/tracker";
import {
  __deps as alerterDeps,
  checkSlowQuerySpike,
} from "../lib/slow-query/alerter";
import type { SlowQueryRecord } from "../lib/slow-query/core";
import {
  normalizeCallerPath,
  runWithSlowQueryCaller,
  getSlowQueryCaller,
  installSlowQueryCallerTagging,
} from "../lib/slow-query/caller-context";

function makeRecord(over: Partial<SlowQueryRecord> = {}): SlowQueryRecord {
  return {
    ts: new Date(),
    db: "pg",
    operation: "select",
    target: "normalized_work_orders",
    shape: "select * from normalized_work_orders where id = $1",
    shapeHash: "abc",
    durationMs: 900,
    ...over,
  };
}

async function main() {
  delete process.env.SLOW_QUERY_TRACKING_DISABLED;
  delete process.env.SLOW_QUERY_THRESHOLD_MS;
  delete process.env.SLOW_QUERY_SAMPLE_RATE;

  // ---------------------------------------------------------------- 1. Sanitizers
  {
    const shape = sanitizeMongoCommand("find", {
      find: "vehicles",
      filter: {
        vin: "1FTFW1ET5DFC10312",
        shopId: { $in: [42, 77] },
        "customer.email": "jane@example.com",
        $or: [{ name: /Smith/ }, { phone: "555-123-4567" }],
      },
      sort: { createdAt: -1 },
      limit: 25,
    });
    assert.ok(!shape.includes("1FTFW1ET5DFC10312"), "VIN must be redacted");
    assert.ok(!shape.includes("jane@example.com"), "email must be redacted");
    assert.ok(!shape.includes("555-123-4567"), "phone must be redacted");
    assert.ok(!shape.includes("42"), "shopId values must be redacted");
    assert.ok(shape.includes("vin"), "keys preserved");
    assert.ok(shape.includes("$in"), "operators preserved");
    assert.ok(shape.includes("$or"), "operators preserved");
    assert.equal(mongoCommandCollection("find", { find: "vehicles" }), "vehicles");
    assert.equal(
      mongoCommandCollection("aggregate", { aggregate: "job_index" }),
      "job_index",
    );
    // insert payload docs are collapsed, not walked
    const ins = sanitizeMongoCommand("insert", {
      insert: "customers",
      documents: [{ ssn: "123-45-6789" }],
    });
    assert.ok(!ins.includes("123-45-6789"), "insert doc values never stored");
    assert.ok(isIgnoredMongoCommand("hello") && isIgnoredMongoCommand("ping"));

    const sql = sanitizeSqlText(
      "select * from normalized_work_orders where vin = 'ABC123XYZ' and shop_id = 456 and note = $1 and tag = $$secret value$$",
    );
    assert.ok(!sql.includes("ABC123XYZ"), "SQL string literal redacted");
    assert.ok(!sql.includes("456"), "SQL numeric literal redacted");
    assert.ok(!sql.includes("secret value"), "dollar-quoted literal redacted");
    assert.ok(sql.includes("$1"), "placeholders preserved");
    assert.equal(sqlTargetTable(sql), "normalized_work_orders");
    assert.equal(sqlOperation(sql), "select");
    assert.equal(
      sqlTargetTable('insert into "public"."slow_queries" (a) values (?)'),
      "slow_queries",
    );
    // PG escape literals: backslash-escaped quote must NOT end the literal.
    const esc = sanitizeSqlText(
      "select * from users where note = E'it\\'s jane@example.com SECRET1' and id = 9",
    );
    assert.ok(!esc.includes("SECRET1"), "E'' escaped-quote literal fully consumed");
    assert.ok(!esc.includes("jane@example.com"));
    assert.ok(!esc.includes("9"), "trailing numeric redacted after escape literal");
    // Doubled-quote inside standard literal
    const dq = sanitizeSqlText("select 1 where name = 'O''Brien SECRET2'");
    assert.ok(!dq.includes("SECRET2"), "'' doubling handled");
    assert.ok(!dq.includes("Brien"));
    // Comments stripped entirely
    const cm = sanitizeSqlText(
      "select a from t -- customer ssn 123-45-6789\nwhere b = $1 /* token: SECRET3 /* nested */ still */ and c = $2",
    );
    assert.ok(!cm.includes("123-45-6789"), "line comment stripped");
    assert.ok(!cm.includes("SECRET3"), "block comment stripped");
    assert.ok(!cm.includes("still"), "nested block comment fully stripped");
    assert.ok(cm.includes("$1") && cm.includes("$2"), "placeholders kept");
    // Unterminated literal → remainder redacted, nothing retained
    const un = sanitizeSqlText("select * from t where x = 'unterminated SECRET4 and y = 5");
    assert.ok(!un.includes("SECRET4"), "unterminated literal redacts remainder");
    // Mixed dollar-quote tags
    const dt = sanitizeSqlText("select $body$sneaky ' SECRET5 $x$ deep$body$ from t where z = 3");
    assert.ok(!dt.includes("SECRET5"), "tagged dollar quote consumed to matching tag");
    assert.ok(dt.includes("from t"), "text after dollar quote preserved");
    assert.equal(shapeHash("pg", "t", "s"), shapeHash("pg", "t", "s"));
    assert.notEqual(shapeHash("pg", "t", "s"), shapeHash("mongo", "t", "s"));
    console.log("✓ sanitizers leak no values");
  }

  // ------------------------------------------------- 2. Threshold / kill switch
  {
    assert.equal(slowQueryThresholdMs(), 500, "default threshold 500ms");
    process.env.SLOW_QUERY_THRESHOLD_MS = "1200";
    assert.equal(slowQueryThresholdMs(), 1200);
    delete process.env.SLOW_QUERY_THRESHOLD_MS;

    assert.equal(slowQueryTrackingEnabled(), true);
    process.env.SLOW_QUERY_TRACKING_DISABLED = "1";
    assert.equal(slowQueryTrackingEnabled(), false);
    __resetBuffer();
    recordSlowQuery(makeRecord());
    assert.equal(__getBuffer().length, 0, "kill switch drops records");
    delete process.env.SLOW_QUERY_TRACKING_DISABLED;

    __resetBuffer();
    recordSlowQuery(makeRecord({ target: "slow_queries" }));
    assert.equal(__getBuffer().length, 0, "recursion guard on slow_queries");

    recordSlowQuery(makeRecord());
    assert.equal(__getBuffer().length, 1, "enabled path records");
    __resetBuffer();
    console.log("✓ threshold + kill-switch gating");
  }

  // ---------------------------------------------------------------- 3. Buffer flush
  {
    const flushed: SlowQueryRecord[][] = [];
    trackerDeps.insert = async (records) => {
      flushed.push(records);
      return records.length;
    };
    __resetBuffer();
    for (let i = 0; i < 49; i++) recordSlowQuery(makeRecord({ durationMs: 600 + i }));
    assert.equal(flushed.length, 0, "no flush below batch size");
    assert.equal(__getBuffer().length, 49);
    recordSlowQuery(makeRecord()); // 50th triggers flush (async)
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(flushed.length, 1, "batch-size flush fired");
    assert.equal(flushed[0].length, 50);
    assert.equal(__getBuffer().length, 0);

    // Failure re-buffers
    trackerDeps.insert = async () => {
      throw new Error("pg down");
    };
    __resetBuffer();
    recordSlowQuery(makeRecord());
    await flushSlowQueryBuffer();
    assert.equal(__getBuffer().length, 1, "failed flush re-buffers");
    trackerDeps.insert = async (r) => r.length;
    await flushSlowQueryBuffer();
    assert.equal(__getBuffer().length, 0);

    // Timer-driven sparse flush: a lone below-batch capture must persist on
    // its own via the unref'd timer — no follow-up query or cron required.
    const timerFlushed: SlowQueryRecord[][] = [];
    trackerDeps.insert = async (records) => {
      timerFlushed.push(records);
      return records.length;
    };
    trackerDeps.flushIntervalMs = 40;
    __resetBuffer();
    recordSlowQuery(makeRecord());
    assert.equal(__getBuffer().length, 1, "single capture buffered");
    assert.equal(timerFlushed.length, 0, "no immediate flush below batch size");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(timerFlushed.length, 1, "timer flushed the lone capture");
    assert.equal(timerFlushed[0].length, 1);
    assert.equal(__getBuffer().length, 0);
    trackerDeps.flushIntervalMs = 15000;
    trackerDeps.insert = null;
    __resetBuffer();
    console.log("✓ buffered flush + failure re-buffering + timer-driven sparse flush");
  }

  // ---------------------------------------------------- 4. PG instrumentation
  {
    // Fake postgres-js client: callable tag + .unsafe, queries are lazy
    // thenables with builder methods returning `this`.
    function makeQuery(delayMs: number, result: any[]) {
      const q: any = {
        simple() {
          return this;
        },
        values() {
          return this;
        },
        then(onF: any, onR: any) {
          return new Promise((resolve) =>
            setTimeout(() => resolve(result), delayMs),
          ).then(onF, onR);
        },
      };
      return q;
    }
    const calls: string[] = [];
    const fakeClient: any = (..._args: any[]) => {
      calls.push("tag");
      return makeQuery(5, [1]);
    };
    fakeClient.unsafe = (text: string) => {
      calls.push(`unsafe:${text.slice(0, 20)}`);
      return makeQuery(30, [1, 2]);
    };
    fakeClient.end = () => Promise.resolve();

    // Kill switch → identity
    process.env.SLOW_QUERY_TRACKING_DISABLED = "1";
    assert.equal(
      instrumentPgClientForSlowQueries(fakeClient),
      fakeClient,
      "disabled instrument returns stock client",
    );
    delete process.env.SLOW_QUERY_TRACKING_DISABLED;

    process.env.SLOW_QUERY_THRESHOLD_MS = "20";
    const wrapped: any = instrumentPgClientForSlowQueries(fakeClient);
    __resetBuffer();

    // Fast query below threshold → not captured
    await wrapped`select 1`;
    assert.equal(__getBuffer().length, 0, "fast query not captured");

    // Slow unsafe query with chained builder → captured, values sanitized
    const res = await wrapped
      .unsafe("select * from vehicles where vin = 'SECRETVIN123'")
      .simple();
    assert.deepEqual(res, [1, 2]);
    assert.equal(__getBuffer().length, 1, "slow query captured");
    const rec = __getBuffer()[0];
    assert.equal(rec.db, "pg");
    assert.equal(rec.target, "vehicles");
    assert.ok(rec.durationMs >= 20);
    assert.ok(!rec.shape.includes("SECRETVIN123"), "shape sanitized");
    assert.ok(typeof wrapped.end === "function" && wrapped.end() instanceof Promise);

    // Transaction-scoped client (sql.begin → Drizzle transactions): the
    // callback must receive an INSTRUMENTED client, including nested
    // savepoints and the (options, fn) begin signature.
    __resetBuffer();
    function makeTxClient(): any {
      const tx: any = (..._args: any[]) => makeQuery(30, ["tx-row"]);
      tx.unsafe = (_text: string) => makeQuery(30, ["tx-unsafe"]);
      tx.savepoint = (...spArgs: any[]) => {
        const fn = spArgs.find((a: any) => typeof a === "function");
        return Promise.resolve(fn(makeTxClient()));
      };
      return tx;
    }
    fakeClient.begin = (...bArgs: any[]) => {
      const fn = bArgs.find((a: any) => typeof a === "function");
      return Promise.resolve(fn(makeTxClient()));
    };

    const txRes = await wrapped.begin(async (tx: any) => {
      const a = await tx.unsafe(
        "update customers set email = 'leak@example.com' where id = 7",
      );
      const b = await tx`select tagged`;
      const c = await tx.savepoint(async (sp: any) =>
        sp.unsafe("delete from vehicles where vin = 'TXSECRETVIN'"),
      );
      return [a, b, c];
    });
    assert.deepEqual(txRes[0], ["tx-unsafe"]);
    assert.equal(
      __getBuffer().length,
      3,
      "transaction + nested savepoint queries all captured",
    );
    for (const r of __getBuffer()) {
      assert.ok(!r.shape.includes("leak@example.com"));
      assert.ok(!r.shape.includes("TXSECRETVIN"));
    }
    assert.equal(__getBuffer()[0].target, "customers");
    assert.equal(__getBuffer()[2].target, "vehicles");

    // (options, fn) signature: non-function args pass through untouched.
    __resetBuffer();
    fakeClient.begin = (opts: any, fn: any) => {
      assert.equal(opts, "isolation level serializable");
      return Promise.resolve(fn(makeTxClient()));
    };
    await wrapped.begin("isolation level serializable", async (tx: any) =>
      tx.unsafe("insert into normalized_work_orders (a) values ('X')"),
    );
    assert.equal(__getBuffer().length, 1, "begin(opts, fn) instrumented");
    delete process.env.SLOW_QUERY_THRESHOLD_MS;
    __resetBuffer();
    console.log("✓ PG instrumentation timing + kill switch + transactions");
  }

  // ------------------------------- 4b. PG client construction inventory guard
  {
    // Every runtime postgres() constructor (app/, lib/, src/) must be wrapped
    // in instrumentPgClientForSlowQueries — otherwise its slow queries are
    // invisible to the analyzer. The cron scheduler's independent client and
    // standalone scripts are explicitly out of scope (task #1161).
    const { execSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const EXEMPT = new Set([
      "lib/cron/scheduler.cjs", // independent cron PG client — out of scope
      "lib/slow-query/tracker.ts", // the instrumenter itself
    ]);
    const out = execSync(
      String.raw`grep -rln --include='*.ts' --include='*.tsx' --include='*.cjs' 'postgres(' app lib src 2>/dev/null || true`,
      { encoding: "utf8", cwd: process.cwd() },
    );
    const offenders: string[] = [];
    for (const file of out.split("\n").filter(Boolean)) {
      if (EXEMPT.has(file)) continue;
      const content = readFileSync(file, "utf8");
      // Only files that actually CALL the constructor (not type-only usage).
      const constructs = /(?<![\w.])postgres\s*\(\s*(?:getConnectionString|connStr|process\.env|url|["'`])/m.test(
        content,
      );
      if (!constructs) continue;
      if (!content.includes("instrumentPgClientForSlowQueries")) {
        offenders.push(file);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `raw postgres() clients missing slow-query instrumentation: ${offenders.join(", ")}`,
    );
    console.log("✓ all runtime postgres clients instrumented (inventory guard)");
  }

  // -------------------------------------------------------- 5. Spike alerter
  {
    const alerts: any[] = [];
    alerterDeps.alert = async (a: any) => {
      alerts.push(a);
      return { slack: "skipped", betterstack: "logged" } as any;
    };
    let fakeNow = 1_000_000_000;
    // Simulated shared PG row (slow_query_alert_state): claim/clear are
    // atomic single-row transitions, exactly like the SQL in the repo.
    // Module state plays no role — "instances" below share only this row.
    const sharedRow = { active: false, lastAlertAt: 0 as number | 0 };
    alerterDeps.claim = async (repeatMs: number) => {
      if (
        !sharedRow.active ||
        !sharedRow.lastAlertAt ||
        fakeNow - sharedRow.lastAlertAt >= repeatMs
      ) {
        sharedRow.active = true;
        sharedRow.lastAlertAt = fakeNow;
        return true;
      }
      return false;
    };
    alerterDeps.clear = async () => {
      if (sharedRow.active) {
        sharedRow.active = false;
        return true;
      }
      return false;
    };
    let stats: {
      windowCount: number;
      windowMaxMs: number;
      baselinePerWindow: number;
      worstTarget: string | null;
    } = {
      windowCount: 100,
      windowMaxMs: 4000,
      baselinePerWindow: 2,
      worstTarget: "job_index",
    };
    alerterDeps.stats = async () => stats;

    let r = await checkSlowQuerySpike();
    assert.equal(r.spiking, true);
    assert.equal(r.alerted, true, "first breach pages");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, "critical");

    // Sustained incident within cooldown → deduped EVEN when the next cron
    // run lands on a different replica: the state is the shared row, and a
    // fresh process starts with no module memory of the incident.
    fakeNow += 15 * 60 * 1000;
    r = await checkSlowQuerySpike();
    assert.equal(r.spiking, true);
    assert.equal(r.alerted, false, "sustained spike deduped across instances");
    assert.equal(alerts.length, 1);

    // Two "instances" racing the same tick: only the claim winner pages.
    fakeNow += 61 * 60 * 1000; // past cooldown
    const [a1, a2] = [await checkSlowQuerySpike(), await checkSlowQuerySpike()];
    assert.equal(
      [a1, a2].filter((x) => x.alerted).length,
      1,
      "exactly one instance wins the re-page claim",
    );
    assert.equal(alerts.length, 2);

    // Recovery → auto-clear info alert exactly once (second instance's
    // clear() returns false because the row is already inactive).
    stats = { windowCount: 1, windowMaxMs: 800, baselinePerWindow: 2, worstTarget: null };
    r = await checkSlowQuerySpike();
    assert.equal(r.spiking, false);
    assert.equal(r.cleared, true, "recovery emits clear");
    assert.equal(alerts.length, 3);
    assert.equal(alerts[2].severity, "info");
    r = await checkSlowQuerySpike();
    assert.equal(r.cleared, false, "second instance stays quiet after clear");
    assert.equal(alerts.length, 3);

    // Worst-case latency alone pages even at low volume
    sharedRow.active = false;
    sharedRow.lastAlertAt = 0;
    stats = { windowCount: 2, windowMaxMs: 45000, baselinePerWindow: 2, worstTarget: "vehicles" };
    r = await checkSlowQuerySpike();
    assert.equal(r.spiking, true, "worst-case latency pages");
    assert.ok(String(r.reason).includes("latency"));
    console.log("✓ spike alerter: shared-state claim, cross-instance dedup, single clear");
  }

  // ------------------------------------------- 6. Caller attribution (#1162)
  {
    // Tags derive from route TEMPLATES, never from request path values:
    // dynamic segments become :param placeholders from the app/ tree.
    assert.equal(
      normalizeCallerPath("/api/vehicles/1FTFW1ET5DFC10312/specs?x=1"),
      "/api/vehicles/:vin/specs",
    );
    assert.equal(
      normalizeCallerPath("http://localhost:3000/api/cron/protractor-sync?secret=x"),
      "/api/cron/protractor-sync",
    );
    // Security regressions (#1162 review): route-embedded secrets — short
    // enrollment codes and arbitrary webhook tokens — must NEVER appear in a
    // caller tag, regardless of length or character class.
    for (const secret of ["shortcode99", "aB3xY9zQ", "secrettoken", "x".repeat(30)]) {
      const joined = normalizeCallerPath(`/api/join/${secret}`);
      assert.equal(joined, "/api/join/:code", `join code redacted (${secret})`);
      const hook = normalizeCallerPath(`/api/webhooks/protractor/${secret}`);
      assert.equal(hook, "/api/webhooks/protractor/:token", `webhook token redacted (${secret})`);
      assert.ok(!String(joined).includes(secret) && !String(hook).includes(secret));
    }
    // Unmatched paths (404 probes, static assets) are fully redacted — no
    // raw segment is ever persisted.
    assert.equal(normalizeCallerPath("/no/such/route/SECRETVALUE"), "/…");
    assert.equal(normalizeCallerPath("/api/join/deeper/extra"), "/…");
    assert.equal(normalizeCallerPath("/"), "/");
    assert.equal(normalizeCallerPath(""), null);
    assert.equal(normalizeCallerPath(undefined), null);

    // Outside any tagged context → null (no attribution, never throws).
    assert.equal(getSlowQueryCaller(), null);

    // runWithSlowQueryCaller propagates through awaits into recordSlowQuery.
    __resetBuffer();
    await runWithSlowQueryCaller("cron:test-job", async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(getSlowQueryCaller(), "cron:test-job");
      recordSlowQuery(makeRecord());
    });
    assert.equal(__getBuffer().length, 1);
    assert.equal(__getBuffer()[0].caller, "cron:test-job", "record picks up ALS caller");
    assert.equal(getSlowQueryCaller(), null, "context does not leak out");

    // Kill switch: no ALS frame is created (negligible disabled overhead).
    process.env.SLOW_QUERY_TRACKING_DISABLED = "1";
    runWithSlowQueryCaller("should-not-tag", () => {
      assert.equal(getSlowQueryCaller(), null, "disabled → no tagging");
    });
    delete process.env.SLOW_QUERY_TRACKING_DISABLED;

    // PG instrumentation resolves the caller at first-await time.
    process.env.SLOW_QUERY_THRESHOLD_MS = "1";
    const fakeClient: any = (..._a: any[]) => ({
      then(onF: any, onR: any) {
        return new Promise((r) => setTimeout(() => r(["row"]), 10)).then(onF, onR);
      },
    });
    const wrapped: any = instrumentPgClientForSlowQueries(fakeClient);
    __resetBuffer();
    await runWithSlowQueryCaller("/api/some-route", async () => {
      await wrapped`select * from customers where id = $1`;
    });
    assert.equal(__getBuffer().length, 1);
    assert.equal(__getBuffer()[0].caller, "/api/some-route", "pg capture tagged");
    delete process.env.SLOW_QUERY_THRESHOLD_MS;
    __resetBuffer();

    // HTTP tagging: a real http server's request handler runs inside an ALS
    // context tagged with the normalized path (idempotent install).
    assert.equal(installSlowQueryCallerTagging(), true);
    assert.equal(installSlowQueryCallerTagging(), true, "install is idempotent");
    const http = await import("node:http");
    const seen: Array<string | null> = [];
    const server = http.createServer((req, res) => {
      seen.push(getSlowQueryCaller());
      // Async continuations keep the tag too.
      setTimeout(() => {
        seen.push(getSlowQueryCaller());
        res.end("ok");
      }, 5);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    await new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/join/sekretcode123?q=1`, (res) => {
        res.resume();
        res.on("end", () => resolve());
        res.on("error", reject);
      });
    });
    await new Promise<void>((r) => server.close(() => r()));
    assert.deepEqual(
      seen,
      ["/api/join/:code", "/api/join/:code"],
      "http request handler + async continuations tagged with normalized path",
    );
    console.log("✓ caller attribution: normalization, ALS propagation, http tagging");
  }

  console.log("\nAll slow-query analyzer smoke tests passed.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
