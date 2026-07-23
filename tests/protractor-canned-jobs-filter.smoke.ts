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
  unwrapServicePackageTemplate,
  extractServicePackageTemplateContent,
  isCannedJobsCacheContentBlank,
  isCannedJobsCacheLineless,
  wouldDowngradeCannedJobsCache,
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

// 6. Template-detail response shape parser. Task #397 root-caused the
// shop-116 0/693 deep-sync to `/ServicePackageTemplate/Read/{id}`
// returning HTTP 200 with a body shape the parser silently didn't
// recognize — every template fell through `template.ID` being undefined
// and we returned `{ ok: false }` with no log. The unwrap+extract pair
// must handle:
//   - canonical top-level shape (already worked)
//   - the legacy `{ ServicePackageTemplate: {...} }` wrapper
//   - alt envelopes Protractor returns for some shop deployments
//     (`ServicePackageTemplateReadResponse`, `Result`, single-item
//     `ItemCollection`)
//   - alt content fields (`Title` at top level, `ServicePackageLines`
//     as a bare array, `Lines` / `LineItems` instead of
//     `ServicePackageLines.ItemCollection`)
// If anyone reverts to the one-liner `(data.ServicePackageTemplate ||
// data)` parser, these checks fail before the next deep sync silently
// drops to 0 again.
const canonicalTopLevel = {
  ID: "tpl-1",
  Code: "OIL",
  ServicePackageHeader: { Title: "Oil Change", Description: "5W-30" },
  ServicePackageLines: { ItemCollection: [{ ID: "l1" }, { ID: "l2" }] },
};
ok(
  "unwrap — canonical top-level shape passes through unchanged",
  unwrapServicePackageTemplate(canonicalTopLevel) === canonicalTopLevel,
);

const legacyWrapped = { ServicePackageTemplate: canonicalTopLevel };
ok(
  "unwrap — legacy { ServicePackageTemplate } wrapper",
  unwrapServicePackageTemplate(legacyWrapped) === canonicalTopLevel,
);

const readResponseEnvelope = {
  ServicePackageTemplateReadResponse: {
    ServicePackageTemplate: canonicalTopLevel,
  },
};
ok(
  "unwrap — nested ReadResponse envelope (shop-116-shaped)",
  unwrapServicePackageTemplate(readResponseEnvelope) === canonicalTopLevel,
);

const resultEnvelope = { Result: canonicalTopLevel };
ok(
  "unwrap — generic { Result } envelope",
  unwrapServicePackageTemplate(resultEnvelope) === canonicalTopLevel,
);

const singleItemCollection = { ItemCollection: [canonicalTopLevel] };
ok(
  "unwrap — single-element ItemCollection envelope",
  unwrapServicePackageTemplate(singleItemCollection) === canonicalTopLevel,
);

ok(
  "unwrap — null / non-template input returns null",
  unwrapServicePackageTemplate(null) === null &&
    unwrapServicePackageTemplate({ Result: { Foo: "bar" } }) === null,
);

const canonicalContent = extractServicePackageTemplateContent(canonicalTopLevel);
ok(
  "extract — canonical shape: id/title/description/lines",
  canonicalContent.id === "tpl-1" &&
    canonicalContent.title === "Oil Change" &&
    canonicalContent.description === "5W-30" &&
    canonicalContent.lines.length === 2,
);

// Alt content shape: title at top level, lines as a bare array, id only
// available via ServicePackageTemplateID. This is the kind of variation
// that silently dropped shop 116 templates because the old enrichment
// code only read ServicePackageHeader.Title and
// ServicePackageLines.ItemCollection.
const altShape = {
  ServicePackageTemplateID: "tpl-2",
  Title: "Brake Inspection",
  Description: "Front + rear",
  ServicePackageLines: [{ ID: "l1" }, { ID: "l2" }, { ID: "l3" }],
};
const altContent = extractServicePackageTemplateContent(altShape);
ok(
  "extract — alt shape (Title at root, lines as array, id from ServicePackageTemplateID)",
  altContent.id === "tpl-2" &&
    altContent.title === "Brake Inspection" &&
    altContent.description === "Front + rear" &&
    altContent.lines.length === 3,
);

const lineItemsShape = {
  ID: "tpl-3",
  Header: { Title: "Tire Rotation" },
  LineItems: [{ ID: "l1" }],
};
const lineItemsContent = extractServicePackageTemplateContent(lineItemsShape);
ok(
  "extract — Header.Title + LineItems fallback",
  lineItemsContent.id === "tpl-3" &&
    lineItemsContent.title === "Tire Rotation" &&
    lineItemsContent.lines.length === 1,
);

// End-to-end: the shop-116 envelope must round-trip through unwrap +
// extract and yield non-empty content, exactly the path that was
// returning ok:false silently before this task.
const shop116Envelope = {
  ServicePackageTemplateReadResponse: {
    ServicePackageTemplate: {
      ID: "tpl-shop116",
      Code: "OIL",
      Title: "Synthetic Oil Change",
      ServicePackageLines: [{ ID: "l1" }, { ID: "l2" }],
    },
  },
};
const shop116Inner = unwrapServicePackageTemplate(shop116Envelope);
const shop116Content = extractServicePackageTemplateContent(shop116Inner);
ok(
  "shop 116 — wrapped envelope with alt content fields yields a usable template",
  !!shop116Inner &&
    shop116Content.id === "tpl-shop116" &&
    shop116Content.title === "Synthetic Oil Change" &&
    shop116Content.lines.length === 2,
);

ok(
  "extract — null/empty input returns empty struct without throwing",
  extractServicePackageTemplateContent(null).id === "" &&
    extractServicePackageTemplateContent(undefined).lines.length === 0 &&
    extractServicePackageTemplateContent({}).title === "",
);

// 7. Task #405 regression guard: enrichment MUST call the documented
// canned-job detail endpoint (`/ServicePackage/CannedJob/{id}` via
// `fetchCannedJobDetail`), NOT the price-lookup template endpoint
// (`/ServicePackageTemplate/Read/{id}` via
// `fetchServicePackageTemplateDetail`). The two endpoints take IDs from
// different ID spaces — for shop 116 every one of 693 detail calls
// silently returned HTTP 404 because canned-job IDs aren't valid
// service-package-template IDs. The 404s were then cached for 7 days
// (now 6 hours per task #405). If anyone re-points the enrichment loop
// back at the wrong endpoint, this check fails before deploy.
import { readFileSync } from "fs";
import { join } from "path";

const clientSrc = readFileSync(
  join(__dirname, "../lib/integrations/protractor/client.ts"),
  "utf8",
);

function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return "";
  // Find next top-level export (function/const/class) after the signature
  // — good enough for our regression guards since these functions don't
  // contain inner `\nexport ` strings.
  const next = src.indexOf("\nexport ", start + signature.length);
  return src.slice(start, next > 0 ? next : src.length);
}

const enrichBody = extractFunctionBody(
  clientSrc,
  "export async function enrichCannedJobsWithDetails",
);

ok(
  "enrichCannedJobsWithDetails calls fetchCannedJobDetail (the v2.0 /CannedJob/ branch)",
  enrichBody.includes("fetchCannedJobDetail("),
  "regression: /CannedJob/-list shops must hit /ServicePackage/CannedJob/{id}",
);

ok(
  "enrichCannedJobsWithDetails calls fetchCannedJobDetailViaTemplate (the v1.0 fallback branch)",
  enrichBody.includes("fetchCannedJobDetailViaTemplate("),
  "regression: /ServicePackageTemplate-list shops (e.g. 116) must hit the bare canonical /ServicePackageTemplate/{id}",
);

ok(
  "enrichCannedJobsWithDetails dispatches on listSource",
  enrichBody.includes('listSource === "servicepackagetemplate"'),
  "regression: dispatch must be source-driven, not shop-id-driven (no `if (shopId === 116)`)",
);

ok(
  "enrichCannedJobsWithDetails does NOT call fetchServicePackageTemplateDetail",
  !enrichBody.includes("fetchServicePackageTemplateDetail("),
  "regression: that hits /ServicePackageTemplate/Read/{id} (undocumented), 404s for 116, and poisons the price-lookup cache",
);

const fetchCannedJobDetailBody = extractFunctionBody(
  clientSrc,
  "export async function fetchCannedJobDetail",
);

ok(
  "fetchCannedJobDetail uses /ServicePackage/CannedJob/ endpoint",
  fetchCannedJobDetailBody.includes("`/ServicePackage/CannedJob/${cannedJobId}`"),
  "regression: must hit the documented canned-job endpoint, not the template endpoint",
);

ok(
  "fetchCannedJobDetail uses its own cache collection (not protractor_template_cache)",
  fetchCannedJobDetailBody.includes('"protractor_canned_job_detail_cache"') &&
    !fetchCannedJobDetailBody.includes('"protractor_template_cache"'),
  "regression: separate cache so template price-lookup and canned-job enrichment can't poison each other",
);

ok(
  "fetchCannedJobDetail logs first-call envelope shape regardless of HTTP status",
  fetchCannedJobDetailBody.includes("logCannedJobDetailShapeDiagnostic("),
  "regression: the missing-on-404 diagnostic is exactly what hid this bug for months",
);

const cleanupBody = extractFunctionBody(
  clientSrc,
  "export async function clearPoisonedTemplate404sOnce",
);

ok(
  "clearPoisonedTemplate404sOnce is gated by a marker doc (idempotent)",
  cleanupBody.includes("migration_markers") && cleanupBody.includes("task_405_clear_poisoned_template_404s"),
  "regression: must not nuke the cache on every enrich call",
);

ok(
  "clearPoisonedTemplate404sOnce only deletes is404 entries",
  cleanupBody.includes("deleteMany({ is404: true })"),
  "regression: must not delete legitimate cached templates used by price-lookup callers",
);

// Sanity: enrichment must also still use the alt-shape extractor on the
// new detail response (canned-job detail uses the same
// ServicePackageHeader / ServicePackageLines.ItemCollection shape as
// templates per Protractor docs, so the existing extractor applies).
ok(
  "enrichCannedJobsWithDetails uses extractServicePackageTemplateContent on the detail response",
  enrichBody.includes("extractServicePackageTemplateContent(detailResult.detail)"),
  "regression: must keep alt-shape parsing so non-canonical Protractor envelopes still yield content",
);

// 8. Task #406 regression guards: the v1.0 / template-fallback path.
// Shop 116 was double-broken: first by the wrong template /Read/{id}
// endpoint (task #405), then by enrichment unconditionally hitting the
// v2.0-only /ServicePackage/CannedJob/{id} after task #405's fix. The
// canonical documented endpoint for ServicePackageTemplate IDs is the
// bare GET /ServicePackageTemplate/{id} — no /Read/ segment, distinct
// from the price-lookup helper. Pin both the URL and the dispatch.
const fetchCannedJobDetailViaTemplateBody = extractFunctionBody(
  clientSrc,
  "export async function fetchCannedJobDetailViaTemplate",
);

ok(
  "fetchCannedJobDetailViaTemplate uses the bare /ServicePackageTemplate/{id} endpoint (no /Read/ segment)",
  fetchCannedJobDetailViaTemplateBody.includes("`/ServicePackageTemplate/${templateId}`"),
  "regression: must hit the canonical documented endpoint, not /ServicePackageTemplate/Read/{id} or /ServicePackage/CannedJob/{id}",
);

ok(
  "fetchCannedJobDetailViaTemplate does NOT use /Read/ in its detail URL",
  !fetchCannedJobDetailViaTemplateBody.includes("`/ServicePackageTemplate/Read/${templateId}`"),
  "regression: the /Read/ variant is undocumented and 404s for v1.0 / template-fallback shops",
);

ok(
  "fetchCannedJobDetailViaTemplate does NOT use the canned-job endpoint",
  !fetchCannedJobDetailViaTemplateBody.includes("/ServicePackage/CannedJob/"),
  "regression: that endpoint takes CannedJob IDs, not ServicePackageTemplate IDs",
);

ok(
  "fetchCannedJobDetailViaTemplate logs first-call envelope shape regardless of HTTP status",
  fetchCannedJobDetailViaTemplateBody.includes("logCannedJobDetailViaTemplateShapeDiagnostic("),
  "regression: must surface wrong-endpoint regressions on the very first detail call",
);

ok(
  "fetchCannedJobDetailViaTemplate uses a distinct cacheKey prefix from fetchServicePackageTemplateDetail",
  fetchCannedJobDetailViaTemplateBody.includes("`protractor_template_get_${shopId}_${templateId}`"),
  "regression: must not collide with the price-lookup template cache namespace",
);

// 9. Task #406 diagnostic-never-swallow guard. The original
// logCannedJobDetailShapeDiagnostic wrapped the entire shape inspection
// in try/catch with an empty catch block, so when result.data was
// undefined (the 404 case it was specifically built to expose) any
// thrown error inside the diagnostic was eaten and zero log lines were
// emitted — exactly the silence pattern that hid this bug for two
// rounds. The fix: shape inspection is best-effort, but the
// console.log line ALWAYS fires unconditionally outside any try/catch.
const cannedJobDiagFn = clientSrc.slice(
  clientSrc.indexOf("function logCannedJobDetailShapeDiagnostic("),
  clientSrc.indexOf("function logCannedJobDetailViaTemplateShapeDiagnostic("),
);
const viaTemplateDiagFn = clientSrc.slice(
  clientSrc.indexOf("function logCannedJobDetailViaTemplateShapeDiagnostic("),
  clientSrc.indexOf("function logCannedJobDetailViaTemplateShapeDiagnostic(") +
    clientSrc.slice(clientSrc.indexOf("function logCannedJobDetailViaTemplateShapeDiagnostic(")).indexOf("\n}\n") + 3,
);

function diagnosticAlwaysLogs(fnSrc: string): boolean {
  // The console.log call must live OUTSIDE any try block (i.e. after the
  // last `catch {` / `catch (` block closes). A simple structural check:
  // the body's last `console.log(` index must come after the last
  // `catch (` index. If the diagnostic re-grew an `} catch {` wrapper
  // around the console.log, those positions would invert.
  const lastCatch = Math.max(fnSrc.lastIndexOf("catch ("), fnSrc.lastIndexOf("catch {"));
  const lastConsoleLog = fnSrc.lastIndexOf("console.log(");
  return lastConsoleLog > lastCatch;
}

ok(
  "logCannedJobDetailShapeDiagnostic emits its log line OUTSIDE any try/catch (never-swallow)",
  diagnosticAlwaysLogs(cannedJobDiagFn),
  "regression: a thrown error inside the shape inspection must NOT prevent the minimal log line",
);

ok(
  "logCannedJobDetailViaTemplateShapeDiagnostic emits its log line OUTSIDE any try/catch (never-swallow)",
  diagnosticAlwaysLogs(viaTemplateDiagFn),
  "regression: same guarantee on the v1.0 / template-fallback path",
);

// Behavior check: the diagnostic must successfully run with raw=undefined
// (the exact 404 case that hid the bug) without throwing, and the
// minimal info — shopId, cannedJobId, httpOk, httpError — must all be
// present in the log line. We exercise this by stubbing console.log,
// invoking the function (which is module-private — re-grab it via the
// module scope by triggering a fetch is too heavy, so we just verify by
// source the line includes the required fields).
ok(
  "logCannedJobDetailShapeDiagnostic line includes shopId, cannedJobId, httpOk, httpError",
  cannedJobDiagFn.includes("shop=${shopId}") &&
    cannedJobDiagFn.includes("cannedJobId=${cannedJobId}") &&
    cannedJobDiagFn.includes("httpOk=${httpOk}") &&
    cannedJobDiagFn.includes("httpError"),
  "regression: minimum required fields per task #406 must always be in the log line",
);

ok(
  "logCannedJobDetailViaTemplateShapeDiagnostic line includes shopId, templateId, httpOk, httpError",
  viaTemplateDiagFn.includes("shop=${shopId}") &&
    viaTemplateDiagFn.includes("templateId=${templateId}") &&
    viaTemplateDiagFn.includes("httpOk=${httpOk}") &&
    viaTemplateDiagFn.includes("httpError"),
  "regression: same minimum-fields guarantee on the v1.0 / template-fallback path",
);

// 10. Task #406 list-source tagging: fetchCannedJobs must thread the
// list-endpoint identity into its return value so enrichment can
// dispatch correctly. If anyone strips this, both v2.0 and v1.0 shops
// silently regress to whichever default the enricher picks.
const fetchCannedJobsBody = extractFunctionBody(
  clientSrc,
  "export async function fetchCannedJobs",
);

ok(
  'fetchCannedJobs tags the /CannedJob/ branch as source: "cannedjob"',
  fetchCannedJobsBody.includes('source: "cannedjob"'),
  "regression: enrichment dispatch needs this tag",
);

ok(
  'fetchCannedJobs tags the /ServicePackageTemplate branch as source: "servicepackagetemplate"',
  fetchCannedJobsBody.includes('source: "servicepackagetemplate"'),
  "regression: enrichment dispatch needs this tag for v1.0 / shop 116 fallback",
);

// 11. Task #891 — poisoned-cache detector. Shop 66's cache had 735 items,
// all stamped `source: "enriched"`, yet every one was contentless (no
// title, no lines). `isCannedJobsCacheContentBlank` is what lets
// `fetchCannedJobsWithCache` treat such a cache as stale instead of
// short-circuiting on the "enriched" stamp forever.
const blankItem = { id: "x", title: "", lineCount: 0 };
const goodItem = { id: "y", title: "Oil Change", lineCount: 3 };

// Empty / missing item arrays are handled by the existing cache hit-check
// (`items.length > 0`), so the blank detector deliberately stays out of
// that path and only judges caches that HAVE items.
ok(
  "blank-detect — empty array defers to the length>0 hit-check (not blank)",
  isCannedJobsCacheContentBlank([]) === false,
);
ok(
  "blank-detect — all-blank items (shop-66 shape) is blank",
  isCannedJobsCacheContentBlank(Array(735).fill(blankItem)) === true,
);
ok(
  "blank-detect — healthy cache is not blank",
  isCannedJobsCacheContentBlank([goodItem, goodItem, blankItem]) === false,
);
ok(
  "blank-detect — <5% content ratio is still blank (1 good in 100)",
  isCannedJobsCacheContentBlank([goodItem, ...Array(99).fill(blankItem)]) === true,
);
ok(
  "blank-detect — raw-shape items with ServicePackageHeader.Title count as content",
  isCannedJobsCacheContentBlank([
    { ID: "r1", ServicePackageHeader: { Title: "Brake Service" } },
  ]) === false,
);
ok(
  "blank-detect — items with lines but no title count as content",
  isCannedJobsCacheContentBlank([{ id: "l1", title: "", lines: [{ description: "Pads" }] }]) === false,
);
ok(
  "blank-detect — null/undefined input defers to the hit-check (not blank, no throw)",
  isCannedJobsCacheContentBlank(null as any) === false &&
    isCannedJobsCacheContentBlank(undefined as any) === false,
);

// 12. Task #891 — normalizeCannedJobForCache must PRESERVE lines (not just
// lineCount) so create-work-order can resolve parts/labor from the sync
// route's cache rows without a per-package template re-fetch.
const withLines = normalizeCannedJobForCache({
  ID: "wl-1",
  ServicePackageHeader: { Title: "Coolant Flush" },
  ServicePackageLines: {
    ItemCollection: [
      { Description: "Coolant", Type: "Part", PriceSummary: { SellPrice: 30 } },
      { Description: "Labor", Type: "Labor", Rate: 100, Hours: 1 },
    ],
  },
});
ok(
  "normalize — lines array preserved (detail shape)",
  Array.isArray((withLines as any).lines) && (withLines as any).lines.length === 2,
);
ok(
  "normalize — lineCount matches preserved lines",
  withLines.lineCount === 2,
);
const noLines = normalizeCannedJobForCache({ ID: "nl-1", Title: "Inspection" });
ok(
  "normalize — no lines yields empty lines array without throwing",
  Array.isArray((noLines as any).lines) && (noLines as any).lines.length === 0,
);

// 13. Task #913 — lineless-cache detector. Shop 219's cache had titles on
// every item but zero lines everywhere, so `isCannedJobsCacheContentBlank`
// called it healthy and create-WO pushed $0 header-only packages.
const mkTitled = (n: number, lines = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    title: `Job ${i}`,
    lineCount: lines,
    lines: Array.from({ length: lines }, (_, j) => ({ description: `L${j}` })),
  }));
ok(
  "lineless — titles-only cache (shop 219 shape) is detected",
  isCannedJobsCacheLineless(mkTitled(50, 0)) === true,
);
ok(
  "lineless — healthy cache with lines is NOT flagged",
  isCannedJobsCacheLineless([...mkTitled(40, 2), ...mkTitled(10, 0)]) === false,
);
ok(
  "lineless — tiny caches (<10 items) never flagged (too little signal)",
  isCannedJobsCacheLineless(mkTitled(5, 0)) === false,
);
ok(
  "lineless — null/undefined/empty input is safe and not flagged",
  isCannedJobsCacheLineless(null) === false &&
    isCannedJobsCacheLineless(undefined) === false &&
    isCannedJobsCacheLineless([]) === false,
);
ok(
  "lineless — raw detail-shape lines (ServicePackageLines.ItemCollection) count",
  isCannedJobsCacheLineless(
    Array.from({ length: 20 }, (_, i) => ({
      Title: `Raw ${i}`,
      ServicePackageLines: { ItemCollection: [{ Description: "Part" }] },
    })),
  ) === false,
);

// 14. Task #913 — never cache empty over non-empty.
ok(
  "downgrade — empty batch over line-bearing cache is a downgrade",
  wouldDowngradeCannedJobsCache(mkTitled(20, 2), []) === true,
);
ok(
  "downgrade — line-less batch over line-bearing cache is a downgrade",
  wouldDowngradeCannedJobsCache(mkTitled(20, 2), mkTitled(20, 0)) === true,
);
ok(
  "downgrade — line-bearing batch over line-less cache is an UPGRADE (allowed)",
  wouldDowngradeCannedJobsCache(mkTitled(20, 0), mkTitled(20, 2)) === false,
);
ok(
  "downgrade — empty batch over titles-only cache is still a downgrade",
  wouldDowngradeCannedJobsCache(mkTitled(20, 0), []) === true,
);
ok(
  "downgrade — anything over an empty/missing cache is allowed",
  wouldDowngradeCannedJobsCache([], mkTitled(5, 0)) === false &&
    wouldDowngradeCannedJobsCache(null, []) === false &&
    wouldDowngradeCannedJobsCache(undefined, mkTitled(5, 2)) === false,
);
ok(
  "downgrade — line-bearing batch over line-bearing cache is allowed",
  wouldDowngradeCannedJobsCache(mkTitled(20, 2), mkTitled(18, 3)) === false,
);

// 15. Task #919 — shop 219's "fresh enrichment wrote zero lines" root cause.
// Two layers, both pinned here:
//
// (a) classifySyncCannedJobsBatchSource must NOT stamp "enriched" on a batch
// whose items all carry ServicePackageHeader but zero lines. For v1.0 /
// template-fallback shops the /ServicePackageTemplate LIST summaries already
// carry ServicePackageHeader titles — so a sync run where every detail fetch
// 404'd and fell back to the summary looked fully enriched and wrote a
// poisoned titles-only cache that fetchCannedJobsWithCache then
// short-circuited on.
const titledLinelessTpl = (i: number) => ({
  ID: `tl-${i}`,
  ServicePackageHeader: { Title: `Job ${i}` },
  ServicePackageLines: { ItemCollection: [] as any[] },
});
const titledLinedTpl = (i: number) => ({
  ID: `td-${i}`,
  ServicePackageHeader: { Title: `Job ${i}` },
  ServicePackageLines: { ItemCollection: [{ Description: "Part", Type: "Part" }] },
});
ok(
  "classify — all-header but all-lineless batch (shop 219 shape) is sync-partial",
  classifySyncCannedJobsBatchSource(
    Array.from({ length: 50 }, (_, i) => titledLinelessTpl(i)),
  ) === "sync-partial",
  "regression: ServicePackageHeader presence alone must not earn the enriched stamp",
);
ok(
  "classify — all-header batch WITH lines is still enriched",
  classifySyncCannedJobsBatchSource(
    Array.from({ length: 50 }, (_, i) => titledLinedTpl(i)),
  ) === "enriched",
);
ok(
  "classify — small all-header batches (<10 items) keep the enriched stamp (lineless detector needs signal)",
  classifySyncCannedJobsBatchSource([enrichedTpl, enrichedTpl]) === "enriched",
);

// (b) The sync route must dispatch its per-template detail fetch on the
// LIST source (same dispatch as enrichCannedJobsWithDetails), not call
// fetchServicePackageTemplateDetail unconditionally —
// /ServicePackageTemplate/Read/{id} 404s for every template on v1.0 /
// template-fallback shops (shop 219: 3,024 consecutive cached 404s on
// 2026-07-22), silently degrading every item to a titles-only summary.
const syncRouteSrc = readFileSync(
  join(__dirname, "../app/api/protractor/sync/route.ts"),
  "utf8",
);
ok(
  "sync route does NOT call fetchServicePackageTemplateDetail",
  !syncRouteSrc.includes("fetchServicePackageTemplateDetail("),
  "regression: /ServicePackageTemplate/Read/{id} 404s for v1.0 / template-fallback shops (shop 219)",
);
ok(
  "sync route dispatches detail fetch on list source",
  syncRouteSrc.includes('listSource === "servicepackagetemplate"') &&
    syncRouteSrc.includes("fetchCannedJobDetailViaTemplate(") &&
    syncRouteSrc.includes("fetchCannedJobDetail("),
  "regression: sync route must use the same source-driven endpoint dispatch as enrichCannedJobsWithDetails",
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll Protractor canned-jobs filter checks passed.`);
