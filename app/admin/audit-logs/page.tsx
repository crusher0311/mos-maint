import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth";
import { getAuditLogs, type AuditAction, type AuditLogEntry } from "@/lib/audit-log";

export const dynamic = "force-dynamic";

const ACTION_OPTIONS: Array<{ value: "" | AuditAction; label: string }> = [
  { value: "", label: "All actions" },
  { value: "user_password_reset", label: "Password resets" },
  { value: "impersonation", label: "Impersonation" },
  { value: "shop_unlock", label: "Shop unlock" },
  { value: "shop_lock", label: "Shop lock" },
  { value: "billing_override", label: "Billing override" },
  { value: "feature_toggle", label: "Feature toggle" },
  { value: "shop_settings_change", label: "Shop settings change" },
  { value: "user_role_change", label: "User role change" },
  { value: "api_key_view", label: "API key view" },
  { value: "data_export", label: "Data export" },
  { value: "build_ro_from_vhi", label: "Build RO from VHI" },
  { value: "billing_settings_change", label: "Billing settings change" },
];

const DAYS_OPTIONS = [1, 7, 30, 90];

const ACTION_LABELS: Record<string, string> = Object.fromEntries(
  ACTION_OPTIONS.filter((o) => o.value).map((o) => [o.value, o.label]),
);

const ACTION_BADGE_CLASS: Record<string, string> = {
  user_password_reset: "bg-red-100 text-red-800",
  impersonation: "bg-purple-100 text-purple-800",
  shop_unlock: "bg-green-100 text-green-800",
  shop_lock: "bg-yellow-100 text-yellow-800",
  billing_override: "bg-blue-100 text-blue-800",
  feature_toggle: "bg-indigo-100 text-indigo-800",
  shop_settings_change: "bg-gray-100 text-gray-800",
  user_role_change: "bg-orange-100 text-orange-800",
  api_key_view: "bg-pink-100 text-pink-800",
  data_export: "bg-teal-100 text-teal-800",
  build_ro_from_vhi: "bg-purple-100 text-purple-800",
  billing_settings_change: "bg-blue-100 text-blue-800",
};

function formatTarget(log: AuditLogEntry): string {
  const parts: string[] = [];
  if (log.targetUserEmail) parts.push(log.targetUserEmail);
  if (log.targetShopName) {
    parts.push(`${log.targetShopName} (#${log.targetShopId ?? "?"})`);
  } else if (log.targetShopId) {
    parts.push(`Shop #${log.targetShopId}`);
  }
  return parts.join(" · ") || "—";
}

function formatDetails(log: AuditLogEntry): string {
  if (log.action === "user_password_reset") {
    const revoked = log.details?.sessionsRevoked;
    if (typeof revoked === "number") {
      return `${revoked} session${revoked === 1 ? "" : "s"} revoked`;
    }
    return "Password force-reset";
  }
  if (log.action === "billing_settings_change") {
    const field = log.details?.field;
    if (typeof field === "string" && field) {
      const before = log.details?.before;
      const after = log.details?.after;
      const summarize = (v: unknown): string => {
        if (Array.isArray(v)) return `[${v.join(", ")}]`;
        if (v === undefined || v === null) return "—";
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return s.length > 60 ? `${s.slice(0, 57)}…` : s;
      };
      return `${field}: ${summarize(before)} → ${summarize(after)}`;
    }
  }
  if (log.action === "build_ro_from_vhi") {
    const s = log.details?.summary || {};
    const ro = log.details?.roNumber || log.details?.roId;
    const parts: string[] = [];
    if (ro) parts.push(`RO ${ro}`);
    if (typeof s.added === "number") parts.push(`${s.added} added`);
    if (typeof s.skipped === "number") parts.push(`${s.skipped} skipped`);
    if (typeof s.failed === "number" && s.failed > 0) parts.push(`${s.failed} failed`);
    return parts.join(" · ") || "—";
  }
  if (!log.details || Object.keys(log.details).length === 0) return "—";
  try {
    return JSON.stringify(log.details);
  } catch {
    return "—";
  }
}

interface PageProps {
  searchParams: Promise<{ action?: string; days?: string; adminEmail?: string }>;
}

export default async function AdminAuditLogsPage({ searchParams }: PageProps) {
  await requirePlatformAdmin();

  const params = await searchParams;
  const actionParam = (params.action || "").trim();
  const action = ACTION_OPTIONS.some((o) => o.value === actionParam)
    ? (actionParam as AuditAction | "")
    : "";
  const days = DAYS_OPTIONS.includes(Number(params.days)) ? Number(params.days) : 7;
  const adminEmail = (params.adminEmail || "").trim();

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const logs = await getAuditLogs({
    action: action || undefined,
    adminEmail: adminEmail || undefined,
    since,
    limit: 200,
  });

  const passwordResetCount = logs.filter((l) => l.action === "user_password_reset").length;

  const exportParams = new URLSearchParams();
  if (action) exportParams.set("action", action);
  exportParams.set("days", String(days));
  if (adminEmail) exportParams.set("adminEmail", adminEmail);
  const exportHref = `/api/admin/audit-logs/export?${exportParams.toString()}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin Audit Log</h1>
          <p className="mt-1 text-sm text-gray-500">
            Review platform-admin actions including impersonation, password resets, and shop changes.
          </p>
        </div>
        <a
          href={exportHref}
          className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-mos-blue"
          title="Download a CSV of the audit log entries that match the current filters"
        >
          Export CSV
        </a>
      </div>

      <form
        method="GET"
        className="bg-gray-50 border border-gray-200 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-4 gap-4"
      >
        <div>
          <label htmlFor="action" className="block text-xs font-medium text-gray-700 mb-1">
            Action
          </label>
          <select
            id="action"
            name="action"
            defaultValue={action}
            className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:border-mos-blue focus:ring-mos-blue"
          >
            {ACTION_OPTIONS.map((opt) => (
              <option key={opt.value || "all"} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="days" className="block text-xs font-medium text-gray-700 mb-1">
            Time range
          </label>
          <select
            id="days"
            name="days"
            defaultValue={String(days)}
            className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:border-mos-blue focus:ring-mos-blue"
          >
            {DAYS_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d} day{d === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="adminEmail" className="block text-xs font-medium text-gray-700 mb-1">
            Admin email
          </label>
          <input
            id="adminEmail"
            name="adminEmail"
            type="text"
            defaultValue={adminEmail}
            placeholder="filter by admin email"
            className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:border-mos-blue focus:ring-mos-blue"
          />
        </div>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-mos-blue hover:bg-mos-blue-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-mos-blue"
          >
            Apply filters
          </button>
          <Link
            href="/admin/audit-logs"
            className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
          >
            Reset
          </Link>
        </div>
      </form>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Entries shown</div>
          <div className="text-2xl font-semibold text-gray-900 mt-1">{logs.length}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Password resets</div>
          <div className="text-2xl font-semibold text-gray-900 mt-1">{passwordResetCount}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Window</div>
          <div className="text-2xl font-semibold text-gray-900 mt-1">
            Last {days} day{days === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      <div className="bg-white shadow overflow-hidden sm:rounded-lg">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  When
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Action
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Admin
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Target
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Details
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  IP
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-500">
                    No audit log entries match these filters.
                  </td>
                </tr>
              ) : (
                logs.map((log, idx) => {
                  const rawCreated: Date | string | number | undefined = log.createdAt;
                  const created =
                    rawCreated instanceof Date
                      ? rawCreated
                      : rawCreated !== undefined
                        ? new Date(rawCreated)
                        : new Date(0);
                  const badgeClass = ACTION_BADGE_CLASS[log.action] || "bg-gray-100 text-gray-800";
                  return (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                        {created.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${badgeClass}`}
                        >
                          {ACTION_LABELS[log.action] || log.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                        {log.adminEmail}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">{formatTarget(log)}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{formatDetails(log)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
                        {log.ipAddress || "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
