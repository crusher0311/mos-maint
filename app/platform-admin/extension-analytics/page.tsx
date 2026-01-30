"use client";

import { useState, useEffect } from "react";
import { BarChart3, TrendingUp, Users, Building2, Calendar, Search, Loader2 } from "lucide-react";

type Stats = {
  totalPushes: number;
  bySource: Record<string, number>;
  byDay: Array<{ date: string; count: number }>;
  topJobs: Array<{ jobTitle: string; count: number }>;
};

type RecentEvent = {
  shopId: number;
  userId?: string;
  jobTitle: string;
  jobSource: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  timestamp: string;
};

type ShopLookup = Record<number, string>;

export default function ExtensionAnalyticsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentEvents, setRecentEvents] = useState<RecentEvent[]>([]);
  const [shopNames, setShopNames] = useState<ShopLookup>({});
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [shopFilter, setShopFilter] = useState("");

  useEffect(() => {
    fetchData();
  }, [days]);

  async function fetchData() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days: String(days) });
      const res = await fetch(`/api/admin/extension-analytics?${params}`);
      const data = await res.json();
      setStats(data.stats);
      setRecentEvents(data.recentEvents || []);

      const shopIds = [...new Set(data.recentEvents?.map((e: RecentEvent) => e.shopId) || [])];
      if (shopIds.length > 0) {
        const shopsRes = await fetch("/api/platform-admin/shops/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shopIds }),
        });
        if (shopsRes.ok) {
          const shopsData = await shopsRes.json();
          setShopNames(shopsData.shops || {});
        }
      }
    } catch (error) {
      console.error("Failed to fetch analytics:", error);
    } finally {
      setLoading(false);
    }
  }

  const sourceLabels: Record<string, string> = {
    plan: "Maintenance Plan",
    lookup: "Job History",
    failures: "Common Failures",
    canned: "Canned Jobs",
    autocomplete: "Autocomplete",
  };

  const sourceColors: Record<string, string> = {
    plan: "bg-blue-500",
    lookup: "bg-green-500",
    failures: "bg-orange-500",
    canned: "bg-purple-500",
    autocomplete: "bg-pink-500",
  };

  const filteredEvents = recentEvents.filter((e) => {
    if (!shopFilter) return true;
    const shopName = shopNames[e.shopId] || "";
    return (
      shopName.toLowerCase().includes(shopFilter.toLowerCase()) ||
      String(e.shopId).includes(shopFilter) ||
      e.userId?.toLowerCase().includes(shopFilter.toLowerCase())
    );
  });

  const maxDayCount = Math.max(...(stats?.byDay?.map((d) => d.count) || [1]));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Extension Analytics</h1>
          <p className="text-gray-500 mt-1">Track "Add to RO" usage across all shops</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <TrendingUp className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Total Pushes</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {stats?.totalPushes?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <BarChart3 className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">From Maint. Plan</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {stats?.bySource?.plan?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <Users className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">From History</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {stats?.bySource?.lookup?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-orange-100 rounded-lg">
                  <Building2 className="w-5 h-5 text-orange-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">From Canned Jobs</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {stats?.bySource?.canned?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">By Source</h2>
              <div className="space-y-3">
                {Object.entries(stats?.bySource || {}).map(([source, count]) => {
                  const total = stats?.totalPushes || 1;
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div key={source}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-gray-700">
                          {sourceLabels[source] || source}
                        </span>
                        <span className="text-sm font-medium text-gray-900">
                          {count.toLocaleString()} ({pct}%)
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${sourceColors[source] || "bg-gray-500"} rounded-full`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Daily Activity</h2>
              <div className="flex items-end gap-1 h-40">
                {(stats?.byDay || []).slice(0, 14).reverse().map((day) => (
                  <div key={day.date} className="flex-1 flex flex-col items-center">
                    <div
                      className="w-full bg-blue-500 rounded-t"
                      style={{ height: `${(day.count / maxDayCount) * 100}%`, minHeight: day.count > 0 ? "4px" : "0" }}
                      title={`${day.date}: ${day.count}`}
                    />
                    <span className="text-[10px] text-gray-400 mt-1 rotate-[-45deg] origin-top-left">
                      {day.date.slice(5)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Jobs Added</h2>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {(stats?.topJobs || []).map((job, idx) => (
                  <div key={job.jobTitle} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-xs font-medium flex items-center justify-center">
                        {idx + 1}
                      </span>
                      <span className="text-sm text-gray-800 truncate max-w-[200px]">{job.jobTitle}</span>
                    </div>
                    <span className="text-sm font-medium text-gray-600">{job.count}</span>
                  </div>
                ))}
                {(stats?.topJobs?.length || 0) === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">No data yet</p>
                )}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">Recent Activity</h2>
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Filter by shop or user..."
                    value={shopFilter}
                    onChange={(e) => setShopFilter(e.target.value)}
                    className="pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 w-48"
                  />
                </div>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {filteredEvents.slice(0, 20).map((event, idx) => (
                  <div key={idx} className="flex items-start justify-between py-2 border-b border-gray-100 last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{event.jobTitle}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${sourceColors[event.jobSource] || "bg-gray-500"} text-white`}>
                          {sourceLabels[event.jobSource] || event.jobSource}
                        </span>
                        <span className="text-xs text-gray-500">
                          {shopNames[event.shopId] || `Shop ${event.shopId}`}
                        </span>
                      </div>
                      {event.vehicleYear && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {event.vehicleYear} {event.vehicleMake} {event.vehicleModel}
                        </p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0 ml-2">
                      <p className="text-xs text-gray-400">
                        {new Date(event.timestamp).toLocaleDateString()}
                      </p>
                      <p className="text-[10px] text-gray-400">
                        {new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                ))}
                {filteredEvents.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">No activity found</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
