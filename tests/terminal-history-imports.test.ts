import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readTerminalHistoryImports, HISTORY_SUMMARY_LIMITS } from "../lib/data/repositories/terminal-history-imports";
import { TerminalHistoryImportsView } from "../components/platform-admin/TerminalHistoryImports";
import { historyCursor, InvalidHistoryCursor, parseHistoryPage } from "../lib/data/repositories/terminal-history-pagination";

function fixture(options = { truncated: false, fail: false }) {
  const calls: any[] = [];
  const db = { collection(name: string) {
    assert.ok(["operator_history_import_jobs", "operator_history_import_receipts"].includes(name));
    return { find(filter: any, config: any) {
      calls.push({ name, filter, config });
      assert.equal(config.hint, "_id_");
      assert.equal(config.maxTimeMS, HISTORY_SUMMARY_LIMITS.queryMs);
      assert.ok(config.projection);
      let limit = 0;
      const cursor = {
        sort() { return cursor; }, limit(n: number) { limit = n; return cursor; },
        async toArray() {
          if (options.fail) throw Error("private provider error");
          if (filter.mode) {
            assert.ok(filter.status.$in.includes("needs-attention"));
            assert.ok(!filter.status.$in.includes("running"));
            return Array.from({ length: options.truncated ? limit : 1 }, (_, i) => ({
              _id: `campaign.${i}`, status: "needs-attention", unresolved: 7, endedAt: new Date(0),
            }));
          }
          assert.ok(filter._id.$regex.startsWith("^campaign\\."));
          if (name.endsWith("jobs")) return Array.from({ length: options.truncated ? limit : 1 }, () => ({
            shopId: 139, unresolved: 7, heldDays: Array(options.truncated ? 32 : 1).fill("2026-10-17"),
          }));
          const statuses = ["imported", "present", "processing", "prior-ambiguous", "thin", "existing-needs-index-review", "unexpected"];
          return Array.from({ length: options.truncated ? limit : statuses.length }, (_, i) => ({
            status: statuses[i % statuses.length], invoice: "MUST_NOT_LEAK", sourceDigest: "PRIVATE",
          }));
        },
      };
      return cursor;
    } };
  } };
  return { db: db as any, calls };
}

test("separates outcomes and held days using bounded projected metadata only", async () => {
  const { db, calls } = fixture();
  const result = await readTerminalHistoryImports(db);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.campaigns[0].outcomes, {
    imported: 1, verifiedPresent: 1, ambiguous: 2, indexReview: 1, thin: 1, unknown: 1,
  });
  assert.deepEqual(result.campaigns[0].shops[0].heldDays, ["2026-10-17"]);
  assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_LEAK|PRIVATE/);
  const html = renderToStaticMarkup(React.createElement(TerminalHistoryImportsView, { data: result }));
  assert.match(html, /Ambiguous receipts: 2/);
  assert.match(html, /Verified present: 1/);
  assert.match(html, /2026-10-17/);
});

test("keyset pages cover campaigns, shops and receipts exactly once with scoped metadata queries", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `campaign.${String(i).padStart(2, "0")}`);
  const jobs = ids.map(_id => ({ _id, mode: "missing_history_only", status: "needs-attention", shops: [] }));
  const children = Array.from({ length: 405 }, (_, i) => ({
    _id: `${ids[0]}:shop:${String(i).padStart(4, "0")}`, shopId: i + 1, unresolved: 1,
  }));
  const receipts = Array.from({ length: 4005 }, (_, i) => ({
    _id: `${ids[0]}:${String(i).padStart(5, "0")}`, status: i === 4004 ? "thin" : "imported",
  }));
  let calls = 0;
  const db: any = { collection(name: string) { return { find(filter: any, options: any) {
    calls++;
    assert.equal(options.maxTimeMS, 1500);
    assert.equal(options.hint, "_id_");
    assert.deepEqual(Object.keys(options.projection).sort(), filter.mode
      ? ["_id", "endedAt", "status", "unresolved"]
      : name.endsWith("receipts") ? ["_id", "status"] : ["_id", "heldDays", "shopId", "unresolved"]);
    let direction = 1, limit = 0;
    const cursor = {
      sort(order: any) { direction = order._id; return cursor; },
      limit(n: number) { limit = n; return cursor; },
      async toArray() {
        const source = filter.mode ? jobs : name.endsWith("receipts") ? receipts : children;
        return source.filter(row => {
          const id = filter._id;
          return !id || (typeof id === "string" ? row._id === id :
            (!id.$regex || new RegExp(id.$regex).test(row._id)) &&
            (!id.$lt || row._id < id.$lt) && (!id.$gt || row._id > id.$gt));
        }).sort((a, b) => (a._id < b._id ? -1 : 1) * direction).slice(0, limit);
      },
    };
    return cursor;
  } }; } };
  const seen: string[] = [];
  let campaignAfter: string | undefined;
  do {
    const before = calls;
    const page = await readTerminalHistoryImports(db, { campaignAfter });
    assert.ok(calls - before <= 11);
    seen.push(...page.campaigns.map(c => c.campaignId));
    campaignAfter = page.nextCampaignCursor ?? undefined;
  } while (campaignAfter);
  assert.deepEqual(seen, [...ids].reverse());
  let shopAfter: string | undefined, receiptAfter: string | undefined;
  const shops: number[] = [];
  let total = 0, thin = 0;
  for (let i = 0; i < 3; i++) {
    const before = calls;
    const result = await readTerminalHistoryImports(db, { campaignId: ids[0], shopAfter, receiptAfter });
    assert.equal(calls - before, 3);
    const c = result.campaigns[0];
    shops.push(...c.shops.map(s => s.shopId));
    total += c.receiptsSampled;
    thin += c.outcomes.thin;
    shopAfter = c.nextShopCursor ?? undefined;
    receiptAfter = c.nextReceiptCursor ?? undefined;
    if (i === 2) {
      assert.equal(c.receiptsTruncated, false);
      assert.equal(c.shopsTruncated, false);
      const html = renderToStaticMarkup(React.createElement(TerminalHistoryImportsView, { data: result }));
      assert.match(html, /Earlier receipt pages are excluded/);
      assert.match(html, /Earlier shop pages are not displayed/);
    }
  }
  assert.deepEqual(shops, Array.from({ length: 405 }, (_, i) => i + 1));
  assert.equal(total, 4005);
  assert.equal(thin, 1);
  assert.equal(shopAfter, undefined);
  assert.equal(receiptAfter, undefined);
  // Exact boundary and empty tail never advertise another page.
  const tail = await readTerminalHistoryImports(db, { campaignAfter: historyCursor("campaigns", "", ids[0]) });
  assert.deepEqual(tail.campaigns, []);
  assert.equal(tail.nextCampaignCursor, null);
  const exact = await readTerminalHistoryImports(db, {
    campaignId: ids[0], receiptAfter: historyCursor("receipts", ids[0], receipts[2004]._id),
  });
  assert.equal(exact.campaigns[0].receiptsSampled, 2000);
  assert.equal(exact.campaigns[0].nextReceiptCursor, null);
});

test("malformed, cross-campaign and cross-resource cursors fail before database access", async () => {
  const invalid = [
    { campaignAfter: "" }, { campaignAfter: "x".repeat(4097) }, { campaignAfter: "!!" },
    { campaignId: "" }, { shopAfter: "abc" },
    { campaignId: "a", campaignAfter: historyCursor("campaigns", "", "b") },
    { campaignId: "a", shopAfter: historyCursor("shops", "b", "b:shop:1") },
    { campaignId: "a", receiptAfter: historyCursor("shops", "a", "a:shop:1") },
    { campaignId: "a", receiptAfter: historyCursor("receipts", "a", "b:1") },
  ];
  for (const request of invalid) {
    assert.throws(() => parseHistoryPage(request), InvalidHistoryCursor);
    await assert.rejects(readTerminalHistoryImports({ collection() { throw Error("DB must not be read"); } } as any, request), InvalidHistoryCursor);
  }
});

test("all caps report truncation instead of suggesting complete coverage", async () => {
  const { db, calls } = fixture({ truncated: true, fail: false });
  const result = await readTerminalHistoryImports(db);
  assert.equal(calls.length, 11);
  assert.equal(result.campaignsTruncated, true);
  assert.equal(result.campaigns.length, 5);
  for (const c of result.campaigns) {
    assert.equal(c.receiptsSampled, 2000);
    assert.equal(c.receiptsTruncated, true);
    assert.equal(c.shops.length, 200);
    assert.equal(c.shopsTruncated, true);
    assert.equal(c.shops[0].heldDays.length, 31);
    assert.equal(c.shops[0].heldDaysTruncated, true);
  }
});

test("read failure is not an empty successful report", async () => {
  await assert.rejects(readTerminalHistoryImports(fixture({ truncated: false, fail: true }).db));
});

test("route gates metadata behind platform admin and has no write handler", () => {
  const route = readFileSync("app/api/platform-admin/terminal-history-imports/route.ts", "utf8");
  assert.ok(route.indexOf("await requirePlatformAdmin()") < route.indexOf("await getTerminalHistoryImports(page)"));
  assert.match(route, /status: 401/);
  assert.match(route, /status: 503/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  const page = readFileSync("app/platform-admin/sync-health/page.tsx", "utf8");
  assert.match(page, /<TerminalHistoryImports \/>/);
});
