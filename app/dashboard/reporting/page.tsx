"use client";

import { useEffect, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { CustomReportBuilder } from "./custom-report-builder";
import { InvoiceHoursDashboard } from "./invoice-hours-dashboard";
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
  const [tab, setTab] = useState<"invoice" | "custom">("invoice");

  useEffect(() => {
    void fetch("/api/auth/me", { credentials: "include" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((user: Me | null) => {
        setMe(user);
        const params = new URLSearchParams(window.location.search);
        const requestedScope = params.get("scope") as ScopeKind | null;
        const platform = Boolean(user?.isPlatformAdmin || user?.platformAdmin);
         const enterprise = Boolean(user?.enterpriseId && (platform || user.role === "owner" || user.role === "admin"));
        if (requestedScope === "platform" && platform) setScope("platform");
        else if (requestedScope === "enterprise" && enterprise) setScope("enterprise");
        else if (requestedScope === "shop") setScope("shop");
        else if (enterprise) setScope("enterprise");
        const shopId = Number(params.get("shopId"));
        if (Number.isSafeInteger(shopId) && shopId > 0) setRequestedShopId(shopId);
        const enterpriseId = params.get("enterpriseId");
        if (enterpriseId) setRequestedEnterpriseId(enterpriseId);
        const reportId = params.get("reportId");
        if (reportId) { setInitialReportId(reportId); setTab("custom"); }
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
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

   const canEnterprise = Boolean(me?.enterpriseId && (me.isPlatformAdmin || me.platformAdmin || me.role === "owner" || me.role === "admin"));
  const canPlatform = Boolean(me?.isPlatformAdmin || me?.platformAdmin);
  const reportScope = {
    kind: scope,
    ...(scope === "shop" ? { shopId: requestedShopId ?? me?.shopId } : {}),
    ...(scope === "enterprise" ? { enterpriseId: requestedEnterpriseId ?? me?.enterpriseId ?? undefined } : {}),
  };

  return <main className="mos-reporting min-h-[100dvh] bg-[#f4f7fa] p-4 text-slate-900 sm:p-6 lg:p-8">
    <div className="mx-auto max-w-[1400px] space-y-5">
      <header className="border-b border-slate-200 pb-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.18em] text-[#2f6fae]"><span className="h-2 w-2 bg-[#f0aa30]" />Operations intelligence</div>
            <h1 className="text-3xl font-semibold tracking-[-.04em] text-slate-950">Performance reporting</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">Compare labor hours presented and sold per invoice. Nothing is queried until you click Run. Custom reports remain available separately.</p>
          </div>
          <label className="text-xs font-bold text-slate-700">Reporting scope
             <select value={scope} onChange={(event) => {
               setScope(event.target.value as ScopeKind);
               setInitialRange(current => ({ ...current, locationId: undefined }));
             }} className="filter ml-2">
              <option value="shop">This location</option>
               {canEnterprise && <option value="enterprise">Selected enterprise</option>}
               {canPlatform && <option value="platform">Platform-wide (all enterprises)</option>}
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
           ? <div>
             <div role="tablist" aria-label="Reporting views" className="mb-5 flex gap-1 border-b border-slate-200" onKeyDown={event => {
               if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
               event.preventDefault();
               const next = event.key === "Home" ? "invoice" : event.key === "End" ? "custom" : tab === "invoice" ? "custom" : "invoice";
               setTab(next);
               document.getElementById(next === "invoice" ? "invoice-hours-tab" : "custom-reporting-tab")?.focus();
             }}>
               <button role="tab" id="invoice-hours-tab" tabIndex={tab === "invoice" ? 0 : -1} aria-controls="invoice-hours-panel" aria-selected={tab === "invoice"} onClick={() => setTab("invoice")} className={`border-b-2 px-4 py-3 text-sm font-bold ${tab === "invoice" ? "border-[#347bbd] text-[#28679f]" : "border-transparent text-slate-500"}`}>Invoice hours</button>
               <button role="tab" id="custom-reporting-tab" tabIndex={tab === "custom" ? 0 : -1} aria-controls="custom-reporting-panel" aria-selected={tab === "custom"} onClick={() => setTab("custom")} className={`border-b-2 px-4 py-3 text-sm font-bold ${tab === "custom" ? "border-[#347bbd] text-[#28679f]" : "border-transparent text-slate-500"}`}>Custom reporting</button>
             </div>
             <div role="tabpanel" id="invoice-hours-panel" aria-labelledby="invoice-hours-tab" hidden={tab !== "invoice"}>
               <InvoiceHoursDashboard key={`${reportScope.kind}:${reportScope.shopId || ""}:${reportScope.enterpriseId || ""}`} scope={reportScope} initialRange={initialRange} />
             </div>
             <div role="tabpanel" id="custom-reporting-panel" aria-labelledby="custom-reporting-tab" hidden={tab !== "custom"}>
               <CustomReportBuilder
              key={`${reportScope.kind}:${reportScope.shopId || ""}:${reportScope.enterpriseId || ""}`}
              scope={reportScope}
              initialReportId={initialReportId}
              initialReportVersion={initialReportVersion}
              initialRange={initialRange}
            />
             </div>
           </div>
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
      @media screen {
        html[data-theme="dark"] .mos-reporting { background:var(--mos-canvas); }
        html[data-theme="dark"] .mos-reporting .action.secondary,
        html[data-theme="dark"] .mos-reporting .filter,
        html[data-theme="dark"] .mos-reporting .panel { background:var(--mos-surface); color:var(--mos-ink-secondary); border-color:var(--mos-line-strong); }
        html[data-theme="dark"] .mos-reporting .action.secondary:hover,
        html[data-theme="dark"] .mos-reporting .icon:hover { background:var(--mos-surface-hover); color:var(--mos-info-ink); }
        html[data-theme="dark"] .mos-reporting .icon { color:var(--mos-ink-muted); }
        html[data-theme="dark"] .mos-reporting :focus-visible { outline-color:var(--mos-focus); }
      }
    `}</style>
  </main>;
}