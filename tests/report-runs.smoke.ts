import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReportRunRequest } from "../lib/report-run-request";
import {
  REPORT_RUN_FRESH_MS,
  classifyReportRunCache,
  reportRunCacheKey,
} from "../lib/data/repositories/report-runs";

const now = new Date("2026-08-26T12:00:00.000Z");
const result = { ok: true } as any;
assert.deepEqual(classifyReportRunCache(null, now), {
  active: false, fresh: false, readable: false, cache: "miss",
});
assert.equal(classifyReportRunCache({
  status: "running", generatedAt: new Date(now.getTime() - REPORT_RUN_FRESH_MS - 1), result,
}, now).active, true, "equivalent active runs single-flight instead of duplicating work");
assert.deepEqual(classifyReportRunCache({
  status: "succeeded", generatedAt: new Date(now.getTime() - REPORT_RUN_FRESH_MS - 1), result,
}, now), {
  active: false, fresh: false, readable: true, cache: "stale",
}, "stale snapshots remain readable while a refresh is queued");
assert.equal(classifyReportRunCache({
  status: "succeeded", generatedAt: new Date(now.getTime() - 1), result,
}, now).cache, "hit");

const base = {
  requestedBy: "owner@example.com",
  definition: {
    version: 1, id: "report", name: "Report",
    dateRange: { start: "2026-08-01", end: "2026-08-26" },
    metrics: ["billedRevenue"], dimensions: ["none"],
    presentation: { kind: "scorecard" },
  } as any,
  scopeRequest: { kind: "shop" as const, shopId: 1 },
  authorizedShopIds: [1],
};
const key = reportRunCacheKey(base);
assert.equal(key, reportRunCacheKey({ ...base, authorizedShopIds: [1] }), "equivalent runs have a stable dedupe key");
assert.notEqual(key, reportRunCacheKey({ ...base, authorizedShopIds: [2] }), "authorization scope is part of the snapshot key");
assert.notEqual(key, reportRunCacheKey({ ...base, requestedBy: "other@example.com" }), "unsaved definitions remain requester-isolated");
assert.notEqual(key, reportRunCacheKey({ ...base, reportId: "saved", reportVersion: 2 }), "saved definition version is part of the snapshot key");
assert.equal(
  reportRunCacheKey({ ...base, reportId: "saved", reportVersion: 2 }),
  reportRunCacheKey({ ...base, requestedBy: "other@example.com", reportId: "saved", reportVersion: 2 }),
  "authorized users share the same saved snapshot rather than duplicating work",
);

const page = readFileSync("app/dashboard/reporting/page.tsx", "utf8");
assert.doesNotMatch(page, /api\/reports\/kpis/, "opening Reporting must not execute the fixed full-KPI workload");
assert.match(page, /Nothing is queried until you click Run/);
const route = readFileSync("app/api/reports/runs/[id]/route.ts", "utf8");
assert.match(route, /readableRunFor/, "status reads revalidate current authorization");
const worker = readFileSync("lib/report-run-service.ts", "utf8");
assert.match(worker, /Authorized reporting scope changed/, "workers reject stale enterprise or shop authorization");
assert.match(worker, /deadlineMs: 5 \* 60_000/, "background execution is not bound to the browser request deadline");
const cron = readFileSync("lib/cron/jobs.cjs", "utf8");
assert.match(cron, /name: "report-runs"[\s\S]*schedule: "\* \* \* \* \*"/);
const repository = readFileSync("lib/data/repositories/report-runs.ts", "utf8");
assert.match(repository, /insertOne\(next\)[\s\S]*code !== 11000/, "first-run contention is resolved through atomic insert and duplicate-key reread");
assert.match(repository, /findOneAndUpdate\(\s*\{ _id: cacheKey, status: existing\.status \}/, "stale refresh transitions use compare-and-set single flight");
const builder = readFileSync("app/dashboard/reporting/custom-report-builder.tsx", "utf8");
assert.match(builder, /if \(json\.runId\)[\s\S]*setRunStatus\(json\.status\)/, "returning users resume polling an active saved build without requiring a stale result");
assert.match(builder, /resetRunState\(\)[\s\S]*setSelectedId\(id\)/, "switching definitions clears the prior run before adopting the next selection");
assert.match(builder, /activeRunRef\.current !== runId/, "late polling responses cannot repopulate a newly selected report");
assert.match(builder, /versions\?\.find[\s\S]*candidate\.version === requestedVersion/, "scheduled links load the exact immutable saved version");
assert.match(page, /params\.get\(\"reportId\"\)/);
assert.match(page, /initialReportVersion=\{initialReportVersion\}/, "scheduled-report URL state is passed into the definition-first builder");
assert.match(page, /ReportingSubscriptionManager/, "existing scheduled deliveries remain manageable from Reporting");
const subscriptionManager = readFileSync("app/dashboard/reporting/reporting-subscription-manager.tsx", "utf8");
assert.match(subscriptionManager, /fetch\(\"\/api\/reports\/subscriptions\"/, "pre-existing delivery metadata is listed");
assert.match(subscriptionManager, /method: \"PATCH\"/, "delivery edits and pause or resume remain available");
assert.match(subscriptionManager, /method: \"DELETE\"/, "existing deliveries remain deletable");
assert.doesNotMatch(subscriptionManager, /api\/reports\/kpis|api\/reports\/runs/, "subscription management does not trigger report execution");
const delivery = readFileSync("lib/reporting-delivery.ts", "utf8");
assert.doesNotMatch(delivery, /getReportingPeriods\(/, "scheduled summaries must enqueue or consume snapshots instead of issuing live KPI queries");

const savedDefinition = { version: 1, metrics: ["billedRevenue"] };
assert.throws(() => buildReportRunRequest({
  selectedId: "saved-report",
  selectedVersion: 1,
  persistedDefinition: savedDefinition,
  appliedDefinition: { ...savedDefinition, metrics: ["attributedRevenue"] },
  scope: { kind: "shop", shopId: 1 },
}), /Save these changes as a new version/, "edit → apply → run cannot silently execute the prior immutable saved version");
assert.deepEqual(buildReportRunRequest({
  selectedId: "saved-report",
  selectedVersion: 2,
  persistedDefinition: { ...savedDefinition, metrics: ["attributedRevenue"] },
  appliedDefinition: { ...savedDefinition, metrics: ["attributedRevenue"] },
  scope: { kind: "shop", shopId: 1 },
}), {
  reportId: "saved-report",
  reportVersion: 2,
  force: false,
  refreshEnabled: true,
}, "after save adopts the new immutable version for execution");

console.log("report runs smoke: ALL PASS");