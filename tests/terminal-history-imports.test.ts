import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readTerminalHistoryImports, HISTORY_SUMMARY_LIMITS } from "../lib/data/repositories/terminal-history-imports";
import { TerminalHistoryImportsView } from "../components/platform-admin/TerminalHistoryImports";

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
  assert.ok(route.indexOf("await requirePlatformAdmin()") < route.indexOf("await getTerminalHistoryImports()"));
  assert.match(route, /status: 401/);
  assert.match(route, /status: 503/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  const page = readFileSync("app/platform-admin/sync-health/page.tsx", "utf8");
  assert.match(page, /<TerminalHistoryImports \/>/);
});
