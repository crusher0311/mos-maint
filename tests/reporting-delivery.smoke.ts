import assert from "node:assert/strict";
import {
  buildReportingSummaryEmail,
  buildSavedReportEmail,
  canRecipientReadSavedReport,
  declarativeReportCsv,
  hashDisableToken,
  legacySubscriptionReportDefinition,
  nextReportingRun,
  nextReportingRetry,
  recipientSession,
  reportingDashboardUrl,
  reportingCsv,
  validateReportingSubscription,
} from "../lib/reporting-delivery";
import { finalizeMetrics, type ReportingKpiResponse } from "../lib/reporting-kpi-contract";

const weekly = validateReportingSubscription({
  recipientEmail: "OWNER@EXAMPLE.COM",
  cadence: "weekly",
  timezone: "America/Chicago",
  sendHour: 8,
  dayOfWeek: 1,
  scope: { kind: "shop", shopId: 1 },
});
assert.equal(weekly.recipientEmail, "owner@example.com");
assert.throws(() => validateReportingSubscription({ ...weekly, timezone: "Mars/Olympus" }), /timezone/);
assert.throws(() => validateReportingSubscription({ ...weekly, dayOfWeek: 8 }), /dayOfWeek/);

const next = nextReportingRun(weekly, new Date("2026-08-02T12:00:00.000Z"));
assert.equal(next.toISOString(), "2026-08-03T13:00:00.000Z", "08:00 CDT Monday");
assert.equal(
  nextReportingRun({ cadence: "monthly", timezone: "UTC", sendHour: 9, dayOfMonth: 15 }, new Date("2026-08-14T12:00:00Z")).toISOString(),
  "2026-08-15T09:00:00.000Z",
);
assert.deepEqual(recipientSession({
  emailLower: "enterprise@example.com",
  shopId: 42,
  role: "owner",
  enterpriseId: "enterprise-a",
}), {
  token: "reporting-delivery",
  email: "enterprise@example.com",
  shopId: 42,
  role: "owner",
  enterpriseId: "enterprise-a",
  isPlatformAdmin: false,
}, "enterprise delivery scope identity survives recipient lookup → synthetic session handoff");
const advisorScheduled = legacySubscriptionReportDefinition({
  _id: "advisor-summary",
  cadence: "weekly",
  filters: { advisorKey: "42:advisor-a" },
} as any, new Date("2026-08-26T12:00:00Z"));
assert.deepEqual(advisorScheduled.definition.dimensions, ["advisor"]);
assert.deepEqual(advisorScheduled.definition.filters, [{ dimension: "advisor", operator: "eq", value: "42:advisor-a" }]);
assert.equal(advisorScheduled.definition.comparison.range.start, "2026-08-12");
assert.equal(advisorScheduled.definition.comparison.range.end, "2026-08-18");
const technicianScheduled = legacySubscriptionReportDefinition({
  _id: "technician-summary",
  cadence: "monthly",
  filters: { technicianKey: "42:tech-a" },
} as any, new Date("2026-08-26T12:00:00Z"));
assert.deepEqual(technicianScheduled.definition.dimensions, ["technician"]);
assert.deepEqual(technicianScheduled.definition.filters, [{ dimension: "technician", operator: "eq", value: "42:tech-a" }]);
assert.equal(technicianScheduled.definition.comparison.mode, "custom");

const dashboardUrl = reportingDashboardUrl(
  "https://mos.tools/",
  {
    scope: { kind: "shop", shopId: 42 },
    filters: { locationId: 42, advisorKey: "42:advisor-a" },
  } as any,
  new Date("2026-08-01T00:00:00Z"),
  new Date("2026-08-07T00:00:00Z"),
);
assert.match(dashboardUrl, /scope=shop/);
assert.match(dashboardUrl, /shopId=42/);
assert.match(dashboardUrl, /locationId=42/);
assert.match(dashboardUrl, /advisorKey=42%3Aadvisor-a/);
assert.doesNotMatch(dashboardUrl, /advisor=/);
assert.equal(hashDisableToken("same"), hashDisableToken("same"));
assert.notEqual(hashDisableToken("same"), hashDisableToken("different"));
assert.equal(
  nextReportingRetry(new Date("2026-08-25T12:00:00Z")).toISOString(),
  "2026-08-25T13:00:00.000Z",
  "failed deliveries retry in one hour instead of waiting a full cadence",
);

const metrics = finalizeMetrics({ repairOrderCount: 2, billedRevenue: 200 });
const group = (key: string, label: string, shopId: number) => ({
  key, label, shopId, metrics,
  availability: { business: true, payments: true, staff: true, laborParts: true, planViews: false, recommendationEvents: false },
});
const report = {
  ok: true, version: 1, generatedAt: new Date().toISOString(),
  scope: { kind: "shop", shopIds: [1] }, range: { start: "", end: "", days: 7, timestampBasis: "" },
  catalog: [], summary: metrics, availability: group("","","" as any).availability, timeSeries: [],
  byLocation: [group("1", "Main, Shop", 1)],
  byAdvisor: [group("1:a", 'Jane "JJ"', 1), group("1:b", "Bob", 1)],
  byTechnician: [], byRecommendationSource: [],
  dataQuality: { unknownAdvisorRepairOrders: 0, unknownTechnicianJobs: 0, dimensionsTruncated: false, notes: [] },
} satisfies ReportingKpiResponse;
const csv = reportingCsv(report, { advisorKey: "1:a" });
assert.match(csv, /"summary"/);
assert.match(csv, /"Jane ""JJ"""/);
assert.doesNotMatch(csv, /"Bob"/);
assert.throws(() => reportingCsv(report, { advisorKey: "1:a", technicianKey: "1:t" }), /either/);

const malicious = structuredClone(report);
malicious.byAdvisor[0].label = "=HYPERLINK(\"https://example.test\")";
const hardenedCsv = reportingCsv(malicious, {});
assert.match(
  hardenedCsv,
  /"'=HYPERLINK\(\"\"https:\/\/example\.test\"\"\)"/,
  "provider-controlled CSV labels cannot execute spreadsheet formulas",
);
malicious.byAdvisor[0].label = " \t=1+1";
assert.match(reportingCsv(malicious, {}), /"' \t=1\+1"/, "formula safety also covers leading whitespace");

const governedCsv = reportingCsv(report, {}, {
  selectedFields: ["label", "billedRevenue"],
  layout: { dimension: "advisor", limit: 1 },
  maxRows: 10_000,
});
assert.equal(governedCsv.split("\r\n").length, 2, "saved layout row limit is enforced");
assert.equal(governedCsv.split("\r\n")[0], '"label","billedRevenue"', "only selected fields are exported");
assert.match(governedCsv, /Jane/);
assert.doesNotMatch(governedCsv, /Main, Shop|Bob|repairOrderCount/);

const dateReport = { ...report, timeSeries: [group("2026-08-01", "Aug 1", 1)] };
const dateCsv = reportingCsv(dateReport, {}, { layout: { dimension: "date" } });
assert.match(dateCsv, /"date"/);
assert.match(dateCsv, /"Aug 1"/);
assert.doesNotMatch(dateCsv, /Main, Shop|Jane ""JJ""/, "saved date exports contain only date rows");
assert.equal(
  canRecipientReadSavedReport(
    { email: "recipient@example.com", role: "admin" },
    { raw: { ownerEmail: "owner@example.com", sharing: { visibility: "private" } } } as any,
    { shopIds: [1] },
  ),
  false,
  "a recipient cannot subscribe to a private report merely through scope access",
);

const scheduledSaved = validateReportingSubscription({
  ...weekly,
  reportId: "507f1f77bcf86cd799439011",
  reportVersion: 3,
});
assert.equal(scheduledSaved.reportVersion, 3);
assert.throws(
  () => validateReportingSubscription({ ...weekly, reportVersion: 3 }),
  /reportId/,
  "a scheduled immutable version cannot omit its saved report",
);

const prior = { ...report, summary: finalizeMetrics({ repairOrderCount: 1, billedRevenue: 100 }) };
const email = buildReportingSummaryEmail(report, prior, "https://example.com/dashboard?shopId=1", "https://example.com/unsubscribe?t=x");
assert.match(email.subject, /Revenue \+100\.0%/);
assert.match(email.html, /Location outliers/);
assert.match(email.html, /Disable this summary/);
const emailWithoutPrior = buildReportingSummaryEmail(report, null, "https://example.com/dashboard?shopId=1", "https://example.com/unsubscribe?t=x");
assert.match(emailWithoutPrior.subject, /prior-period comparison unavailable/);

const savedEmail = buildSavedReportEmail({
  ok: true, version: 1, definitionId: "pinned-v3", generatedAt: "2026-08-07T00:00:00Z",
  rows: [{ key: "2026-08-01", label: "Aug 1", current: { billedRevenue: 200 }, comparison: { billedRevenue: 100 }, delta: { billedRevenue: 100 }, deltaPercent: { billedRevenue: 100 } }],
  metadata: {
    definitionName: "Pinned daily revenue", dimension: "date",
    metrics: [{ key: "billedRevenue", label: "Billed revenue", definition: "", denominator: null, timestampBasis: "", moneyUnit: "USD", availability: "", valueKeys: ["billedRevenue"] }],
    selectedFilters: [], comparison: { mode: "previousPeriod" }, presentation: { kind: "timeSeries", limit: 10, orderBy: "dimension", direction: "asc" },
    bounds: { shops: 1, days: 7, periods: 2, estimatedQueryCost: 1, maxQueryCost: 2_000_000 },
    coverage: { business: true, payments: true, staff: true, laborParts: true, planViews: true, recommendationEvents: true },
    dataQuality: { unknownAdvisorRepairOrders: 0, unknownTechnicianJobs: 0, dimensionsTruncated: false, notes: [] },
    truncated: false,
    source: "reporting-kpi-service",
  },
}, "https://example.com/report", "https://example.com/unsubscribe");
assert.match(savedEmail.subject, /Pinned daily revenue/);
assert.match(savedEmail.html, /timeSeries report/);
assert.match(savedEmail.html, /Billed revenue \(comparison\)/, "pinned comparison is rendered");
const snapshotCsv = declarativeReportCsv({
  ...({
    ok: true, version: 1, definitionId: "snapshot", generatedAt: "2026-08-07T00:00:00Z",
    rows: [{ key: "one", label: "=unsafe", current: { billedRevenue: 200 }, comparison: { billedRevenue: 100 }, delta: null, deltaPercent: null }],
    metadata: {
      definitionName: "Snapshot", dimension: "none",
      metrics: [{ key: "billedRevenue", label: "Billed revenue", definition: "", denominator: null, timestampBasis: "", moneyUnit: "USD", availability: "", valueKeys: ["billedRevenue"] }],
      selectedFilters: [], comparison: { mode: "previousPeriod" }, presentation: { kind: "scorecard" },
      bounds: { shops: 1, days: 7, periods: 2, estimatedQueryCost: 1, maxQueryCost: 2_000_000 },
      coverage: { business: true, payments: true, staff: true, laborParts: true, planViews: true, recommendationEvents: true },
      dataQuality: { unknownAdvisorRepairOrders: 0, unknownTechnicianJobs: 0, dimensionsTruncated: false, notes: [] },
      truncated: false, source: "reporting-kpi-service",
    },
  } as any),
});
assert.match(snapshotCsv, /billedRevenue_comparison/);
assert.match(snapshotCsv, /"'=unsafe"/, "snapshot exports retain spreadsheet formula hardening");

console.log("reporting delivery smoke: ALL PASS");