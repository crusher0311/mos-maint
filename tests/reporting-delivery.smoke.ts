import assert from "node:assert/strict";
import {
  buildReportingSummaryEmail,
  hashDisableToken,
  nextReportingRun,
  nextReportingRetry,
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

const prior = { ...report, summary: finalizeMetrics({ repairOrderCount: 1, billedRevenue: 100 }) };
const email = buildReportingSummaryEmail(report, prior, "https://example.com/dashboard?shopId=1", "https://example.com/unsubscribe?t=x");
assert.match(email.subject, /Revenue \+100\.0%/);
assert.match(email.html, /Location outliers/);
assert.match(email.html, /Disable this summary/);
const emailWithoutPrior = buildReportingSummaryEmail(report, null, "https://example.com/dashboard?shopId=1", "https://example.com/unsubscribe?t=x");
assert.match(emailWithoutPrior.subject, /prior-period comparison unavailable/);

console.log("reporting delivery smoke: ALL PASS");