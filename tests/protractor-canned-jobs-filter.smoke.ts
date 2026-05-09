/**
 * Smoke test for the Protractor canned-jobs enrichment filter.
 *
 * Run: `npx tsx tests/protractor-canned-jobs-filter.smoke.ts`
 *
 * Pins the behavior of `shouldKeepEnrichedCannedJob`, the pure filter used
 * by `enrichCannedJobsWithDetails`. Regression coverage for task #387:
 * shop 116's canned jobs were being silently dropped because the legacy
 * default required `Code` to contain BOTH a letter and a number, which
 * killed legit rows whose codes were pure letters, pure numerics, or
 * empty. The fix:
 *
 *   - Default is now content-only (keep the row if it has a title OR
 *     lines), matching what shop 35 was already special-cased into.
 *   - The strict letter+number rule is opt-in via
 *     `shops.protractor.strictCannedJobFilter: true`.
 *
 * If anyone re-tightens the default or re-introduces a hardcoded shop-id
 * branch, this test fails before the next customer notices half their
 * canned jobs vanished.
 */

import {
  shouldKeepEnrichedCannedJob,
  classifySyncCannedJobsBatchSource,
  normalizeCannedJobForCache,
} from "../lib/integrations/protractor/client";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("Protractor canned-jobs enrichment filter");

// 1. Default (no strict): content (title or lines) is the only requirement.
ok(
  "default — keeps job with title and standard alphanumeric code",
  shouldKeepEnrichedCannedJob({ Code: "T15", _hasTitle: true, _hasLines: false }) === true,
);
ok(
  "default — keeps job with lines but empty title",
  shouldKeepEnrichedCannedJob({ Code: "BG1", _hasTitle: false, _hasLines: true }) === true,
);
ok(
  "default — keeps pure-letter code with title (shop 116 / shop 35 case)",
  shouldKeepEnrichedCannedJob({ Code: "OIL", _hasTitle: true, _hasLines: true }) === true,
);
ok(
  "default — keeps pure-numeric code with title",
  shouldKeepEnrichedCannedJob({ Code: "100", _hasTitle: true, _hasLines: false }) === true,
);
ok(
  "default — keeps empty code as long as content is present",
  shouldKeepEnrichedCannedJob({ Code: "", _hasTitle: true, _hasLines: true }) === true,
);
ok(
  "default — drops row with no title AND no lines",
  shouldKeepEnrichedCannedJob({ Code: "T15", _hasTitle: false, _hasLines: false }) === false,
);
ok(
  "default — drops empty code with no content",
  shouldKeepEnrichedCannedJob({ Code: "", _hasTitle: false, _hasLines: false }) === false,
);

// 2. Strict mode (per-shop opt-in via shops.protractor.strictCannedJobFilter).
ok(
  "strict — keeps standard letter+number code with content",
  shouldKeepEnrichedCannedJob(
    { Code: "T15", _hasTitle: true, _hasLines: true },
    { strictCodeFilter: true },
  ) === true,
);
ok(
  "strict — drops pure-letter code even with content (the historical filter)",
  shouldKeepEnrichedCannedJob(
    { Code: "OIL", _hasTitle: true, _hasLines: true },
    { strictCodeFilter: true },
  ) === false,
);
ok(
  "strict — drops pure-numeric code even with content",
  shouldKeepEnrichedCannedJob(
    { Code: "100", _hasTitle: true, _hasLines: true },
    { strictCodeFilter: true },
  ) === false,
);
ok(
  "strict — drops empty code even with content",
  shouldKeepEnrichedCannedJob(
    { Code: "", _hasTitle: true, _hasLines: true },
    { strictCodeFilter: true },
  ) === false,
);
ok(
  "strict — still drops rows with no content regardless of code",
  shouldKeepEnrichedCannedJob(
    { Code: "T15", _hasTitle: false, _hasLines: false },
    { strictCodeFilter: true },
  ) === false,
);

// 3. Realistic shop 116-shaped batch: with the OLD strict default this would
// have dropped >50% of the list and triggered the customer report; with the
// new content-only default we keep all the legit rows.
const shop116Sample = [
  { Code: "OIL", _hasTitle: true, _hasLines: true },
  { Code: "BRAKE", _hasTitle: true, _hasLines: true },
  { Code: "TIRE", _hasTitle: true, _hasLines: true },
  { Code: "100", _hasTitle: true, _hasLines: true },
  { Code: "200", _hasTitle: true, _hasLines: true },
  { Code: "T15", _hasTitle: true, _hasLines: true },
  { Code: "", _hasTitle: false, _hasLines: false }, // genuine junk
];
const keptDefault = shop116Sample.filter((j) => shouldKeepEnrichedCannedJob(j)).length;
ok(
  "default — shop-116-shaped sample keeps 6/7 rows (drops only the empty one)",
  keptDefault === 6,
  `kept ${keptDefault}/${shop116Sample.length}`,
);
const keptStrict = shop116Sample.filter((j) =>
  shouldKeepEnrichedCannedJob(j, { strictCodeFilter: true }),
).length;
ok(
  "strict — same sample keeps only 1/7 (proves the regression mode)",
  keptStrict === 1,
  `kept ${keptStrict}/${shop116Sample.length}`,
);

// 4. Source-tag classifier for the broader sync route. The sync route
// fetches per-template details but falls back to the basic /CannedJob/
// summary on failure (no ServicePackageHeader). The classifier must only
// say "enriched" when *every* template has the detail-shape marker; one
// fallback in the batch must downgrade to "sync-partial" so
// fetchCannedJobsWithCache will still self-heal via background re-enrich.
const enrichedTpl = { ID: "t1", ServicePackageHeader: { Title: "Oil Change" } };
const summaryFallbackTpl = { ID: "t2", Code: "OIL" }; // no ServicePackageHeader

ok(
  "classify — empty batch is sync-partial (nothing to short-circuit)",
  classifySyncCannedJobsBatchSource([]) === "sync-partial",
);
ok(
  "classify — all-enriched batch reports enriched",
  classifySyncCannedJobsBatchSource([enrichedTpl, enrichedTpl]) === "enriched",
);
ok(
  "classify — single fallback template downgrades the whole batch",
  classifySyncCannedJobsBatchSource([enrichedTpl, summaryFallbackTpl, enrichedTpl]) === "sync-partial",
);
ok(
  "classify — all-fallback batch is sync-partial",
  classifySyncCannedJobsBatchSource([summaryFallbackTpl, summaryFallbackTpl]) === "sync-partial",
);
ok(
  "classify — null/undefined entries downgrade the batch",
  classifySyncCannedJobsBatchSource([enrichedTpl, null, enrichedTpl]) === "sync-partial",
);

// 5. Cache-row normalization. `upsertCannedJobsCache` is called from BOTH
// the deep-enrich route (basic /CannedJob/ shape with Title at top level
// and ServicePackageLines as an array) AND the broader sync route
// (detail shape with ServicePackageHeader.Title and
// ServicePackageLines.ItemCollection). The previous implementation only
// read the basic shape, so detail-shaped templates persisted with empty
// titles and lineCount=0 even when `source: "enriched"` was set —
// poisoning the cache short-circuit. These checks pin both shapes.
const basicShape = {
  ID: "basic-1",
  Title: "Oil Change",
  Description: "5W-30 synthetic",
  Code: "OIL",
  Chapter: "Maintenance",
  ServicePackageLines: [{ ID: "l1" }, { ID: "l2" }, { ID: "l3" }],
};
const detailShape = {
  ID: "detail-1",
  Code: "BRK",
  Chapter: "Brakes",
  ServicePackageHeader: { Title: "Front Brake Service", Description: "Pads + rotors" },
  ServicePackageLines: { ItemCollection: [{ ID: "l1" }, { ID: "l2" }] },
};

const normalizedBasic = normalizeCannedJobForCache(basicShape);
ok("normalize — basic shape: title", normalizedBasic.title === "Oil Change");
ok("normalize — basic shape: lineCount", normalizedBasic.lineCount === 3);
ok("normalize — basic shape: code", normalizedBasic.code === "OIL");

const normalizedDetail = normalizeCannedJobForCache(detailShape);
ok(
  "normalize — detail shape: title from ServicePackageHeader",
  normalizedDetail.title === "Front Brake Service",
);
ok(
  "normalize — detail shape: description from ServicePackageHeader",
  normalizedDetail.description === "Pads + rotors",
);
ok(
  "normalize — detail shape: lineCount from ItemCollection",
  normalizedDetail.lineCount === 2,
);
ok("normalize — detail shape: id", normalizedDetail.id === "detail-1");

ok(
  "normalize — null/undefined input doesn't crash",
  normalizeCannedJobForCache(null).title === "" &&
    normalizeCannedJobForCache(undefined).lineCount === 0,
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll Protractor canned-jobs filter checks passed.`);
