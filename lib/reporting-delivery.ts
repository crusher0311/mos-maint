import { createHash, randomBytes } from "node:crypto";
import type { SessionInfo } from "@/lib/auth";
import { finalizeMetrics, type ReportingGroup, type ReportingKpiResponse, type ReportingMetricValues } from "@/lib/reporting-kpi-contract";
import { getReportingPeriods, normalizeReportingRange } from "@/lib/reporting-kpi-service";
import { resolveReportingScope } from "@/lib/reporting-scope";
import { sendEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/app-host";
import { logAdminAction } from "@/lib/data/repositories/audit-logs";
import { findSavedReportingDefinition, type SavedReportingDefinition } from "@/lib/data/repositories/saved-reporting-definitions";
import { canReadCustomReport } from "@/lib/custom-report-access";
import { executeReportDefinition } from "@/lib/report-definition-compiler";
import type { DeclarativeReportResult } from "@/lib/report-definition-contract";
import {
  claimDueReportingSubscriptions,
  completeReportingDelivery,
  findReportingRecipient,
  type ReportingSubscriptionDocument,
} from "@/lib/data/repositories/reporting-subscriptions";

export const REPORTING_EXPORT_MAX_ROWS = 5_000;

export type ReportingSubscriptionInput = {
  recipientEmail: string;
  cadence: "weekly" | "monthly";
  timezone: string;
  sendHour?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  scope: { kind: "shop" | "enterprise" | "platform"; shopId?: number; enterpriseId?: string };
  filters?: { locationId?: number; advisorKey?: string; technicianKey?: string };
  reportId?: string;
  reportVersion?: number;
  paused?: boolean;
};

export function validateReportingSubscription(input: unknown): ReportingSubscriptionInput {
  if (!input || typeof input !== "object") throw new Error("Invalid subscription");
  const x = input as any;
  const email = String(x.recipientEmail || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Valid recipientEmail is required");
  if (!["weekly", "monthly"].includes(x.cadence)) throw new Error("cadence must be weekly or monthly");
  const timezone = String(x.timezone || "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { throw new Error("Invalid timezone"); }
  const sendHour = x.sendHour == null ? 8 : Number(x.sendHour);
  if (!Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) throw new Error("sendHour must be between 0 and 23");
  const kind = x.scope?.kind;
  if (!["shop", "enterprise", "platform"].includes(kind)) throw new Error("Invalid reporting scope");
  const dayOfWeek = x.dayOfWeek == null ? 1 : Number(x.dayOfWeek);
  const dayOfMonth = x.dayOfMonth == null ? 1 : Number(x.dayOfMonth);
  if (x.cadence === "weekly" && (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7)) throw new Error("dayOfWeek must be 1 through 7");
  if (x.cadence === "monthly" && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28)) throw new Error("dayOfMonth must be 1 through 28");
  const locationId = x.filters?.locationId == null ? undefined : Number(x.filters.locationId);
  if (locationId != null && (!Number.isSafeInteger(locationId) || locationId <= 0)) throw new Error("Invalid location filter");
  if (x.filters?.advisorKey && x.filters?.technicianKey) throw new Error("Choose either an advisor or technician filter");
  const reportId = String(x.reportId ?? x.savedReportId ?? "").trim() || undefined;
  const rawReportVersion = x.reportVersion ?? x.savedReportVersion;
  const reportVersion = rawReportVersion == null ? undefined : Number(rawReportVersion);
  if (reportVersion != null && (!Number.isSafeInteger(reportVersion) || reportVersion <= 0)) throw new Error("reportVersion must be a positive integer");
  if (reportVersion != null && !reportId) throw new Error("reportId is required with reportVersion");
  if (reportId && reportId.length > 200) throw new Error("reportId is too long");
  return {
    recipientEmail: email, cadence: x.cadence, timezone, sendHour,
    ...(x.cadence === "weekly" ? { dayOfWeek } : { dayOfMonth }),
    scope: {
      kind,
      ...(x.scope.shopId != null ? { shopId: Number(x.scope.shopId) } : {}),
      ...(x.scope.enterpriseId ? { enterpriseId: String(x.scope.enterpriseId) } : {}),
    },
    ...(x.filters ? { filters: {
      ...(locationId ? { locationId } : {}),
      ...(x.filters.advisorKey ? { advisorKey: String(x.filters.advisorKey) } : {}),
      ...(x.filters.technicianKey ? { technicianKey: String(x.filters.technicianKey) } : {}),
    } } : {}),
    ...(reportId ? { reportId } : {}),
    ...(reportVersion ? { reportVersion } : {}),
    paused: Boolean(x.paused),
  };
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return { weekday: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(get("weekday")) || 0, day: Number(get("day")), hour: Number(get("hour")) };
}

export function nextReportingRun(input: Pick<ReportingSubscriptionInput, "cadence"|"timezone"|"sendHour"|"dayOfWeek"|"dayOfMonth">, after = new Date()) {
  let candidate = new Date(Math.floor(after.getTime() / 3600000) * 3600000 + 3600000);
  for (let i = 0; i < 24 * 35; i++, candidate = new Date(candidate.getTime() + 3600000)) {
    const p = zonedParts(candidate, input.timezone);
    if (p.hour === input.sendHour && (
      input.cadence === "weekly" ? p.weekday === (input.dayOfWeek! % 7) : p.day === input.dayOfMonth
    )) return candidate;
  }
  throw new Error("Unable to schedule reporting subscription");
}

export function nextReportingRetry(after = new Date()) {
  return new Date(after.getTime() + 60 * 60 * 1000);
}

export const createDisableToken = () => randomBytes(32).toString("base64url");
export const hashDisableToken = (token: string) => createHash("sha256").update(token).digest("hex");

const csvCell = (value: unknown) => {
  let text = String(value ?? "");
  // Provider-reported staff/location labels are untrusted spreadsheet input.
  if (typeof value === "string" && /^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, "\"\"")}"`;
};
export function filterReportingResult(report: ReportingKpiResponse, filters: ReportingSubscriptionInput["filters"] = {}, requireMatch = true) {
  if (filters?.advisorKey && filters.technicianKey) throw new Error("Choose either an advisor or technician filter");
  if (filters?.advisorKey) {
    const selected = report.byAdvisor.find((x) => x.key === filters.advisorKey);
    if (!selected) {
      if (requireMatch) throw new Error("Selected advisor is unavailable in this range");
      return { ...report, summary: finalizeMetrics({}), byLocation: [], byAdvisor: [], byTechnician: [] };
    }
    return { ...report, summary: selected.metrics, availability: selected.availability, byLocation: [], byAdvisor: [selected], byTechnician: [] };
  }
  if (filters?.technicianKey) {
    const selected = report.byTechnician.find((x) => x.key === filters.technicianKey);
    if (!selected) {
      if (requireMatch) throw new Error("Selected technician is unavailable in this range");
      return { ...report, summary: finalizeMetrics({}), byLocation: [], byAdvisor: [], byTechnician: [] };
    }
    return { ...report, summary: selected.metrics, availability: selected.availability, byLocation: [], byAdvisor: [], byTechnician: [selected] };
  }
  return report;
}

export type ReportingCsvOptions = {
  selectedFields?: unknown[];
  layout?: unknown;
  maxRows?: number;
};

const fieldKey = (field: unknown) => typeof field === "string"
  ? field
  : field && typeof field === "object"
    ? String((field as any).key ?? (field as any).field ?? (field as any).id ?? "")
    : "";

export function reportingCsvResult(
  report: ReportingKpiResponse,
  filters: ReportingSubscriptionInput["filters"] = {},
  options: ReportingCsvOptions = {},
) {
  report = filterReportingResult(report, filters);
  let groups: Array<{ dimension: string; group: ReportingGroup }> = [
    ...report.timeSeries.map((group) => ({ dimension: "date", group })),
    ...report.byLocation.map((group) => ({ dimension: "location", group })),
    ...report.byAdvisor.map((group) => ({ dimension: "advisor", group })),
    ...report.byTechnician.map((group) => ({ dimension: "technician", group })),
    ...report.byRecommendationSource.map((group) => ({ dimension: "recommendationSource", group })),
  ];
  const savedDimension = typeof (options.layout as any)?.dimension === "string"
    ? (options.layout as any).dimension
    : undefined;
  // A saved dimension is an explicit projection, including date. Previously
  // date was treated like an unspecified dimension and leaked other rows.
  if (savedDimension && savedDimension !== "none") {
    groups = groups.filter((entry) => entry.dimension === savedDimension);
  }
  const savedFilters = Array.isArray((options.layout as any)?.filters) ? (options.layout as any).filters : [];
  groups = groups.filter(({ dimension, group }) => savedFilters.every((filter: any) => {
    if (!filter || filter.dimension !== dimension) return true;
    const values = new Set((Array.isArray(filter.value) ? filter.value : [filter.value]).map(String));
    const matches = values.has(group.key);
    return filter.operator === "eq" || filter.operator === "in" ? matches : !matches;
  }));
  if (filters?.locationId) groups = groups.filter((x) => x.group.shopId === filters.locationId);
  if (filters?.advisorKey) groups = groups.filter((x) => x.dimension !== "advisor" || x.group.key === filters.advisorKey);
  if (filters?.technicianKey) groups = groups.filter((x) => x.dimension !== "technician" || x.group.key === filters.technicianKey);
  const metricKeys = Object.keys(report.summary) as Array<keyof ReportingMetricValues>;
  const orderBy = String((options.layout as any)?.orderBy ?? "");
  const direction = (options.layout as any)?.direction === "desc" ? -1 : 1;
  if (orderBy === "dimension") {
    groups.sort((a, b) => direction * a.group.label.localeCompare(b.group.label));
  } else if (metricKeys.includes(orderBy as keyof ReportingMetricValues)) {
    groups.sort((a, b) => direction * ((a.group.metrics[orderBy as keyof ReportingMetricValues] ?? 0) - (b.group.metrics[orderBy as keyof ReportingMetricValues] ?? 0)));
  }
  const available = new Set(["dimension", "key", "label", "shopId", ...metricKeys]);
  const layoutColumns = Array.isArray((options.layout as any)?.columns) ? (options.layout as any).columns : undefined;
  const requested = (layoutColumns ?? options.selectedFields)?.map(fieldKey).filter((key: string) => available.has(key));
  const columns = requested?.length ? [...new Set<string>(requested)] : ["dimension", "key", "label", "shopId", ...metricKeys];
  const layoutLimit = Number((options.layout as any)?.limit);
  const requestedCaps = [
    options.maxRows,
    Number.isSafeInteger(layoutLimit) && layoutLimit > 0 ? layoutLimit : undefined,
    REPORTING_EXPORT_MAX_ROWS,
  ].filter((value): value is number => value != null);
  const rawMaxRows = Math.min(...requestedCaps);
  if (!Number.isSafeInteger(rawMaxRows) || rawMaxRows < 1) throw new Error("maxRows must be a positive integer");
  const maxRows = Math.min(rawMaxRows, REPORTING_EXPORT_MAX_ROWS);
  const value = (column: string, dimension: string, group?: ReportingGroup) => {
    if (column === "dimension") return dimension;
    if (column === "key") return group?.key ?? "summary";
    if (column === "label") return group?.label ?? "Authorized scope";
    if (column === "shopId") return group?.shopId ?? "";
    return group ? group.metrics[column as keyof ReportingMetricValues] : report.summary[column as keyof ReportingMetricValues];
  };
  const data = savedDimension === "none"
    ? [{ dimension: "summary", group: undefined as ReportingGroup | undefined }]
    : savedDimension
      ? groups
      : [{ dimension: "summary", group: undefined as ReportingGroup | undefined }, ...groups];
  const selected = data.slice(0, maxRows);
  const lines = selected.map(({ dimension, group }) => columns.map((column) => csvCell(value(column, dimension, group))).join(","));
  return {
    csv: [columns.map(csvCell).join(","), ...lines].join("\r\n"),
    rowCount: selected.length,
    truncated: data.length > selected.length,
    columns,
  };
}

export function reportingCsv(report: ReportingKpiResponse, filters: ReportingSubscriptionInput["filters"] = {}, options: ReportingCsvOptions = {}) {
  return reportingCsvResult(report, filters, options).csv;
}

export async function resolveSubscriptionReport(
  input: Pick<ReportingSubscriptionInput, "reportId" | "reportVersion" | "scope">,
): Promise<SavedReportingDefinition | null> {
  if (!input.reportId) return null;
  const saved = await findSavedReportingDefinition(input.reportId, input.reportVersion);
  if (!saved) throw new Error("Saved report or referenced version is unavailable");
  if (saved.scope && JSON.stringify(saved.scope) !== JSON.stringify(input.scope)) {
    throw new Error("Saved report scope no longer matches subscription scope");
  }
  return saved;
}

function pct(current: number | null, prior: number | null) {
  if (current == null || prior == null || prior === 0) return "n/a";
  const n = ((current - prior) / Math.abs(prior)) * 100;
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
const escapeHtml = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
export function buildReportingSummaryEmail(current: ReportingKpiResponse, prior: ReportingKpiResponse | null, dashboardUrl: string, unsubscribeUrl: string) {
  const locations = [...current.byLocation].sort((a,b) => (b.metrics.billedRevenue || 0) - (a.metrics.billedRevenue || 0));
  const staff = [...current.byAdvisor, ...current.byTechnician].sort((a,b) => (b.metrics.billedRevenue || 0) - (a.metrics.billedRevenue || 0)).slice(0, 5);
  const headline = prior
    ? `Revenue ${pct(current.summary.billedRevenue, prior.summary.billedRevenue)} · ROs ${pct(current.summary.repairOrderCount, prior.summary.repairOrderCount)}`
    : "Current period results · prior-period comparison unavailable";
  const lines = (xs: ReportingGroup[]) => xs.slice(0,5).map((x) => `<li>${escapeHtml(x.label)}: $${(x.metrics.billedRevenue || 0).toLocaleString("en-US",{maximumFractionDigits:0})}</li>`).join("");
  return {
    subject: `MOS reporting summary — ${headline}`,
    html: `<div style="font-family:system-ui;line-height:1.5"><h2>Reporting summary</h2><p><b>${escapeHtml(headline)}</b></p><h3>Location outliers</h3><ul>${lines(locations)}</ul><h3>Staff outliers</h3><ul>${lines(staff)}</ul><p><a href="${escapeHtml(dashboardUrl)}">Open filtered dashboard</a></p><p style="font-size:12px;color:#666"><a href="${escapeHtml(unsubscribeUrl)}">Disable this summary</a></p></div>`,
    text: `Reporting summary\n${headline}\nOpen dashboard: ${dashboardUrl}\nDisable: ${unsubscribeUrl}`,
  };
}

const renderedValue = (value: number | null | undefined) =>
  value == null ? "n/a" : Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Render the already-projected result of a saved, immutable definition. */
export function buildSavedReportEmail(result: DeclarativeReportResult, dashboardUrl: string, unsubscribeUrl: string) {
  const keys = result.metadata.metrics.flatMap((metric) => metric.valueKeys);
  const headers = result.metadata.metrics.flatMap((metric) =>
    metric.valueKeys.map((key) => metric.valueKeys.length === 1 ? metric.label : `${metric.label} (${key})`),
  );
  const comparison = result.metadata.comparison?.mode !== "none";
  const rowHtml = result.rows.map((row) => `<tr><td>${escapeHtml(row.label)}</td>${
    keys.map((key) => `<td>${escapeHtml(renderedValue(row.current[key]))}</td>${
      comparison ? `<td>${escapeHtml(renderedValue(row.comparison?.[key]))}</td>` : ""}`).join("")
  }</tr>`).join("");
  const tableHeaders = ["Dimension", ...headers.flatMap((header) => comparison ? [header, `${header} (comparison)`] : [header])];
  const textRows = result.rows.map((row) => [
    row.label,
    ...keys.flatMap((key) => comparison
      ? [renderedValue(row.current[key]), renderedValue(row.comparison?.[key])]
      : [renderedValue(row.current[key])]),
  ].join(" | ")).join("\n");
  const presentation = result.metadata.presentation.kind;
  return {
    subject: `MOS report — ${result.metadata.definitionName}`,
    html: `<div style="font-family:system-ui;line-height:1.5"><h2>${escapeHtml(result.metadata.definitionName)}</h2><p>${escapeHtml(presentation)} report · ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}</p><table border="1" cellpadding="6" cellspacing="0"><thead><tr>${tableHeaders.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rowHtml}</tbody></table><p><a href="${escapeHtml(dashboardUrl)}">Open this report</a></p><p style="font-size:12px;color:#666"><a href="${escapeHtml(unsubscribeUrl)}">Disable this report</a></p></div>`,
    text: `${result.metadata.definitionName}\n${presentation} report\n${tableHeaders.join(" | ")}\n${textRows}\nOpen report: ${dashboardUrl}\nDisable: ${unsubscribeUrl}`,
  };
}

export function recipientSession(user: any): SessionInfo {
  return {
    token: "reporting-delivery", email: String(user.emailLower || user.email).toLowerCase(),
    shopId: Number(user.shopId), role: String(user.role || ""), isPlatformAdmin: Boolean(user.isPlatformAdmin || user.role === "platform_admin"),
  };
}

export async function validateRecipientScope(email: string, scopeRequest: ReportingSubscriptionInput["scope"]) {
  const user = await findReportingRecipient(email);
  if (!user || user.active === false || user.status === "disabled") throw new Error("Recipient does not have active access");
  const scope = await resolveReportingScope(recipientSession(user), {
    kind: scopeRequest.kind, shopId: scopeRequest.shopId == null ? null : String(scopeRequest.shopId), enterpriseId: scopeRequest.enterpriseId || null,
  });
  return { user, scope };
}

/** Shared by subscription mutation and the just-in-time delivery check. */
export function canRecipientReadSavedReport(user: any, savedReport: SavedReportingDefinition, scope: { shopIds: readonly number[]; enterpriseId?: string }) {
  return canReadCustomReport({
    email: String(user.emailLower || user.email),
    isPlatformAdmin: Boolean(user.isPlatformAdmin || user.role === "platform_admin"),
  }, savedReport.raw as any, scope);
}

export function reportingDashboardUrl(
  base: string,
  doc: Pick<ReportingSubscriptionDocument, "scope"|"filters"|"reportId"|"reportVersion">,
  start: Date,
  end: Date,
) {
  const q = new URLSearchParams({
    scope: doc.scope.kind,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  });
  if (doc.scope.shopId) q.set("shopId", String(doc.scope.shopId));
  if (doc.scope.enterpriseId) q.set("enterpriseId", doc.scope.enterpriseId);
  if (doc.filters?.locationId) q.set("locationId", String(doc.filters.locationId));
  if (doc.filters?.advisorKey) q.set("advisorKey", doc.filters.advisorKey);
  if (doc.filters?.technicianKey) q.set("technicianKey", doc.filters.technicianKey);
  if (doc.reportId) q.set("reportId", doc.reportId);
  if (doc.reportVersion) q.set("reportVersion", String(doc.reportVersion));
  return `${base.replace(/\/+$/, "")}/dashboard/reporting?${q}`;
}

export async function deliverDueReportingSubscriptions(now = new Date()) {
  // A delivery can use almost all of the bounded 45-second KPI budget plus an
  // email send. Claim one at a time so the 60-second cron route cannot multiply
  // database work; remaining due deliveries are picked up on the next run.
  const docs = await claimDueReportingSubscriptions(now, 1);
  let sent = 0, failed = 0;
  for (const doc of docs) {
    const next = nextReportingRun(doc, now);
    const key = doc.processingKey!;
    try {
      const savedReport = await resolveSubscriptionReport(doc);
      if (savedReport) {
        const { user: creator, scope: creatorScope } = await validateRecipientScope(doc.createdBy, doc.scope);
        if (!canReadCustomReport({
          email: doc.createdBy,
          isPlatformAdmin: Boolean(creator.isPlatformAdmin || creator.role === "platform_admin"),
        }, savedReport.raw as any, creatorScope)) {
          throw new Error("Creator access to saved report was revoked");
        }
      }
      const { user: recipient, scope } = await validateRecipientScope(doc.recipientEmail, doc.scope);
      if (savedReport && !canRecipientReadSavedReport(recipient, savedReport, scope)) {
        throw new Error("Recipient access to saved report was revoked");
      }
      if (doc.filters?.locationId && !scope.shopIds.includes(doc.filters.locationId)) throw new Error("Recipient access to filtered location was revoked");
      const deliveryScope = doc.filters?.locationId ? {
        ...scope,
        kind: "shop" as const,
        shopIds: [doc.filters.locationId],
        shops: scope.shops.filter((shop) => shop.shopId === doc.filters!.locationId),
      } : scope;
      const base = getAppBaseUrl();
      const unsubscribeUrl = `${base}/api/reports/unsubscribe?token=${encodeURIComponent(doc.disableToken)}`;
      let email: ReturnType<typeof buildReportingSummaryEmail>;
      if (savedReport) {
        // Saved subscriptions execute the exact pinned definition (rather than
        // the cadence-based KPI summary retained for legacy subscriptions).
        const result = await executeReportDefinition(savedReport.definition, deliveryScope, {
          serviceOptions: { deadlineMs: 45_000 },
        });
        const range = savedReport.definition.dateRange as { start: string; end: string };
        email = buildSavedReportEmail(
          result,
          reportingDashboardUrl(base, doc, new Date(`${range.start}T00:00:00.000Z`), new Date(`${range.end}T00:00:00.000Z`)),
          unsubscribeUrl,
        );
      } else {
        const days = doc.cadence === "weekly" ? 7 : 30;
        const end = new Date(now.getTime() - 86400000);
        const start = new Date(end.getTime() - (days - 1) * 86400000);
        const priorEnd = new Date(start.getTime() - 86400000);
        const priorStart = new Date(priorEnd.getTime() - (days - 1) * 86400000);
        const periods = await getReportingPeriods(
          deliveryScope,
          normalizeReportingRange(start.toISOString(), end.toISOString()),
          normalizeReportingRange(priorStart.toISOString(), priorEnd.toISOString()),
          { deadlineMs: 45_000 },
        );
        const current = filterReportingResult(periods.current, doc.filters);
        const prior = periods.comparison ? filterReportingResult(periods.comparison, doc.filters, false) : null;
        email = buildReportingSummaryEmail(current, prior, reportingDashboardUrl(base, doc, start, end), unsubscribeUrl);
      }
      const result = await sendEmail({ to: doc.recipientEmail, ...email });
      if (!result.ok) throw new Error(`Email suppressed: ${result.reason}`);
      await logAdminAction({
        action: "data_export",
        adminEmail: doc.createdBy,
        targetShopId: deliveryScope.shopIds.length === 1 ? deliveryScope.shopIds[0] : undefined,
        details: {
          report: savedReport?.reportId ?? "reporting_kpis",
          reportVersion: savedReport?.version,
          delivery: "scheduled_email",
          recipientEmail: doc.recipientEmail,
          scope: deliveryScope.kind,
          shopIds: deliveryScope.shopIds,
        },
      });
      await completeReportingDelivery(doc._id, key, "sent", next);
      sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delivery failed";
      const revoked = /access|scope|Recipient/.test(message);
       await completeReportingDelivery(
         doc._id,
         key,
         revoked ? "access_revoked" : "failed",
         revoked ? next : nextReportingRetry(now),
         message,
         revoked,
       );
      failed++;
    }
  }
  return { claimed: docs.length, sent, failed };
}