"use client";

import { useEffect, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { CustomReportBuilder } from "./custom-report-builder";
import { ReportingSubscriptionManager } from "./reporting-subscription-manager";

type ScopeKind = "shop" | "enterprise" | "platform";
type Me = {
  role?: string;
  shopId?: number;
  enterpriseId?: string | null;
  isPlatformAdmin?: boolean;
  platformAdmin?: boolean;
};

export default function ReportingPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [scope, setScope] = useState<ScopeKind>("shop");
  const [requestedShopId, setRequestedShopId] = useState<number>();
  const [requestedEnterpriseId, setRequestedEnterpriseId] = useState<string>();
  const [initialReportId, setInitialReportId] = useState<string>();
  const [initialReportVersion, setInitialReportVersion] = useState<number>();
  const [initialRange, setInitialRange] = useState<{ start?: string; end?: string; locationId?: string; advisorKey?: string; technicianKey?: string }>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetch("/api/auth/me", { credentials: "include" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((user: Me | null) => {
        setMe(user);
        const params = new URLSearchParams(window.location.search);
        const requestedScope = params.get("scope") as ScopeKind | null;
        const platform = Boolean(user?.isPlatformAdmin || user?.platformAdmin);
        const enterprise = Boolean(user?.enterpriseId && (user.role === "owner" || user.role === "admin"));
        if (requestedScope === "platform" && platform) setScope("platform");
        else if (requestedScope === "enterprise" && enterprise) setScope("enterprise");
        else if (requestedScope === "shop") setScope("shop");
        else if (platform) setScope("platform");
        else if (enterprise) setScope("enterprise");
        const shopId = Number(params.get("shopId"));
        if (Number.isSafeInteger(shopId) && shopId > 0) setRequestedShopId(shopId);
        const enterpriseId = params.get("enterpriseId");
        if (enterpriseId) setRequestedEnterpriseId(enterpriseId);
        const reportId = params.get("reportId");
        if (reportId) setInitialReportId(reportId);
        const reportVersion = Number(params.get("reportVersion"));
        if (Number.isSafeInteger(reportVersion) && reportVersion > 0) setInitialReportVersion(reportVersion);
        setInitialRange({
          start: params.get("startDate") || undefined,
          end: params.get("endDate") || undefined,
          locationId: params.get("locationId") || undefined,
          advisorKey: params.get("advisorKey") || undefined,
          technicianKey: params.get("technicianKey") || undefined,
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const canEnterprise = Boolean(me?.enterpriseId && (me.role === "owner" || me.role === "admin"));
  const canPlatform = Boolean(me?.isPlatformAdmin || me?.platformAdmin);
  const reportScope = {
    kind: scope,
    ...(scope === "shop" ? { shopId: requestedShopId ?? me?.shopId } : {}),
    ...(scope === "enterprise" ? { enterpriseId: requestedEnterpriseId ?? me?.enterpriseId ?? undefined } : {}),
  };

  return <main className="min-h-[100dvh] bg-[#f4f7fa] p-4 text-slate-900 sm:p-6 lg:p-8">
    <div className="mx-auto max-w-[1400px] space-y-5">
      <header className="border-b border-slate-200 pb-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.18em] text-[#2f6fae]"><span className="h-2 w-2 bg-[#f0aa30]" />Operations intelligence</div>
            <h1 className="text-3xl font-semibold tracking-[-.04em] text-slate-950">Performance reporting</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">Choose the metrics and grouping you need, then run the report. Nothing is queried until you click Run.</p>
          </div>
          <label className="text-xs font-bold text-slate-700">Reporting scope
            <select value={scope} onChange={(event) => setScope(event.target.value as ScopeKind)} className="filter ml-2">
              <option value="shop">This location</option>
              {canEnterprise && <option value="enterprise">All locations</option>}
              {canPlatform && <option value="platform">Platform</option>}
            </select>
          </label>
        </div>
      </header>
      <section className="rounded-lg border border-[#c7dfef] bg-[#edf7fd] px-4 py-3 text-sm text-[#174b78]">
        <strong>Reports build in the background.</strong> A large first run may take a few minutes. You can leave this page and return; completed results are saved, and stale results remain visible while one refresh runs.
      </section>
      {loading
        ? <div className="flex min-h-64 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-500">Loading report definitions…</div>
        : me && (reportScope.kind === "platform" || reportScope.shopId || reportScope.enterpriseId)
          ? <CustomReportBuilder
              key={`${reportScope.kind}:${reportScope.shopId || ""}:${reportScope.enterpriseId || ""}`}
              scope={reportScope}
              initialReportId={initialReportId}
              initialReportVersion={initialReportVersion}
              initialRange={initialRange}
            />
          : <div className="flex min-h-64 items-center justify-center rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"><span><FileSpreadsheet className="mx-auto mb-2 h-6 w-6 text-slate-300" />A reporting scope could not be resolved for this account.</span></div>}
      {!loading && me && <ReportingSubscriptionManager />}
    </div>
    <style jsx global>{`
      .action { display:inline-flex; align-items:center; gap:.5rem; border-radius:.375rem; padding:.5rem .75rem; font-size:.875rem; font-weight:700; transition:background-color .15s, border-color .15s; }
      .action.secondary { border:1px solid #cbd5e1; background:#fff; color:#334155; box-shadow:0 1px 2px rgb(15 23 42 / .05); } .action.secondary:hover { border-color:#3c81c3; color:#28679f; }
      .action.primary { background:#347bbd; color:#fff; } .action.primary:hover { background:#28679f; } .action:disabled { cursor:not-allowed; opacity:.55; }
      .filter { border:1px solid #cbd5e1; border-radius:.375rem; background:#fff; padding:.375rem .625rem; font-size:.75rem; color:#334155; }
      .panel { border:1px solid #e2e8f0; border-radius:.5rem; background:#fff; box-shadow:0 1px 2px rgb(15 23 42 / .05); }
      .icon { border-radius:.375rem; padding:.375rem; color:#64748b; transition:background-color .15s; } .icon:hover { background:#f1f5f9; }
    `}</style>
  </main>;
}