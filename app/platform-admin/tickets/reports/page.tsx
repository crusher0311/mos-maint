"use client";

import { useState, useEffect } from "react";
import {
  BarChart3,
  TrendingUp,
  Clock,
  CheckCircle,
  AlertCircle,
  Calendar,
  RefreshCw,
  Download
} from "lucide-react";

interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  closed: number;
  avgResolutionTimeHours: number;
  byCategory: Record<string, number>;
  byPriority: Record<string, number>;
  byDay: { date: string; count: number }[];
  topUsers: { email: string; shopName: string | null; locationIdentifier: string | null; count: number }[];
}

export default function TicketReportsPage() {
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState("30");

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/platform-admin/tickets/reports?days=${dateRange}`);
      const data = await res.json();
      if (data.ok) {
        setStats(data.stats);
      }
    } catch (error) {
      console.error("Error fetching stats:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, [dateRange]);

  const getCategoryLabel = (cat: string) => {
    const labels: Record<string, string> = {
      general: "General",
      billing: "Billing",
      technical: "Technical",
      feature_request: "Feature Request",
      bug: "Bug Report",
      account: "Account"
    };
    return labels[cat] || cat;
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "urgent": return "bg-red-500";
      case "high": return "bg-orange-500";
      case "medium": return "bg-yellow-500";
      case "low": return "bg-green-500";
      default: return "bg-gray-500";
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-24 bg-gray-200 rounded-lg"></div>
            ))}
          </div>
          <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <BarChart3 className="w-7 h-7 text-[#3c81c3]" />
            Support Ticket Reports
          </h1>
          <p className="text-gray-600">Analytics and insights for support tickets</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3c81c3]"
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
          </select>
          <button
            onClick={fetchStats}
            className="flex items-center gap-2 px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {stats && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-1">
                <BarChart3 className="w-4 h-4 text-[#3c81c3]" />
                <span className="text-sm text-gray-600">Total Tickets</span>
              </div>
              <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="w-4 h-4 text-blue-500" />
                <span className="text-sm text-gray-600">Open</span>
              </div>
              <div className="text-2xl font-bold text-gray-900">{stats.open}</div>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="w-4 h-4 text-yellow-500" />
                <span className="text-sm text-gray-600">In Progress</span>
              </div>
              <div className="text-2xl font-bold text-gray-900">{stats.inProgress}</div>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle className="w-4 h-4 text-green-500" />
                <span className="text-sm text-gray-600">Resolved</span>
              </div>
              <div className="text-2xl font-bold text-gray-900">{stats.resolved + stats.closed}</div>
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-[#3c81c3]" />
                <span className="text-sm text-gray-600">Avg Resolution</span>
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {stats.avgResolutionTimeHours > 0 
                  ? `${Math.round(stats.avgResolutionTimeHours)}h` 
                  : "N/A"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
              <h3 className="font-semibold text-gray-900 mb-4">Tickets by Category</h3>
              <div className="space-y-3">
                {Object.entries(stats.byCategory).map(([category, count]) => (
                  <div key={category} className="flex items-center gap-3">
                    <div className="w-24 text-sm text-gray-600">{getCategoryLabel(category)}</div>
                    <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                      <div
                        className="bg-[rgba(60,129,195,0.1)]0 h-full rounded-full"
                        style={{ width: `${(count / stats.total) * 100}%` }}
                      />
                    </div>
                    <div className="w-12 text-right text-sm font-medium text-gray-900">{count}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
              <h3 className="font-semibold text-gray-900 mb-4">Tickets by Priority</h3>
              <div className="space-y-3">
                {Object.entries(stats.byPriority).map(([priority, count]) => (
                  <div key={priority} className="flex items-center gap-3">
                    <div className="w-24 text-sm text-gray-600 capitalize">{priority}</div>
                    <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                      <div
                        className={`${getPriorityColor(priority)} h-full rounded-full`}
                        style={{ width: `${(count / stats.total) * 100}%` }}
                      />
                    </div>
                    <div className="w-12 text-right text-sm font-medium text-gray-900">{count}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
            <h3 className="font-semibold text-gray-900 mb-4">Tickets Over Time</h3>
            <div className="h-48 flex items-end gap-1">
              {stats.byDay.map((day, i) => {
                const maxCount = Math.max(...stats.byDay.map(d => d.count), 1);
                const height = (day.count / maxCount) * 100;
                return (
                  <div
                    key={day.date}
                    className="flex-1 flex flex-col items-center group"
                  >
                    <div
                      className="w-full bg-[rgba(60,129,195,0.1)]0 rounded-t transition-all hover:bg-[rgba(60,129,195,0.75)]"
                      style={{ height: `${Math.max(height, 2)}%` }}
                      title={`${day.date}: ${day.count} tickets`}
                    />
                    {i % Math.ceil(stats.byDay.length / 7) === 0 && (
                      <span className="text-xs text-gray-400 mt-1 whitespace-nowrap">
                        {new Date(day.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
            <h3 className="font-semibold text-gray-900 mb-4">Top Ticket Submitters</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="pb-2 font-medium">User</th>
                    <th className="pb-2 font-medium">Shop</th>
                    <th className="pb-2 font-medium text-right">Tickets</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.topUsers.map((user, i) => (
                    <tr key={user.email} className="border-b border-gray-50">
                      <td className="py-3 text-gray-900">{user.email}</td>
                      <td className="py-3 text-gray-600">
                        {user.shopName 
                          ? (user.locationIdentifier ? `${user.shopName} (${user.locationIdentifier})` : user.shopName)
                          : "N/A"}
                      </td>
                      <td className="py-3 text-right font-medium text-gray-900">{user.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
