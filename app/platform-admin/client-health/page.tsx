"use client";

import { useState, useEffect } from "react";
import {
  HeartPulse,
  AlertTriangle,
  CheckCircle2,
  Eye,
  ArrowUpDown,
  Ticket,
  Search,
  Filter,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface OpenTicket {
  ticketNumber: string;
  subject: string;
  priority: string;
  status: string;
  createdAt: string;
}

interface ClientHealth {
  shopId: number;
  name: string;
  score: number;
  risk: "healthy" | "monitor" | "at-risk" | "critical";
  signals: {
    billing: number;
    integration: number;
    activity: number;
    adoption: number;
    support: number;
  };
  hasOpenTickets: boolean;
  openTicketCount: number;
  openTickets: OpenTicket[];
  billing: { plan: string; status: string };
  integrations: string[];
  userCount: number;
  vehicleCount: number;
  vinViewCount: number;
  stickerCount: number;
  lastActivity: string | null;
  createdAt: string;
}

interface Summary {
  totalShops: number;
  avgScore: number;
  healthy: number;
  monitor: number;
  atRisk: number;
  critical: number;
  withOpenTickets: number;
  totalOpenTickets: number;
}

type SortField = "score" | "name" | "lastActivity" | "openTicketCount";
type SortDir = "asc" | "desc";
type RiskFilter = "all" | "healthy" | "monitor" | "at-risk" | "critical";

const riskConfig = {
  healthy: { label: "Healthy", color: "bg-emerald-500", textColor: "text-emerald-700", bgLight: "bg-emerald-50", border: "border-emerald-200" },
  monitor: { label: "Monitor", color: "bg-amber-500", textColor: "text-amber-700", bgLight: "bg-amber-50", border: "border-amber-200" },
  "at-risk": { label: "At Risk", color: "bg-orange-500", textColor: "text-orange-700", bgLight: "bg-orange-50", border: "border-orange-200" },
  critical: { label: "Critical", color: "bg-red-500", textColor: "text-red-700", bgLight: "bg-red-50", border: "border-red-200" },
};

const priorityColors: Record<string, string> = {
  urgent: "bg-red-100 text-red-700",
  high: "bg-orange-100 text-orange-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-slate-100 text-slate-600",
};

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function ScoreBar({ value, label }: { value: number; label: string }) {
  const color = value >= 75 ? "bg-emerald-500" : value >= 50 ? "bg-amber-500" : value >= 25 ? "bg-orange-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-slate-500 text-right">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 text-slate-600 font-medium">{value}</span>
    </div>
  );
}

function ScoreBadge({ score, risk }: { score: number; risk: string }) {
  const config = riskConfig[risk as keyof typeof riskConfig] || riskConfig.monitor;
  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ${config.bgLight} ${config.border} border`}>
      <div className={`w-2 h-2 rounded-full ${config.color}`} />
      <span className={`text-sm font-bold ${config.textColor}`}>{score}</span>
    </div>
  );
}

export default function ClientHealthPage() {
  const [data, setData] = useState<{ summary: Summary; clients: ClientHealth[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [ticketFilter, setTicketFilter] = useState(false);
  const [sortField, setSortField] = useState<SortField>("score");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [expandedShop, setExpandedShop] = useState<number | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/platform-admin/client-health");
      const json = await res.json();
      if (json.ok) {
        setData(json);
      } else {
        setError(json.error || "Failed to load health data");
      }
    } catch (err: any) {
      setError(err.message || "Network error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "score" ? "asc" : "desc");
    }
  };

  const filtered = data?.clients
    .filter(c => {
      if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !String(c.shopId).includes(search)) return false;
      if (riskFilter !== "all" && c.risk !== riskFilter) return false;
      if (ticketFilter && !c.hasOpenTickets) return false;
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "score": cmp = a.score - b.score; break;
        case "name": cmp = a.name.localeCompare(b.name); break;
        case "lastActivity":
          const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
          const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
          cmp = aTime - bTime;
          break;
        case "openTicketCount": cmp = a.openTicketCount - b.openTicketCount; break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    }) || [];

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <HeartPulse className="w-7 h-7 text-blue-600" />
            Client Health Dashboard
          </h1>
          <p className="text-slate-500 mt-1">Monitor the health and engagement of all shop clients</p>
        </div>
        <button onClick={fetchData} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {data?.summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Avg Score</p>
            <p className="text-3xl font-bold text-slate-800 mt-1">{data.summary.avgScore}</p>
          </div>
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
            <p className="text-xs font-medium text-emerald-600 uppercase tracking-wide">Healthy</p>
            <p className="text-3xl font-bold text-emerald-700 mt-1">{data.summary.healthy}</p>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <p className="text-xs font-medium text-amber-600 uppercase tracking-wide">Monitor</p>
            <p className="text-3xl font-bold text-amber-700 mt-1">{data.summary.monitor}</p>
          </div>
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
            <p className="text-xs font-medium text-orange-600 uppercase tracking-wide">At Risk</p>
            <p className="text-3xl font-bold text-orange-700 mt-1">{data.summary.atRisk}</p>
          </div>
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-xs font-medium text-red-600 uppercase tracking-wide">Critical</p>
            <p className="text-3xl font-bold text-red-700 mt-1">{data.summary.critical}</p>
          </div>
          <div className={`border rounded-xl p-4 ${data.summary.withOpenTickets > 0 ? "bg-red-50 border-red-200" : "bg-white border-slate-200"}`}>
            <p className={`text-xs font-medium uppercase tracking-wide ${data.summary.withOpenTickets > 0 ? "text-red-600" : "text-slate-500"}`}>Open Tickets</p>
            <p className={`text-3xl font-bold mt-1 ${data.summary.withOpenTickets > 0 ? "text-red-700" : "text-slate-800"}`}>{data.summary.totalOpenTickets}</p>
            {data.summary.withOpenTickets > 0 && (
              <p className="text-xs text-red-500 mt-0.5">{data.summary.withOpenTickets} shops affected</p>
            )}
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl">
        <div className="p-4 border-b border-slate-200 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search shops..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="flex items-center gap-1">
            <Filter className="w-4 h-4 text-slate-400" />
            {(["all", "critical", "at-risk", "monitor", "healthy"] as RiskFilter[]).map(r => (
              <button
                key={r}
                onClick={() => setRiskFilter(r)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  riskFilter === r
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {r === "all" ? "All" : r === "at-risk" ? "At Risk" : r.charAt(0).toUpperCase() + r.slice(1)}
              </button>
            ))}
          </div>

          <button
            onClick={() => setTicketFilter(!ticketFilter)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              ticketFilter
                ? "bg-red-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            <Ticket className="w-3.5 h-3.5" />
            Has Tickets
          </button>

          <span className="text-xs text-slate-400">{filtered.length} shops</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide w-10"></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide cursor-pointer hover:text-slate-700" onClick={() => toggleSort("score")}>
                  <span className="flex items-center gap-1">Score <ArrowUpDown className="w-3 h-3" /></span>
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide cursor-pointer hover:text-slate-700" onClick={() => toggleSort("name")}>
                  <span className="flex items-center gap-1">Shop <ArrowUpDown className="w-3 h-3" /></span>
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Billing</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Integrations</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide cursor-pointer hover:text-slate-700" onClick={() => toggleSort("lastActivity")}>
                  <span className="flex items-center gap-1">Last Active <ArrowUpDown className="w-3 h-3" /></span>
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide cursor-pointer hover:text-slate-700" onClick={() => toggleSort("openTicketCount")}>
                  <span className="flex items-center gap-1">Tickets <ArrowUpDown className="w-3 h-3" /></span>
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Signals</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && !data ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-400">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Loading health data...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-400">
                    No shops match your filters
                  </td>
                </tr>
              ) : (
                filtered.map((client) => {
                  const isExpanded = expandedShop === client.shopId;
                  const rc = riskConfig[client.risk];
                  return (
                    <tr key={client.shopId} className={`hover:bg-slate-50 transition-colors ${client.risk === "critical" ? "bg-red-50/30" : ""}`}>
                      <td className="px-4 py-3">
                        <button onClick={() => setExpandedShop(isExpanded ? null : client.shopId)} className="text-slate-400 hover:text-slate-600">
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <ScoreBadge score={client.score} risk={client.risk} />
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          <div className="font-medium text-slate-800">{client.name}</div>
                          <div className="text-xs text-slate-400">ID: {client.shopId} &middot; {client.userCount} users &middot; {client.vehicleCount} vehicles</div>
                        </div>
                        {isExpanded && (
                          <div className="mt-3 p-3 bg-slate-50 rounded-lg space-y-2">
                            <ScoreBar value={client.signals.billing} label="Billing" />
                            <ScoreBar value={client.signals.integration} label="Integr." />
                            <ScoreBar value={client.signals.activity} label="Activity" />
                            <ScoreBar value={client.signals.adoption} label="Adoption" />
                            <ScoreBar value={client.signals.support} label="Support" />
                            <div className="pt-2 border-t border-slate-200 flex gap-4 text-xs text-slate-500">
                              <span>VIN Views: {client.vinViewCount}</span>
                              <span>Stickers: {client.stickerCount}</span>
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          client.billing.status === "active" || client.billing.status === "enterprise"
                            ? "bg-emerald-100 text-emerald-700"
                            : client.billing.status === "trial" || client.billing.status === "demo"
                            ? "bg-blue-100 text-blue-700"
                            : client.billing.status === "past_due"
                            ? "bg-amber-100 text-amber-700"
                            : client.billing.status === "suspended" || client.billing.status === "canceled"
                            ? "bg-red-100 text-red-700"
                            : "bg-slate-100 text-slate-600"
                        }`}>
                          {client.billing.plan}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {client.integrations.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {client.integrations.map(i => (
                              <span key={i} className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-xs">{i}</span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-red-400 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> None
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-sm ${
                          !client.lastActivity ? "text-red-400" :
                          (Date.now() - new Date(client.lastActivity).getTime()) > 7 * 24 * 60 * 60 * 1000 ? "text-amber-500" :
                          "text-slate-600"
                        }`}>
                          {timeAgo(client.lastActivity)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {client.hasOpenTickets ? (
                          <div>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs font-medium">
                              <Ticket className="w-3 h-3" />
                              {client.openTicketCount} open
                            </span>
                            {isExpanded && client.openTickets.length > 0 && (
                              <div className="mt-2 space-y-1">
                                {client.openTickets.map((t, i) => (
                                  <div key={i} className="flex items-center gap-2 text-xs">
                                    <span className={`px-1.5 py-0.5 rounded ${priorityColors[t.priority] || "bg-slate-100 text-slate-600"}`}>
                                      {t.priority}
                                    </span>
                                    <span className="text-slate-600 truncate max-w-[150px]">{t.subject}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-emerald-500 flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" /> Clear
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-0.5">
                          {[
                            { val: client.signals.billing, label: "B" },
                            { val: client.signals.integration, label: "I" },
                            { val: client.signals.activity, label: "A" },
                            { val: client.signals.adoption, label: "D" },
                            { val: client.signals.support, label: "S" },
                          ].map((s, i) => (
                            <div
                              key={i}
                              title={`${s.label}: ${s.val}`}
                              className={`w-2.5 h-8 rounded-sm ${
                                s.val >= 75 ? "bg-emerald-400" : s.val >= 50 ? "bg-amber-400" : s.val >= 25 ? "bg-orange-400" : "bg-red-400"
                              }`}
                              style={{ opacity: 0.5 + (s.val / 200) }}
                            />
                          ))}
                        </div>
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
