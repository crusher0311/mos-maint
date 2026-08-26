import { createHash, randomBytes } from "node:crypto";
import type { SessionInfo } from "@/lib/auth";
import { finalizeMetrics, type ReportingGroup, type ReportingKpiResponse, type ReportingMetricValues } from "@/lib/reporting-kpi-contract";
import { getReportingPeriods, normalizeReportingRange } from "@/lib/reporting-kpi-service";
import { resolveReportingScope } from "@/lib/reporting-scope";
import { sendEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/app-host";
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
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
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

export function reportingCsv(report: ReportingKpiResponse, filters: ReportingSubscriptionInput["filters"] = {}) {
  report = filterReportingResult(report, filters);
  let groups: Array<{ dimension: string; group: ReportingGroup }> = [
    ...report.byLocation.map((group) => ({ dimension: "location", group })),
    ...report.byAdvisor.map((group) => ({ dimension: "advisor", group })),
    ...report.byTechnician.map((group) => ({ dimension: "technician", group })),
  ];
  if (filters?.locationId) groups = groups.filter((x) => x.group.shopId === filters.locationId);
  if (filters?.advisorKey) groups = groups.filter((x) => x.dimension !== "advisor" || x.group.key === filters.advisorKey);
  if (filters?.technicianKey) groups = groups.filter((x) => x.dimension !== "technician" || x.group.key === filters.technicianKey);
  const keys = Object.keys(report.summary) as Array<keyof ReportingMetricValues>;
  const rows = groups.slice(0, REPORTING_EXPORT_MAX_ROWS - 1).map(({ dimension, group }) =>
    [dimension, group.key, group.label, group.shopId ?? "", ...keys.map((k) => group.metrics[k])].map(csvCell).join(","));
  const summary = ["summary", "summary", "Authorized scope", "", ...keys.map((k) => report.summary[k])].map(csvCell).join(",");
  return [["dimension","key","label","shopId",...keys].map(csvCell).join(","), summary, ...rows].join("\r\n");
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

export function reportingDashboardUrl(base: string, doc: Pick<ReportingSubscriptionDocument, "scope"|"filters">, start: Date, end: Date) {
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
      const { scope } = await validateRecipientScope(doc.recipientEmail, doc.scope);
      if (doc.filters?.locationId && !scope.shopIds.includes(doc.filters.locationId)) throw new Error("Recipient access to filtered location was revoked");
      const deliveryScope = doc.filters?.locationId ? {
        ...scope,
        kind: "shop" as const,
        shopIds: [doc.filters.locationId],
        shops: scope.shops.filter((shop) => shop.shopId === doc.filters!.locationId),
      } : scope;
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
      const currentRaw = periods.current;
      const priorRaw = periods.comparison;
      const current = filterReportingResult(currentRaw, doc.filters);
      const prior = priorRaw ? filterReportingResult(priorRaw, doc.filters, false) : null;
       const base = getAppBaseUrl();
      const email = buildReportingSummaryEmail(
        current,
        prior,
        reportingDashboardUrl(base, doc, start, end),
        `${base}/api/reports/unsubscribe?token=${encodeURIComponent(doc.disableToken)}`,
      );
      const result = await sendEmail({ to: doc.recipientEmail, ...email });
      if (!result.ok) throw new Error(`Email suppressed: ${result.reason}`);
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