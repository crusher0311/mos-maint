"use client";

import { useState, useEffect } from "react";
import { DollarSign, Zap, Building2, Calendar, RefreshCw, Eye, Car } from "lucide-react";

interface UsageAnalytics {
  totals: {
    requestCount: number;
    totalTokens: number;
    totalCost: number;
    uniqueVinsProcessed: number;
    totalViews: number;
    costPerVin: number;
    costPerView: number;
  };
  byShop: Array<{
    shopId: string;
    shopName: string;
    requestCount: number;
    totalTokens: number;
    totalCost: number;
    uniqueVins: number;
  }>;
  byModel: Array<{
    _id: string;
    requestCount: number;
    totalCost: number;
  }>;
  byDay: Array<{
    _id: string;
    requestCount: number;
    totalCost: number;
  }>;
}

export default function PlatformUsagePage() {
  const [analytics, setAnalytics] = useState<UsageAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<"7d" | "30d" | "90d" | "all">("30d");

  useEffect(() => {
    loadAnalytics();
  }, [dateRange]);

  const loadAnalytics = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      
      if (dateRange !== "all") {
        const days = dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : 90;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        params.set("startDate", startDate.toISOString());
      }
      
      const res = await fetch(`/api/platform-admin/usage?${params}`);
      const data = await res.json();
      if (data.ok) {
        setAnalytics(data);
      }
    } catch (err) {
      console.error("Error loading usage:", err);
    } finally {
      setLoading(false);
    }
  };

  const formatCost = (cost: number) => {
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
    return tokens.toString();
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-32 bg-gray-200 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Usage & Costs</h1>
          <p className="text-gray-600">Track OpenAI API usage across all clients</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as any)}
            className="border border-gray-300 rounded-lg px-3 py-2 bg-white text-sm"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="all">All time</option>
          </select>
          <button
            onClick={loadAnalytics}
            className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-green-100 rounded-lg">
              <DollarSign className="w-5 h-5 text-green-600" />
            </div>
            <span className="text-sm text-gray-600">Total Cost</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {formatCost(analytics?.totals?.totalCost || 0)}
          </div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Zap className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-gray-600">API Requests</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {analytics?.totals?.requestCount?.toLocaleString() || 0}
          </div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-purple-100 rounded-lg">
              <Calendar className="w-5 h-5 text-purple-600" />
            </div>
            <span className="text-sm text-gray-600">Total Tokens</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {formatTokens(analytics?.totals?.totalTokens || 0)}
          </div>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-orange-100 rounded-lg">
              <Building2 className="w-5 h-5 text-orange-600" />
            </div>
            <span className="text-sm text-gray-600">Active Shops</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {analytics?.byShop?.length || 0}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-indigo-50 to-white rounded-xl p-6 border border-indigo-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <Car className="w-5 h-5 text-indigo-600" />
            </div>
            <span className="text-sm text-indigo-700 font-medium">VINs Processed</span>
          </div>
          <div className="text-2xl font-bold text-indigo-900">
            {analytics?.totals?.uniqueVinsProcessed?.toLocaleString() || 0}
          </div>
          <p className="text-xs text-indigo-600 mt-1">Unique vehicles analyzed</p>
        </div>

        <div className="bg-gradient-to-br from-indigo-50 to-white rounded-xl p-6 border border-indigo-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <Eye className="w-5 h-5 text-indigo-600" />
            </div>
            <span className="text-sm text-indigo-700 font-medium">Plans Viewed</span>
          </div>
          <div className="text-2xl font-bold text-indigo-900">
            {analytics?.totals?.totalViews?.toLocaleString() || 0}
          </div>
          <p className="text-xs text-indigo-600 mt-1">Clicked "View" button</p>
        </div>

        <div className="bg-gradient-to-br from-green-50 to-white rounded-xl p-6 border border-green-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-green-100 rounded-lg">
              <DollarSign className="w-5 h-5 text-green-600" />
            </div>
            <span className="text-sm text-green-700 font-medium">Cost per VIN</span>
          </div>
          <div className="text-2xl font-bold text-green-700">
            {formatCost(analytics?.totals?.costPerVin || 0)}
          </div>
          <p className="text-xs text-green-600 mt-1">Total cost / VINs processed</p>
        </div>

        <div className="bg-gradient-to-br from-green-50 to-white rounded-xl p-6 border border-green-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-green-100 rounded-lg">
              <DollarSign className="w-5 h-5 text-green-600" />
            </div>
            <span className="text-sm text-green-700 font-medium">Cost per View</span>
          </div>
          <div className="text-2xl font-bold text-green-700">
            {formatCost(analytics?.totals?.costPerView || 0)}
          </div>
          <p className="text-xs text-green-600 mt-1">Total cost / plans viewed</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Usage by Shop</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Shop</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Requests</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">VINs</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Tokens</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {analytics?.byShop?.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                      No usage data yet
                    </td>
                  </tr>
                ) : (
                  analytics?.byShop?.map((shop) => (
                    <tr key={shop.shopId} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{shop.shopName}</div>
                        <div className="text-xs text-gray-500">ID: {shop.shopId}</div>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-900">
                        {shop.requestCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-900">
                        {shop.uniqueVins}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {formatTokens(shop.totalTokens)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {formatCost(shop.totalCost)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="p-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">Usage by Model</h2>
            </div>
            <div className="p-4 space-y-3">
              {analytics?.byModel?.length === 0 ? (
                <p className="text-gray-500 text-sm">No usage data yet</p>
              ) : (
                analytics?.byModel?.map((model) => (
                  <div key={model._id} className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-gray-900">{model._id}</div>
                      <div className="text-xs text-gray-500">
                        {model.requestCount.toLocaleString()} requests
                      </div>
                    </div>
                    <div className="font-medium text-gray-900">
                      {formatCost(model.totalCost)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="p-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">Daily Activity</h2>
            </div>
            <div className="p-4 space-y-2 max-h-64 overflow-y-auto">
              {analytics?.byDay?.length === 0 ? (
                <p className="text-gray-500 text-sm">No usage data yet</p>
              ) : (
                analytics?.byDay?.slice(-14).map((day) => (
                  <div key={day._id} className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">{day._id}</span>
                    <div className="flex items-center gap-4">
                      <span className="text-gray-500">{day.requestCount} req</span>
                      <span className="font-medium text-gray-900">{formatCost(day.totalCost)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-purple-50 border border-purple-100 rounded-xl p-4">
        <h3 className="font-medium text-purple-900 mb-2">Cost Estimation Notes</h3>
        <ul className="text-sm text-purple-800 space-y-1">
          <li>Costs are estimates based on OpenAI published pricing</li>
          <li>GPT-4o-mini: $0.15/1M input, $0.60/1M output tokens</li>
          <li>GPT-4o: $5/1M input, $15/1M output tokens</li>
        </ul>
      </div>
    </div>
  );
}
