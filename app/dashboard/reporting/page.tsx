"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CalendarDays, ChevronRight, Download, FileSpreadsheet, MapPin, Pause, Pencil, Play, Plus, RefreshCw, Send, Trash2, Users, Wrench, X } from "lucide-react";

type ScopeKind = "shop" | "enterprise" | "platform";
type Period = "7d" | "30d" | "90d" | "custom";
type Metrics = { billedRevenue?: number | null; averageRepairOrder?: number | null; declinedDeferredDollars?: number | null; opportunityConversionRate?: number | null; plansViewed?: number | null; recommendationsAdded?: number | null; recommendationsSold?: number | null; attributedRevenue?: number | null };
type ReportingAvailability = { business?: boolean; payments?: boolean; staff?: boolean; laborParts?: boolean; planViews?: boolean; recommendationEvents?: boolean };
type DimensionRow = { key: string; label: string | null; shopId?: number | null; metrics: Metrics; availability?: ReportingAvailability | null };
type KpiResponse = { summary: Metrics; timeSeries: Array<{ key: string; label?: string | null; metrics: Metrics; availability?: ReportingAvailability | null }>; byLocation: DimensionRow[]; byAdvisor: DimensionRow[]; byTechnician: DimensionRow[]; availability?: ReportingAvailability | null; dataQuality?: { unknownAdvisorRepairOrders?: number; unknownTechnicianJobs?: number; dimensionsTruncated?: boolean; notes?: string[] | string | null } | null };
type Me = { email?: string; role?: string; shopId?: number; enterpriseId?: string | null; isPlatformAdmin?: boolean; platformAdmin?: boolean };
type Subscription = { _id: string; recipientEmail: string; cadence: "weekly" | "monthly"; timezone: string; sendHour: number; dayOfWeek?: number | null; dayOfMonth?: number | null; paused?: boolean; active?: boolean; nextRunAt?: string | null; lastRunAt?: string | null; lastStatus?: string | null; lastError?: string | null; deliveryHistory?: unknown[]; scope?: { kind: ScopeKind; shopId?: number; enterpriseId?: string }; filters?: { locationId?: number; advisorKey?: string; technicianKey?: string } };

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("en-US");
const daysFor = (period: Period) => period === "7d" ? 7 : period === "30d" ? 30 : 90;
const fmtMoney = (n: number | null | undefined) => n == null ? "Unavailable" : currency.format(n);
const fmtNumber = (n: number | null | undefined) => n == null ? "Unavailable" : integer.format(n);
const fmtPercent = (n: number | null | undefined) => n == null ? "Unavailable" : `${n.toFixed(1)}%`;
function dates(period: Period, start: string, end: string, shift = 0) {
  if (period === "custom") {
    if (!start || !end) return { startDate: "", endDate: "" };
    const startDate = new Date(`${start}T00:00:00`); const endDate = new Date(`${end}T00:00:00`);
    const length = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    startDate.setDate(startDate.getDate() - shift); endDate.setDate(endDate.getDate() - shift);
    if (length > 0 && shift) startDate.setDate(endDate.getDate() - length + 1);
    return { startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) };
  }
  const endDate = new Date(); endDate.setDate(endDate.getDate() - shift);
  const startDate = new Date(endDate); startDate.setDate(endDate.getDate() - daysFor(period) + 1);
  return { startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) };
}
function delta(current: number | null | undefined, previous: number | null | undefined) {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export default function ReportingPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [requestedShopId, setRequestedShopId] = useState<number | null>(null);
  const [requestedEnterpriseId, setRequestedEnterpriseId] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("30d");
  const [scope, setScope] = useState<ScopeKind>("shop");
  const [start, setStart] = useState(""); const [end, setEnd] = useState("");
  const [locationId, setLocationId] = useState("all"); const [advisor, setAdvisor] = useState("all"); const [technician, setTechnician] = useState("all");
  const [report, setReport] = useState<KpiResponse | null>(null); const [prior, setPrior] = useState<KpiResponse | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionForbidden, setSubscriptionForbidden] = useState(false);
  const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false); const [error, setError] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false); const [editing, setEditing] = useState<Subscription | null>(null);
  const [recipientEmail, setRecipientEmail] = useState(""); const [cadence, setCadence] = useState<"weekly" | "monthly">("weekly"); const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);

  const fetchSubscriptions = useCallback(async () => {
    try { const response = await fetch("/api/reports/subscriptions", { credentials: "include" }); if (response.status === 403) { setSubscriptionForbidden(true); return; } const json = await response.json(); if (response.ok) setSubscriptions(Array.isArray(json) ? json : json.subscriptions || []); } catch { /* dashboard data remains useful without delivery management */ }
  }, []);
  useEffect(() => { void fetch("/api/auth/me", { credentials: "include" }).then(async response => response.ok ? response.json() : null).then((user: Me | null) => {
    setMe(user);
    const params = new URLSearchParams(window.location.search);
    const requestedScope = params.get("scope") as ScopeKind | null;
    const canUsePlatform = Boolean(user?.isPlatformAdmin || user?.platformAdmin);
    const canUseEnterprise = Boolean(user?.enterpriseId && (user?.role === "owner" || user?.role === "admin"));
    if (requestedScope === "platform" && canUsePlatform) setScope("platform");
    else if (requestedScope === "enterprise" && canUseEnterprise) setScope("enterprise");
    else if (requestedScope === "shop") setScope("shop");
    else if (canUsePlatform) setScope("platform");
    else if (canUseEnterprise) setScope("enterprise");
    else setScope("shop");
    const queryStart = params.get("startDate"); const queryEnd = params.get("endDate");
    if (queryStart && queryEnd) { setStart(queryStart); setEnd(queryEnd); setPeriod("custom"); }
    const queryShopId = Number(params.get("shopId"));
    if (Number.isSafeInteger(queryShopId) && queryShopId > 0) setRequestedShopId(queryShopId);
    if (params.get("enterpriseId")) setRequestedEnterpriseId(params.get("enterpriseId"));
    if (params.get("locationId")) setLocationId(params.get("locationId")!);
    if (params.get("advisorKey")) setAdvisor(params.get("advisorKey")!);
    if (params.get("technicianKey")) setTechnician(params.get("technicianKey")!);
    if (canUsePlatform || user?.role === "owner" || user?.role === "admin") void fetchSubscriptions();
  }); }, [fetchSubscriptions]);

  const reportShopId = requestedShopId ?? me?.shopId;
  const reportEnterpriseId = requestedEnterpriseId ?? me?.enterpriseId;
  const load = useCallback(async (refresh = false) => {
    if (!reportShopId && !(scope === "enterprise" && reportEnterpriseId) && scope !== "platform") return;
    refresh ? setRefreshing(true) : setLoading(true); setError(null);
    const query = (range: { startDate: string; endDate: string }) => {
      const p = new URLSearchParams(range); p.set("scope", scope);
      if (scope === "shop" && reportShopId) p.set("shopId", String(reportShopId));
      if (scope === "enterprise" && reportEnterpriseId) p.set("enterpriseId", reportEnterpriseId);
      return p.toString();
    };
    try {
      const currentRange = dates(period, start, end);
      if (!currentRange.startDate || !currentRange.endDate) { setLoading(false); setRefreshing(false); return; }
      const customLength = period === "custom"
        ? Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000) + 1
        : 0;
      const previousRange = dates(period, start, end, period === "custom" ? customLength : daysFor(period));
      const [currentResponse, priorResponse] = await Promise.all([
        fetch(`/api/reports/kpis?${query(currentRange)}`, { credentials: "include" }),
        previousRange ? fetch(`/api/reports/kpis?${query(previousRange)}`, { credentials: "include" }) : Promise.resolve(null),
      ]);
      const currentJson = await currentResponse.json();
      if (!currentResponse.ok) throw new Error(currentJson.error || "Reporting data could not be loaded.");
      setReport(currentJson);
      if (priorResponse?.ok) setPrior(await priorResponse.json()); else setPrior(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Reporting data could not be loaded."); }
    finally { setLoading(false); setRefreshing(false); }
  }, [end, period, reportEnterpriseId, reportShopId, scope, start]);
  useEffect(() => { void load(); }, [load]);

  const locations = useMemo(() => report?.byLocation || [], [report]);
  const advisors = useMemo(() => report?.byAdvisor || [], [report]);
  const technicians = useMemo(() => report?.byTechnician || [], [report]);
  const activeLocation = locationId === "all" ? null : locations.find(item => item.key === locationId);
  const scopedShopId = activeLocation?.shopId;
  const visibleAdvisors = scopedShopId == null ? advisors : advisors.filter(item => item.shopId == null || item.shopId === scopedShopId);
  const visibleTechnicians = scopedShopId == null ? technicians : technicians.filter(item => item.shopId == null || item.shopId === scopedShopId);
  const activeAdvisor = advisor === "all" ? null : visibleAdvisors.find(item => item.key === advisor);
  const activeTechnician = technician === "all" ? null : visibleTechnicians.find(item => item.key === technician);
  const adjustedSummary: Metrics = useMemo(() => {
    const candidates = [activeLocation, activeAdvisor, activeTechnician].filter(Boolean) as DimensionRow[];
    return candidates.length ? candidates.reduce((all, item) => ({ ...all, ...item.metrics }), report?.summary || {}) : report?.summary || {};
  }, [activeAdvisor, activeLocation, activeTechnician, report]);
  const trend = report?.timeSeries || [];
  const dimensionFiltered = Boolean(activeLocation || activeAdvisor || activeTechnician);
  const displayedTrend = dimensionFiltered ? [] : trend;
  const maxTrend = Math.max(...displayedTrend.map(row => row.metrics.attributedRevenue ?? 0), 1);
  const displayedLocations = activeLocation ? [activeLocation] : locations;
  const displayedAdvisors = activeAdvisor ? [activeAdvisor] : activeTechnician ? [] : visibleAdvisors;
  const displayedTechnicians = activeTechnician ? [activeTechnician] : activeAdvisor ? [] : visibleTechnicians;
  const canEnterprise = Boolean(me?.enterpriseId && (me?.role === "owner" || me?.role === "admin")); const canPlatform = Boolean(me?.isPlatformAdmin || me?.platformAdmin);
  const compatibleQuery = new URLSearchParams({ days: String(period === "custom" ? 30 : daysFor(period)) });
  const canManage = Boolean(me?.isPlatformAdmin || me?.platformAdmin || me?.role === "owner" || me?.role === "admin");
  const priorFor = (metric: keyof Metrics) => {
    const dimension = activeLocation ? prior?.byLocation : activeAdvisor ? prior?.byAdvisor : activeTechnician ? prior?.byTechnician : null;
    return dimension?.find(item => item.key === (activeLocation || activeAdvisor || activeTechnician)?.key)?.metrics?.[metric] ?? (dimension ? null : prior?.summary?.[metric]);
  };

  const exportCsv = async () => {
    const params = new URLSearchParams({ ...dates(period, start, end), scope });
    if (scope === "shop" && reportShopId) params.set("shopId", String(reportShopId)); if (scope === "enterprise" && reportEnterpriseId) params.set("enterpriseId", reportEnterpriseId);
    if (locationId !== "all") params.set("locationId", locationId); if (advisor !== "all") params.set("advisor", advisor); if (technician !== "all") params.set("technician", technician);
    try { const response = await fetch(`/api/reports/export?${params}`, { credentials: "include" }); if (!response.ok) throw new Error("Export could not be prepared."); const blob = await response.blob(); const href = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = href; a.download = "mos-report.csv"; a.click(); URL.revokeObjectURL(href); } catch (cause) { setError(cause instanceof Error ? cause.message : "Export could not be prepared."); }
  };
  const openSchedule = (subscription?: Subscription) => { setEditing(subscription || null); setRecipientEmail(subscription?.recipientEmail || me?.email || ""); setCadence(subscription?.cadence || "weekly"); setScheduleMessage(null); setScheduleOpen(true); };
  const saveSchedule = async () => {
    if (!recipientEmail) { setScheduleMessage("A recipient email is required."); return; }
    const filters = { locationId: locationId === "all" ? undefined : Number(locationId), advisorKey: advisor === "all" ? undefined : advisor, technicianKey: technician === "all" ? undefined : technician };
    const payload = { recipientEmail, cadence, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, sendHour: 8, dayOfWeek: cadence === "weekly" ? 1 : undefined, dayOfMonth: cadence === "monthly" ? 1 : undefined, scope: { kind: scope, shopId: scope === "shop" ? reportShopId : undefined, enterpriseId: scope === "enterprise" ? reportEnterpriseId : undefined }, filters };
    try { const response = await fetch(editing ? `/api/reports/subscriptions/${editing._id}` : "/api/reports/subscriptions", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(editing ? { ...editing, ...payload, _id: undefined } : payload) }); if (!response.ok) throw new Error(); setScheduleMessage("Delivery saved."); await fetchSubscriptions(); } catch { setScheduleMessage("Delivery could not be saved. Try again."); }
  };
  const manageSubscription = async (subscription: Subscription, action: "pause" | "resume" | "delete") => {
    try { const response = await fetch(`/api/reports/subscriptions/${subscription._id}`, { method: action === "delete" ? "DELETE" : "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include", body: action === "delete" ? undefined : JSON.stringify({ ...subscription, _id: undefined, paused: action === "pause", filters: subscription.filters }) }); if (!response.ok) throw new Error(); await fetchSubscriptions(); } catch { setError("Delivery status could not be changed."); }
  };

  return <main className="min-h-[100dvh] bg-[#f4f7fa] p-4 text-slate-900 sm:p-6 lg:p-8"><div className="mx-auto max-w-[1600px] space-y-5">
    <header className="border-b border-slate-200 pb-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.18em] text-[#2f6fae]"><span className="h-2 w-2 bg-[#f0aa30]" />Operations intelligence</div><h1 className="text-3xl font-semibold tracking-[-.04em] text-slate-950">Performance reporting</h1><p className="mt-1 text-sm text-slate-600">Total shop results and MOS attribution, read side by side.</p></div><div className="flex flex-wrap gap-2"><button onClick={() => void load(true)} disabled={refreshing} className="action secondary"><RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />Refresh</button><button onClick={() => void exportCsv()} className="action secondary"><Download className="h-4 w-4" />Export</button>{canManage && <button onClick={() => openSchedule()} className="action primary"><CalendarDays className="h-4 w-4" />Schedule</button>}</div></div>
      <div className="mt-5 flex flex-wrap items-center gap-2"><div className="inline-flex overflow-hidden rounded-md border border-slate-300 bg-white">{(["7d", "30d", "90d"] as Period[]).map(key => <button key={key} onClick={() => setPeriod(key)} className={`px-3 py-1.5 text-xs font-bold ${period === key ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{key}</button>)}<button onClick={() => setPeriod("custom")} className={`px-3 py-1.5 text-xs font-bold ${period === "custom" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}>CUSTOM</button></div>{period === "custom" && <><input type="date" value={start} onChange={e => setStart(e.target.value)} className="filter" /><input type="date" value={end} onChange={e => setEnd(e.target.value)} className="filter" /></>}<select value={scope} onChange={e => setScope(e.target.value as ScopeKind)} className="filter"><option value="shop">This location</option>{canEnterprise && <option value="enterprise">All locations</option>}{canPlatform && <option value="platform">Platform</option>}</select><select value={locationId} onChange={e => { setLocationId(e.target.value); setAdvisor("all"); setTechnician("all"); }} className="filter"><option value="all">All locations</option>{locations.map(row => <option key={row.key} value={row.key}>{row.label || `Unknown location (${row.key})`}</option>)}</select><select value={advisor} onChange={e => { setAdvisor(e.target.value); setTechnician("all"); }} className="filter"><option value="all">All advisors</option>{visibleAdvisors.map(row => <option key={row.key} value={row.key}>{row.label || `Unknown advisor (${row.key})`}</option>)}</select><select value={technician} onChange={e => { setTechnician(e.target.value); setAdvisor("all"); }} className="filter"><option value="all">All technicians</option>{visibleTechnicians.map(row => <option key={row.key} value={row.key}>{row.label || `Unknown technician (${row.key})`}</option>)}</select></div></header>
    {error && <Banner tone="rose" title={error} action={<button onClick={() => void load()} className="font-bold underline">Retry</button>} />}{report?.dataQuality?.notes && <Banner tone="blue" title="Data quality note" copy={Array.isArray(report.dataQuality.notes) ? report.dataQuality.notes.join(" ") : report.dataQuality.notes} />}{report?.dataQuality?.dimensionsTruncated && <Banner tone="amber" title="Some comparison groups are truncated" copy="Unknown and unmapped groups remain visible; the provider limited the number of named dimensions returned." />}
    {loading ? <Skeleton /> : report ? <><section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><Kpi label="Total billed revenue" value={fmtMoney(adjustedSummary.billedRevenue)} d={delta(adjustedSummary.billedRevenue, priorFor("billedRevenue"))} detail="All completed repair orders" /><Kpi label="MOS-attributed revenue" value={fmtMoney(adjustedSummary.attributedRevenue)} d={delta(adjustedSummary.attributedRevenue, priorFor("attributedRevenue"))} detail={activeAdvisor || activeTechnician ? "Staff-linked events are not available; use billed results below." : "Sold work linked to MOS"} mos /><Kpi label="Opportunity conversion" value={fmtPercent(adjustedSummary.opportunityConversionRate)} d={delta(adjustedSummary.opportunityConversionRate, priorFor("opportunityConversionRate"))} detail={`${fmtNumber(adjustedSummary.recommendationsSold)} sold / ${fmtNumber(adjustedSummary.recommendationsAdded)} added`} /><Kpi label="Deferred opportunity" value={fmtMoney(adjustedSummary.declinedDeferredDollars)} d={delta(adjustedSummary.declinedDeferredDollars, priorFor("declinedDeferredDollars"))} detail="Declined or deferred recommendations" /></section>
      <section className="grid gap-4 xl:grid-cols-[1.65fr_.7fr]"><section className="panel overflow-hidden"><PanelHead title="MOS revenue momentum" detail="Attributed revenue over the selected period" /><div className="flex h-56 items-end gap-1.5 px-5 pb-8 pt-6">{displayedTrend.length ? displayedTrend.map((item, index) => { const val = item.metrics.attributedRevenue; return <div key={`${item.key}-${index}`} className="group relative flex h-full flex-1 items-end"><div style={{ height: `${val == null ? 2 : Math.max((val / maxTrend) * 100, 3)}%` }} className={`w-full rounded-t-sm transition group-hover:scale-x-110 ${val == null ? "bg-slate-200" : "bg-[#4d91c9] group-hover:bg-[#e9a326]"}`} /><span className="tooltip">{item.label || item.key} · {fmtMoney(val)}</span></div>; }) : <Empty label={dimensionFiltered ? "Daily trend is unavailable for this dimension drill-down. Clear the location or staff filter to inspect the scope-wide trend." : "No time-series data is available."} />}</div></section><Coverage availability={report.availability} quality={report.dataQuality} /></section>
      <section className="grid gap-4 xl:grid-cols-3"><Comparison title="Locations" detail="MOS-attributed revenue" icon={<MapPin className="h-4 w-4" />} rows={displayedLocations} /><Comparison title="Service advisors" detail="Billed revenue and opportunity conversion" icon={<Users className="h-4 w-4" />} rows={displayedAdvisors} conversion /><Comparison title="Technicians" detail="Billed revenue and opportunity conversion" icon={<Wrench className="h-4 w-4" />} rows={displayedTechnicians} conversion /></section>
      {canManage && !subscriptionForbidden && <section className="grid gap-4 lg:grid-cols-[1fr_390px]"><section className="panel"><PanelHead title="Scheduled delivery" detail="Recipients receive the active report scope and filters." action={<button onClick={() => openSchedule()} className="text-xs font-bold text-[#28679f]"><Plus className="mr-1 inline h-3.5 w-3.5" />Add delivery</button>} />{subscriptions.length ? <ul className="divide-y divide-slate-100">{subscriptions.map(item => <li key={item._id} className="flex flex-wrap items-center gap-3 px-5 py-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-800">{item.recipientEmail}</p><p className="text-xs text-slate-500">{item.paused || item.active === false ? "Paused" : `Active · ${item.cadence}`} · last status: {item.lastStatus || "Not sent"} · next: {item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : "Unavailable"}</p>{item.lastError && <p className="text-xs text-rose-700">{item.lastError}</p>}</div><button onClick={() => openSchedule(item)} className="icon" title="Edit delivery"><Pencil className="h-4 w-4" /></button><button onClick={() => void manageSubscription(item, item.paused || item.active === false ? "resume" : "pause")} className="icon" title={item.paused || item.active === false ? "Resume delivery" : "Pause delivery"}>{item.paused || item.active === false ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}</button><button onClick={() => void manageSubscription(item, "delete")} className="icon text-rose-700" title="Delete delivery"><Trash2 className="h-4 w-4" /></button></li>)}</ul> : <Empty label="No scheduled deliveries yet." />}</section>
        <Link href={`/dashboard/reports/missed-opportunities?${compatibleQuery}`} className="group rounded-lg border border-[#efcf8d] bg-[#fff8e8] p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="flex justify-between"><span className="rounded-md bg-[#f4b73e] p-2 text-slate-900"><AlertTriangle className="h-5 w-5" /></span><ChevronRight className="h-5 w-5 text-[#9a6810] group-hover:translate-x-1" /></div><h2 className="mt-5 text-sm font-bold text-[#5e430d]">Missed opportunities</h2><p className="mt-1 text-sm leading-5 text-[#765718]">Inspect closed repair orders, recommendation outcomes, and deferred work in this reporting window.</p><span className="mt-4 inline-flex items-center text-xs font-bold text-[#885c0b]">Open opportunity audit <ChevronRight className="h-3.5 w-3.5" /></span></Link></section>}</> : <Empty label="No report could be loaded for this scope." />}
  </div>{scheduleOpen && <ScheduleDialog email={recipientEmail} setEmail={setRecipientEmail} cadence={cadence} setCadence={setCadence} message={scheduleMessage} onClose={() => setScheduleOpen(false)} onSave={() => void saveSchedule()} editing={Boolean(editing)} />}<style jsx global>{`
    .action { display:inline-flex; align-items:center; gap:.5rem; border-radius:.375rem; padding:.5rem .75rem; font-size:.875rem; font-weight:700; transition:background-color .15s, border-color .15s; }
    .action.secondary { border:1px solid #cbd5e1; background:#fff; color:#334155; box-shadow:0 1px 2px rgb(15 23 42 / .05); } .action.secondary:hover { border-color:#3c81c3; color:#28679f; }
    .action.primary { background:#347bbd; color:#fff; } .action.primary:hover { background:#28679f; }
    .filter { border:1px solid #cbd5e1; border-radius:.375rem; background:#fff; padding:.375rem .625rem; font-size:.75rem; color:#334155; }
    .panel { border:1px solid #e2e8f0; border-radius:.5rem; background:#fff; box-shadow:0 1px 2px rgb(15 23 42 / .05); }
    .icon { border-radius:.375rem; padding:.375rem; color:#64748b; transition:background-color .15s; } .icon:hover { background:#f1f5f9; }
    .tooltip { pointer-events:none; position:absolute; bottom:calc(100% + .5rem); left:50%; z-index:10; display:none; transform:translateX(-50%); white-space:nowrap; border-radius:.25rem; background:#0f172a; padding:.25rem .5rem; font-size:10px; font-weight:700; color:#fff; } .group:hover .tooltip { display:block; }
  `}</style></main>;
}

function Kpi({ label, value, d, detail, mos }: { label: string; value: string; d: number | null; detail: string; mos?: boolean }) { return <article className={`rounded-lg border p-5 shadow-sm ${mos ? "border-[#b7d3e8] bg-[#f0f8fd]" : "border-slate-200 bg-white"}`}><div className="flex justify-between text-[11px] font-bold uppercase tracking-[.13em] text-slate-500"><span>{label}</span>{mos && <span className="h-2 w-2 rounded-full bg-[#e9a326]" />}</div><p className="mt-2 text-3xl font-semibold tracking-[-.04em] text-slate-950">{value}</p><p className="mt-2 text-xs">{d == null ? <span className="text-slate-400">Prior period unavailable</span> : <span className={d >= 0 ? "font-bold text-emerald-700" : "font-bold text-rose-700"}>{d >= 0 ? <ArrowUpRight className="inline h-3.5 w-3.5" /> : <ArrowDownRight className="inline h-3.5 w-3.5" />}{Math.abs(d).toFixed(1)}% vs prior period</span>}</p><p className="mt-3 border-t border-slate-200/70 pt-2 text-xs text-slate-500">{detail}</p></article>; }
function Coverage({ availability, quality }: { availability?: KpiResponse["availability"]; quality?: KpiResponse["dataQuality"] }) {
  const providers = availability ? Object.entries(availability).filter(([, value]) => value != null) : [];
  return <aside className="rounded-lg border border-slate-200 bg-[#203b58] p-5 text-white"><p className="text-[11px] font-bold uppercase tracking-[.15em] text-[#b9d6ed]">Provider coverage</p><h2 className="mt-1 text-base font-semibold">Source availability</h2><div className="mt-5 space-y-2.5">{providers.length ? providers.map(([key, value]) => <div key={key} className="flex items-center justify-between gap-3 text-xs"><span className="capitalize text-[#d4e5f1]">{key.replace(/([A-Z])/g, " $1")}</span><span className="font-semibold text-[#f3c15a]">{value ? "Available" : "Unavailable"}</span></div>) : <p className="text-sm text-[#d4e5f1]">Provider availability unavailable.</p>}</div><div className="mt-5 border-t border-white/15 pt-3 text-xs leading-5 text-[#d4e5f1]">{quality?.unknownAdvisorRepairOrders ? `${quality.unknownAdvisorRepairOrders} repair orders have unknown advisors. ` : ""}{quality?.unknownTechnicianJobs ? `${quality.unknownTechnicianJobs} technician jobs are unmapped.` : "Unknown and unmapped groups remain visible."}</div></aside>;
}
function Comparison({ title, detail, icon, rows, conversion }: { title: string; detail: string; icon: React.ReactNode; rows: DimensionRow[]; conversion?: boolean }) { const ranked = [...rows].sort((a, b) => ((conversion ? b.metrics.billedRevenue : b.metrics.attributedRevenue) ?? -Infinity) - ((conversion ? a.metrics.billedRevenue : a.metrics.attributedRevenue) ?? -Infinity)).slice(0, 5); return <section className="panel overflow-hidden"><PanelHead title={title} detail={detail} action={icon} />{ranked.length ? <ul className="divide-y divide-slate-100">{ranked.map((row, index) => <li key={row.key} className="flex items-center gap-3 px-4 py-3"><span className="w-4 text-xs font-bold text-slate-400">{index + 1}</span><span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{row.label || `Unknown / unmapped (${row.key})`}</span><div className="text-right"><p className="text-sm font-bold text-slate-900">{conversion ? fmtMoney(row.metrics.billedRevenue) : fmtMoney(row.metrics.attributedRevenue)}</p><p className="text-[11px] text-slate-500">{conversion ? `${fmtPercent(row.metrics.opportunityConversionRate)} opportunity conversion` : `${fmtNumber(row.metrics.recommendationsSold)} sold`}</p></div></li>)}</ul> : <Empty label={`No ${title.toLowerCase()} data for this scope.`} />}</section>; }
function PanelHead({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) { return <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="text-sm font-bold text-slate-900">{title}</h2><p className="mt-0.5 text-xs text-slate-500">{detail}</p></div>{action && <span className="text-slate-400">{action}</span>}</div>; }
function Banner({ tone, title, copy, action }: { tone: "rose" | "amber" | "blue"; title: string; copy?: string; action?: React.ReactNode }) { const styles = tone === "rose" ? "border-rose-200 bg-rose-50 text-rose-900" : tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-950" : "border-[#c7dfef] bg-[#edf7fd] text-[#174b78]"; return <div className={`flex items-center justify-between gap-4 rounded-lg border px-4 py-3 text-sm ${styles}`}><span><strong>{title}</strong>{copy ? ` — ${copy}` : ""}</span>{action}</div>; }
function Empty({ label }: { label: string }) { return <div className="flex min-h-32 items-center justify-center p-5 text-center text-sm text-slate-500"><span><FileSpreadsheet className="mx-auto mb-2 h-5 w-5 text-slate-300" />{label}</span></div>; }
function Skeleton() { return <div className="space-y-5 animate-pulse"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{[1, 2, 3, 4].map(i => <div key={i} className="h-44 rounded-lg border border-slate-200 bg-slate-100" />)}</div><div className="grid gap-4 xl:grid-cols-[1.65fr_.7fr]"><div className="h-72 rounded-lg bg-slate-100" /><div className="h-72 rounded-lg bg-slate-100" /></div></div>; }
function ScheduleDialog({ email, setEmail, cadence, setCadence, message, onClose, onSave, editing }: { email: string; setEmail: (v: string) => void; cadence: "weekly" | "monthly"; setCadence: (v: "weekly" | "monthly") => void; message: string | null; onClose: () => void; onSave: () => void; editing: boolean }) { return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4"><div className="w-full max-w-md rounded-xl bg-[#fbfcfd] p-6 shadow-2xl"><div className="flex justify-between"><div><p className="text-[11px] font-bold uppercase tracking-[.16em] text-[#2f6fae]">Report delivery</p><h2 className="mt-1 text-xl font-semibold">{editing ? "Edit scheduled delivery" : "Schedule weekly reporting"}</h2></div><button onClick={onClose} className="icon"><X className="h-5 w-5" /></button></div><label className="mt-5 block text-xs font-bold uppercase tracking-wide text-slate-600">Recipient email<input type="email" value={email} onChange={e => setEmail(e.target.value)} className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" /></label><label className="mt-4 block text-xs font-bold uppercase tracking-wide text-slate-600">Cadence<select value={cadence} onChange={e => setCadence(e.target.value as "weekly" | "monthly")} className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="weekly">Weekly · Monday at 8:00 AM</option><option value="monthly">Monthly · first day at 8:00 AM</option></select></label>{message && <p className="mt-3 text-sm text-[#28679f]">{message}</p>}<div className="mt-6 flex justify-end gap-2"><button onClick={onClose} className="px-3 py-2 text-sm font-semibold text-slate-600">Cancel</button><button onClick={onSave} className="action primary"><Send className="h-4 w-4" />Save delivery</button></div></div></div>; }