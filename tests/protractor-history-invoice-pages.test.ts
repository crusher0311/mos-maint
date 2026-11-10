import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { collectHistoryInvoicePages, historyChunkCursor, HISTORY_INVOICE_PAGE_SIZE, fleetHistoryWindowDays, reportHistoryInvoicePageDiagnostic } from "../lib/integrations/protractor/history-invoice-pages";
import { fleetHistoryEndpointAllowed } from "../lib/integrations/protractor/fleet-history-policy";
const page = (offset: number, count = 25) => Array.from({ length: count }, (_, i) => ({ ID: `invoice-${offset + i}` }));

test("smaller pages use contiguous offsets and fetch every invoice exactly once", async () => {
  const calls: number[][] = [];
  const result = await collectHistoryInvoicePages(async (take, skip) => {
    calls.push([take, skip]);
    return { ok: true, data: { ItemCollection: page(skip, Math.min(take, 63 - skip)) } };
  }, 4);
  assert.deepEqual(calls, [[25, 0], [25, 25], [25, 50]]);
  assert.equal(result.invoices.length, 63);
  assert.equal(new Set(result.invoices.map(i => i.ID)).size, 63);
  assert.equal(result.hadError, false);
  assert.equal(result.hitPageCap, false);
});
test("an exact multiple needs an empty terminal page within the same budget", async () => {
  let calls = 0;
  const result = await collectHistoryInvoicePages(async (_, skip) => {
    calls++; return { ok: true, data: { ItemCollection: skip ? [] : page(0) } };
  }, 2);
  assert.equal(calls, 2);
  assert.equal(result.hitPageCap, false);
  assert.equal(result.invoices.length, 25);
});
test("request budget exhaustion is incomplete, not a terminal short page", async () => {
  let calls = 0;
  const result = await collectHistoryInvoicePages(async (_, skip) => {
    calls++; return { ok: true, data: { ItemCollection: page(skip) } };
  }, 2);
  assert.equal(calls, 2);
  assert.equal(result.hitPageCap, true);
  assert.equal(result.invoices.length, 50);
});
test("oversized and other failed pages stop immediately without replay or lost earlier invoices", async () => {
  for (const failAt of [0, 25]) {
    const calls: number[] = [];
    const result = await collectHistoryInvoicePages(async (_, skip) => {
      calls.push(skip);
      return skip === failAt ? { ok: false, error: "upstream_response_too_large" } :
        { ok: true, data: { ItemCollection: page(skip) } };
    }, 10);
    assert.equal(result.hadError, true);
    assert.equal(result.invoices.length, failAt);
    assert.deepEqual(calls, failAt ? [0, 25] : [0]);
  }
});
test("malformed, overfull, unidentified and repeated pages fail closed", async () => {
  for (const data of [{}, { ItemCollection: null }, { ItemCollection: {} },
    { ItemCollection: page(0, 26) }, { ItemCollection: [{}] }, { ItemCollection: [{ ID: "" }] }]) {
    const result = await collectHistoryInvoicePages(async () => ({ ok: true, data }), 2);
    assert.equal(result.hadError, true);
  }
  const repeated = await collectHistoryInvoicePages(async () => ({ ok: true, data: { ItemCollection: page(0) } }), 2);
  assert.equal(repeated.hadError, true);
  assert.equal(repeated.invoices.length, 25);
});
test("invalid budget makes no requests; offset containment stays bounded", async () => {
  for (const budget of [0, -1, 1.5, NaN, Infinity]) {
    const result = await collectHistoryInvoicePages(async () => { throw Error("must not dispatch"); }, budget);
    assert.equal(result.hadError, true);
  }
  let calls = 0;
  const result = await collectHistoryInvoicePages(async (_, skip) => {
    calls++; assert.ok(skip <= 10000);
    return { ok: true, data: { ItemCollection: page(skip) } };
  }, 500);
  assert.equal(calls, 401);
  assert.equal(result.hitPageCap, true);
});
test("only reviewed sizes pass the existing invoice read boundary", () => {
  const url = (take: string) => `/Invoice/?startDate=2026-01-01&endDate=2026-02-01&take=${take}&skip=25`;
  for (const take of [String(HISTORY_INVOICE_PAGE_SIZE), "100"])
    assert.equal(fleetHistoryEndpointAllowed(url(take), "GET", undefined), true);
  for (const take of ["0", "1", "26", "101", "025", "-25", "25&extra=true"])
    assert.equal(fleetHistoryEndpointAllowed(url(take), "GET", undefined), false);
  assert.equal(fleetHistoryEndpointAllowed(url("25"), "POST", undefined), false);
  assert.equal(fleetHistoryEndpointAllowed(url("25"), "GET", "{}"), false);
});
test("canonical sync wiring holds partial ranges, shrinks capped retries and reports empty errors", () => {
  const source = readFileSync("lib/integrations/protractor/sync.ts", "utf8");
  assert.match(source, /const pages = await collectHistoryInvoicePages\(async/);
  assert.match(source, /if \(pages.diagnostic\) reportHistoryInvoicePageDiagnostic\(shopId, pages.diagnostic\);\s*return pages;/);
  assert.doesNotMatch(source.slice(source.indexOf("async function fetchInvoicesForDateRange"), source.indexOf("async function getOrFetchVehicle")), /console\.(?:error|warn).*result\.error/);
  assert.match(source, /chunkHadError = fetchResult.hadError \|\| fetchResult.hitPageCap/);
  assert.equal(source.match(/const decision = historyChunkCursor\(/g)?.length, 2, "empty and nonempty chunks use the tested cursor policy");
  assert.doesNotMatch(source, /nextChunkEnd = midpoint/);
  assert.equal(source.match(/unset: decision.clearPendingAttempt \? \["pendingAttempt"\] : \[\]/g)?.length, 2);
  assert.match(source, /_metricOutcome = chunkHadError \? "error" : "empty"/);
});

test("rejection diagnostics distinguish shape, size and identity without retaining provider data", async () => {
  const secret = "PRIVATE_CUSTOMER_VIN_URL_TOKEN";
  const cases: Array<[any, string, number | null, number | null]> = [
    [{ ok: false, error: secret }, "upstream_request_failed", null, null],
    [{ ok: true }, "missing_item_collection", null, null],
    [{ ok: true, data: { ItemCollection: null } }, "non_array_item_collection", null, null],
    [{ ok: true, data: { ItemCollection: secret } }, "non_array_item_collection", null, null],
    [{ ok: true, data: { ItemCollection: { secret } } }, "non_array_item_collection", null, null],
    [{ ok: true, data: { ItemCollection: page(0, 1446) } }, "overfull_page", 1446, null],
    [{ ok: true, data: { ItemCollection: [{ ID: " ", name: secret }, null, { ID: 7 }, { ID: secret }] } }, "invalid_invoice_id", 4, 3],
    [{ ok: true, data: { ItemCollection: [{ ID: secret }, { ID: secret }] } }, "duplicate_invoice_id", 2, null],
  ];
  for (const [response, reason, receivedCount, invalidIdCount] of cases) {
    let calls = 0;
    const result = await collectHistoryInvoicePages(async () => { calls++; return response; }, 3);
    assert.equal(calls, 1);
    assert.equal(result.hadError, true);
    assert.equal(result.hitPageCap, false);
    assert.deepEqual(result.diagnostic, {
      reason, receivedCount, invalidIdCount, pageNumber: 1, skip: 0, requestedTake: 25,
      acceptedCount: reason === "duplicate_invoice_id" ? 1 : 0,
    });
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = value => lines.push(value);
    try {
      // Exercise the actual log sink; additional payload fields must not escape.
      reportHistoryInvoicePageDiagnostic(635, { ...result.diagnostic!, payload: secret } as any);
    } finally { console.warn = warn; }
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(secret));
    assert.deepEqual(JSON.parse(lines[0]), {
      event: "protractor_history_invoice_page_rejected", shopId: 635, ...result.diagnostic,
    });
    const end = new Date("2026-11-09T23:59:59.999Z"), start = new Date("2026-11-02T23:59:59.999Z");
    const decision = historyChunkCursor(start, end, start, result.hadError, result.hitPageCap, true);
    assert.equal(decision.nextChunkEnd, end);
    assert.equal(decision.clearPendingAttempt, false);
  }
});

test("diagnostics preserve prior pages, request budgets, and successful responses", async () => {
  const result = await collectHistoryInvoicePages(async (_, skip) => ({
    ok: true, data: { ItemCollection: skip ? [{ ID: null }] : page(0) },
  }), 3);
  assert.equal(result.invoices.length, 25);
  assert.deepEqual(result.diagnostic, { reason: "invalid_invoice_id", pageNumber: 2, skip: 25,
    requestedTake: 25, receivedCount: 1, acceptedCount: 25, invalidIdCount: 1 });
  const duplicate = await collectHistoryInvoicePages(async () => ({ ok: true, data: { ItemCollection: page(0) } }), 2);
  assert.equal(duplicate.diagnostic?.reason, "duplicate_invoice_id");
  assert.equal(duplicate.diagnostic?.pageNumber, 2);
  const invalid = await collectHistoryInvoicePages(async () => { throw Error("must not fetch"); }, 0);
  assert.equal(invalid.diagnostic?.reason, "invalid_page_budget");
  assert.equal(invalid.diagnostic?.pageNumber, 0);
  const capped = await collectHistoryInvoicePages(async () => ({ ok: true, data: { ItemCollection: page(0) } }), 1);
  assert.equal(capped.diagnostic?.reason, "page_budget_exhausted");
  assert.equal(capped.hadError, false);
  assert.equal(capped.hitPageCap, true);
  const offset = await collectHistoryInvoicePages(async (_, skip) => ({ ok: true, data: { ItemCollection: page(skip) } }), 500);
  assert.equal(offset.diagnostic?.reason, "offset_limit");
  assert.equal(offset.diagnostic?.pageNumber, 401);
  assert.equal(offset.diagnostic?.skip, 10025);
  assert.equal(offset.hadError, false);
  assert.equal(offset.hitPageCap, true);
  for (const items of [[], page(0, 3)]) {
    const success = await collectHistoryInvoicePages(async () => ({ ok: true, data: { ItemCollection: items } }), 1);
    assert.equal(success.diagnostic, undefined);
    assert.equal(success.hadError, false);
    assert.equal(success.hitPageCap, false);
  }
});
test("partial/error chunks never advance or complete; capped retries retain shrink marker", () => {
  const start = new Date("2024-01-01"), end = new Date("2024-04-01"), oldest = start;
  for (const [error, cap] of [[true, false], [false, true], [true, true]]) {
    const result = historyChunkCursor(start, end, oldest, error, cap);
    assert.equal(result.nextChunkEnd, end);
    assert.equal(result.complete, false);
    assert.equal(result.clearPendingAttempt, !cap);
  }
  const result = historyChunkCursor(start, end, oldest, false, false);
  assert.equal(result.nextChunkEnd, start);
  assert.equal(result.complete, true);
  assert.equal(result.clearPendingAttempt, true);
});

test("dedicated-worker windows start bounded and shrink only at the same cursor", () => {
  const end = new Date("2026-11-09T23:59:59.999Z");
  assert.equal(fleetHistoryWindowDays(end), 7);
  for (const [prior, expected] of [[120, 3], [7, 3], [3, 1], [1, 1]]) {
    assert.equal(fleetHistoryWindowDays(end, { chunkEnd: end.toISOString(), days: prior }), expected);
  }
  assert.equal(fleetHistoryWindowDays(end, { chunkEnd: "2026-11-08", days: 1 }), 7);
  for (const days of [0, -1, NaN, Infinity, 1.2, "invalid"]) {
    assert.equal(fleetHistoryWindowDays(end, { chunkEnd: end.toISOString(), days }), 7);
  }
  assert.throws(() => fleetHistoryWindowDays(new Date("invalid")));
});

test("failed fleet list retains shrink state; successful range clears it", () => {
  const end = new Date("2026-11-09T23:59:59.999Z");
  const start = new Date("2026-11-02T23:59:59.999Z");
  const failed = historyChunkCursor(start, end, start, true, false, true);
  assert.equal(failed.nextChunkEnd, end);
  assert.equal(failed.clearPendingAttempt, false);
  assert.equal(failed.complete, false);
  const success = historyChunkCursor(start, end, start, false, false);
  assert.equal(success.nextChunkEnd, start);
  assert.equal(success.clearPendingAttempt, true);
  assert.equal(success.complete, true);
  // Non-fleet fetch/ingestion error behavior is unchanged.
  assert.equal(historyChunkCursor(start, end, start, true, false).clearPendingAttempt, true);
});

test("oversized and ignored-pagination responses shrink across separate passes, not immediate retries", async () => {
  const end = new Date("2026-11-09T23:59:59.999Z");
  let pending: { chunkEnd: string; days: number } | undefined;
  const windows: number[] = [];
  for (const failure of ["oversized", "overfull", "oversized", "oversized"]) {
    const days = fleetHistoryWindowDays(end, pending);
    windows.push(days);
    let requests = 0;
    const result = await collectHistoryInvoicePages(async () => {
      requests++;
      return failure === "overfull" ? { ok: true, data: { ItemCollection: page(0, 1446) } } :
        { ok: false, error: "upstream_response_too_large" };
    }, 50);
    assert.equal(requests, 1);
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - days);
    const decision = historyChunkCursor(start, end, start, result.hadError, result.hitPageCap, result.hadError);
    assert.equal(decision.nextChunkEnd, end);
    assert.equal(decision.complete, false);
    assert.equal(decision.clearPendingAttempt, false);
    pending = { chunkEnd: end.toISOString(), days };
  }
  assert.deepEqual(windows, [7, 3, 1, 1]);
});

test("date-boundary traversal retains adjacency and clamps at horizon", () => {
  for (const iso of ["2026-11-09T23:59:59.999Z", "2026-03-09T23:59:59.999Z", "2024-03-02T23:59:59.999Z", "2026-01-03T23:59:59.999Z"]) {
    let end = new Date(iso);
    const horizon = new Date(end); horizon.setUTCDate(horizon.getUTCDate() - 10);
    let passes = 0;
    while (end > horizon) {
      const start = new Date(end); start.setUTCDate(start.getUTCDate() - fleetHistoryWindowDays(end));
      if (start < horizon) start.setTime(horizon.getTime());
      const decision = historyChunkCursor(start, end, horizon, false, false);
      assert.ok(start < end && end.getTime() - start.getTime() <= 7 * 86400000);
      assert.equal(decision.nextChunkEnd, start);
      end = decision.nextChunkEnd;
      assert.ok(++passes < 3);
    }
    assert.equal(end.getTime(), horizon.getTime());
  }
  const source = readFileSync("lib/integrations/protractor/sync.ts", "utf8");
  assert.match(source, /if \(fleetHistory\) daysToProcess = fleetHistoryWindowDays\(chunkEnd, pendingAttempt\)/);
  assert.match(source, /if \(fleetHistory\) chunkStart.setUTCDate/);
  assert.match(source, /retainFailedFetch = fleetHistory && fetchResult.hadError/);
  assert.equal(source.match(/hitPageCap, retainFailedFetch\)/g)?.length, 2);
});
