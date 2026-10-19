import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewHeldImports, reviewDigest, type ReviewStore, type ReviewScope } from "../lib/protractor-held-review";
import { heldReviewStore } from "../scripts/protractor-weekend/review-store";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const scope: ReviewScope = { campaignId: "protractor-weekend-2026-10-17", shopId: 139, days: ["2026-10-16"] };
const ID = "ABCD1234-1234-1234-1234-123456789ABC";
const invoice = { ID, ServicePackages: [{ ID: "job-1", Title: "Service",
  ServicePackageLines: [{ Description: "Labor", Quantity: 1 }] },
  { ID: "job-2", Title: "Other service", ServicePackageLines: [{ Description: "Part", Quantity: 1 }] }] };
const rid = `${scope.campaignId}:${scope.shopId}:${reviewDigest(ID.toLowerCase())}`;
function fixture(status: string | null = "existing-needs-index-review") {
  const receipt: any = status && { _id: rid, campaignId: scope.campaignId, shopId: scope.shopId,
    day: scope.days[0], status, sourceDigest: reviewDigest(invoice) };
  const page: any = { _id: "page-1", campaignId: scope.campaignId, shopId: scope.shopId,
    day: scope.days[0], invoices: [invoice], digest: reviewDigest([invoice]) };
  const store: ReviewStore = {
    campaign: async () => ({ shops: [{ shopId: scope.shopId, pendingDays: scope.days, priorJobId: "old" }] }),
    cursor: async () => ({ heldDays: scope.days }),
    pages: async () => [page], receipts: async () => receipt ? [receipt] : [],
    days: async () => [], receipt: async id => id === rid ? receipt : null,
    ownership: async () => ({ canonical: ["canonical-1"], legacy: ["legacy-1"] }),
    index: async () => [{ servicePackageId: "JOB-1", sourceType: "protractor" }],
  };
  return { store, page, receipt };
}
test("verified existing invoice gets a scoped insert-only preview, not financial reconstruction", async () => {
  const { store } = fixture();
  const result = await reviewHeldImports(store, scope);
  assert.equal(result.rows[0].classification, "verified-existing-missing-index");
  assert.deepEqual(result.repairPreview.candidates[0].missingPackageIds, ["job-2"]);
  assert.equal(result.repairPreview.executable, false);
  assert.equal(result.dayEvidence[0].held, true);
  assert.ok(Object.values(result.conservation).every(Boolean));
  assert.equal(result.counts.reviewed, 1);
});
test("processing and prior uncertain outcomes stay held even when owned and missing jobs", async () => {
  for (const status of ["processing", "prior-ambiguous"]) {
    const { store } = fixture(status);
    const result = await reviewHeldImports(store, scope);
    assert.equal(result.rows[0].classification, "ambiguous-prior-ingestion");
    assert.equal(result.repairPreview.candidates.length, 0);
  }
  const { store, receipt } = fixture();
  store.receipt = async id => id === rid ? receipt : { status: "thin" };
  assert.equal((await reviewHeldImports(store, scope)).rows[0].classification, "ambiguous-prior-ingestion");
});
test("thin receipts, missing owners, complete index, duplicate owners and wrong providers never propose repair", async () => {
  const cases: [string, (s: ReviewStore) => void][] = [
    ["receipt-without-owned-invoice", s => { s.ownership = async () => ({ canonical: [], legacy: [] }); }],
    ["existing-index-complete", s => { s.index = async () => ["job-1", "job-2"].map(servicePackageId => ({ servicePackageId, sourceType: "protractor" })); }],
    ["ownership-conflict", s => { s.ownership = async () => ({ canonical: ["a", "b"], legacy: [] }); }],
    ["ownership-conflict", s => { s.index = async () => [{ servicePackageId: "job-1", sourceType: "tekmetric" }]; }],
  ];
  for (const [expected, change] of cases) {
    const { store } = fixture(); change(store);
    const result = await reviewHeldImports(store, scope);
    assert.equal(result.rows[0].classification, expected);
    assert.equal(result.repairPreview.candidates.length, 0);
  }
  assert.equal((await reviewHeldImports(fixture("thin").store, scope)).rows[0].classification, "held-receipt");
});
test("pre-ingestion check failures remain distinct from absence and uncertain receipts", async () => {
  const { store } = fixture(null);
  store.ownership = async () => { throw Error("sensitive SQL"); };
  const result = await reviewHeldImports(store, scope);
  assert.equal(result.rows[0].classification, "pre-ingestion-check-failed");
  assert.ok(!JSON.stringify(result).includes("sensitive SQL"));
  assert.equal(result.repairPreview.candidates.length, 0);
  store.ownership = async () => ({ canonical: [], legacy: [] });
  assert.equal((await reviewHeldImports(store, scope)).rows[0].classification, "unreceipted-unknown");
});
test("deduplicates raw occurrences and conserves orphan receipts independently", async () => {
  const { store, page, receipt } = fixture();
  store.pages = async () => [page, { ...page, _id: "page-2" }];
  store.receipts = async () => [receipt, { ...receipt, _id: "orphan" }];
  const result = await reviewHeldImports(store, scope);
  assert.equal(result.counts.rawOccurrences, 2);
  assert.equal(result.counts.uniqueInvoices, 1);
  assert.equal(result.counts.orphanReceipts, 1);
  assert.equal(result.counts.reviewed, 2);
  assert.ok(Object.values(result.conservation).every(Boolean));
});
test("corrupt, conflicting and thin raw evidence fails closed", async () => {
  const { store, page, receipt } = fixture();
  page.digest = "corrupt";
  await assert.rejects(reviewHeldImports(store, scope), /digest/);
  page.digest = reviewDigest(page.invoices);
  receipt.sourceDigest = "wrong";
  assert.equal((await reviewHeldImports(store, scope)).rows[0].classification, "evidence-conflict");
  receipt.sourceDigest = reviewDigest(invoice);
  const different = { ...invoice, Total: 100 };
  store.pages = async () => [page, { ...page, _id: "different", invoices: [different], digest: reviewDigest([different]) }];
  assert.equal((await reviewHeldImports(store, scope)).rows[0].classification, "evidence-conflict");
  const thin = { ID };
  store.pages = async () => [{ ...page, invoices: [thin], digest: reviewDigest([thin]) }];
  receipt.sourceDigest = reviewDigest(thin);
  assert.equal((await reviewHeldImports(store, scope)).rows[0].classification, "insufficient-job-evidence");
});
test("caps, invalid scope, receipt races and wrong tenants abort instead of returning complete previews", async () => {
  await assert.rejects(reviewHeldImports(fixture().store, { ...scope, days: ["2026-02-30"] }));
  await assert.rejects(reviewHeldImports(fixture().store, { ...scope, shopId: 2 }), /outside/);
  const { store, page, receipt } = fixture();
  store.pages = async () => Array(21).fill(page);
  await assert.rejects(reviewHeldImports(store, scope), /cap/);
  store.pages = async () => [{ ...page, shopId: 2 }];
  await assert.rejects(reviewHeldImports(store, scope), /scope/);
  store.pages = async () => [page];
  store.receipt = async () => ({ ...receipt, status: "processing" });
  await assert.rejects(reviewHeldImports(store, scope), /changed/);
});
test("adapter only uses bounded reads and read-only PG transactions, preserves mixed-case identity and numeric/string tenant", async () => {
  const calls: any[] = [];
  const db: any = { collection(name: string) { return {
    find(query: any, options: any) {
      calls.push({ name, query, options });
      return { limit(limit: number) {
        calls.push({ limit });
        return { toArray: async () => name === "job_index"
          ? [{ servicePackageId: "job-1", metadata: { sourceType: "protractor" } }] : [{ _id: "legacy" }] };
      } };
    },
  }; } };
  const queries: any[] = [];
  const pg = { begin: async (fn: any) => fn({ unsafe: async (sql: string, params: any) => {
    queries.push({ sql, params }); return sql.startsWith("WITH") ? [{ id: "canonical" }] : [];
  } }) };
  const store = heldReviewStore(db, pg);
  assert.deepEqual(await store.ownership(139, ID.toLowerCase()), { canonical: ["canonical"], legacy: ["legacy"] });
  assert.deepEqual(await store.index(139, ID.toLowerCase()), [{ servicePackageId: "job-1", sourceType: "protractor" }]);
  assert.equal(queries[0].sql, "set transaction read only");
  assert.equal(queries[1].sql, "set local statement_timeout='5000ms'");
  assert.deepEqual(queries[2].params, [139, ID.toLowerCase()]);
  assert.deepEqual(calls[0].query.shopId, { $in: [139, "139"] });
  assert.ok(calls[0].query["provenance.sourceIds.idValue"].test(ID));
  assert.ok(!calls[0].query["provenance.sourceIds.idValue"].test(`prefix${ID}`));
  assert.equal(calls[0].options.maxTimeMS, 5000);
  assert.deepEqual(calls.filter(c => c.limit).map(c => c.limit), [2, 1001]);
});
test("CLI rejects apply/provider modes before connections and disables telemetry writes before imports", () => {
  const source = readFileSync("scripts/protractor-weekend/review.ts", "utf8");
  assert.ok(source.indexOf('process.env.SLOW_QUERY_TRACKING_DISABLED = "1"') <
    source.indexOf('import("../../lib/mongo")'));
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/protractor-weekend/review.ts",
    "--apply", scope.campaignId, "139", scope.days[0]], {
    encoding: "utf8", timeout: 10000,
    env: { NODE_ENV: "test", PATH: process.env.PATH, NODE_OPTIONS: "--require ./tests/helpers/deny-network-egress.cjs" },
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /no complete preview/);
});
