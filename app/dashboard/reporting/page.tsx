"use client";

import { useState, useEffect } from "react";
import { 
  TrendingUp, 
  DollarSign, 
  Package, 
  Target, 
  Eye,
  Cpu,
  RefreshCw,
  BarChart3
} from "lucide-react";

interface ShopAnalytics {
  summary: {
    jobsAdded: number;
    jobsSold: number;
    totalRevenue: number;
    laborRevenue: number;
    partsRevenue: number;
    conversionRate: number;
    plansViewed: number;
    aiCost: number;
    aiRequests: number;
    uniqueVinsProcessed: number;
    costPerVin: number;
    costPerView: number;
  };
  byRecommendationType: Array<{
    type: string;
    added: number;
    sold: number;
    revenue: number;
    conversionRate: number;
  }>;
  daily: Array<{
    date: string;
    added: number;
    sold: number;
    revenue: number;
  }>;
}

export default function ReportingPage() {
  const [analytics, setAnalytics] = useState<ShopAnalytics | null>(null);
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
      
      const res = await fetch(`/api/shop/analytics?${params}`);
      const data = await res.json();
      if (data.ok) {
        setAnalytics(data);
      }
    } catch (err) {
      console.error("Error loading analytics:", err);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount: number) => {
    if (amount < 0.01) return `$${amount.toFixed(4)}`;
    if (amount < 1) return `$${amount.toFixed(3)}`;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  const formatCost = (cost: number) => {
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
  };

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      oem: "OEM Schedule",
      dvi: "DVI Findings",
      carfax: "CARFAX History",
      shop: "Shop Custom",
      protractor: "Protractor"
    };
    return labels[type] || type;
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
          <h1 className="text-2xl font-bold text-gray-900">Reporting</h1>
          <p className="text-gray-600">Track MOS performance and ROI</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-1">
            {(["7d", "30d", "90d", "all"] as const).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  dateRange === range
                    ? "bg-blue-600 text-white"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {range === "7d" ? "7D" : range === "30d" ? "30D" : range === "90d" ? "90D" : "All"}
              </button>
            ))}
          </div>
          <button
            onClick={loadAnalytics}
            className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Package className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-gray-600">Jobs Added</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {analytics?.summary?.jobsAdded?.toLocaleString() || 0}
          </div>
          <p className="text-xs text-gray-500 mt-1">MOS recommendations added to ROs</p>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-green-100 rounded-lg">
              <TrendingUp className="w-5 h-5 text-green-600" />
            </div>
            <span className="text-sm text-gray-600">Jobs Sold</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {analytics?.summary?.jobsSold?.toLocaleString() || 0}
          </div>
          <p className="text-xs text-gray-500 mt-1">{analytics?.summary?.conversionRate || 0}% conversion rate</p>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-yellow-100 rounded-lg">
              <DollarSign className="w-5 h-5 text-yellow-600" />
            </div>
            <span className="text-sm text-gray-600">Revenue from MOS</span>
          </div>
          <div className="text-2xl font-bold text-green-600">
            {formatCurrency(analytics?.summary?.totalRevenue || 0)}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Labor: {formatCurrency(analytics?.summary?.laborRevenue || 0)} | 
            Parts: {formatCurrency(analytics?.summary?.partsRevenue || 0)}
          </p>
        </div>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-purple-100 rounded-lg">
              <Eye className="w-5 h-5 text-purple-600" />
            </div>
            <span className="text-sm text-gray-600">Plans Viewed</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {analytics?.summary?.plansViewed?.toLocaleString() || 0}
          </div>
          <p className="text-xs text-gray-500 mt-1">Unique vehicles viewed</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-gradient-to-br from-indigo-50 to-white rounded-xl p-6 border border-indigo-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <Cpu className="w-5 h-5 text-indigo-600" />
            </div>
            <span className="text-sm font-medium text-indigo-900">AI Cost Summary</span>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Total AI Cost</span>
              <span className="font-semibold text-gray-900">{formatCost(analytics?.summary?.aiCost || 0)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">VINs Processed</span>
              <span className="font-semibold text-gray-900">{analytics?.summary?.uniqueVinsProcessed || 0}</span>
            </div>
            <div className="border-t border-indigo-100 pt-3 mt-3">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-indigo-700">Cost per VIN</span>
                <span className="font-bold text-indigo-600">{formatCost(analytics?.summary?.costPerVin || 0)}</span>
              </div>
              <div className="flex justify-between items-center mt-2">
                <span className="text-sm font-medium text-indigo-700">Cost per View</span>
                <span className="font-bold text-indigo-600">{formatCost(analytics?.summary?.costPerView || 0)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900 flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              Performance by Source
            </h2>
          </div>
          <div className="p-4">
            {analytics?.byRecommendationType?.length === 0 ? (
              <p className="text-gray-500 text-sm py-4 text-center">No recommendation data yet</p>
            ) : (
              <div className="space-y-3">
                {analytics?.byRecommendationType?.map((item) => (
                  <div key={item.type} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div>
                      <p className="font-medium text-gray-900">{getTypeLabel(item.type)}</p>
                      <p className="text-xs text-gray-500">
                        {item.added} added, {item.sold} sold ({item.conversionRate}%)
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-green-600">{formatCurrency(item.revenue)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {analytics?.daily && analytics.daily.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="p-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Daily Activity</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Date</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Jobs Added</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Jobs Sold</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {analytics.daily.slice(-14).reverse().map((day) => (
                  <tr key={day.date} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900">{day.date}</td>
                    <td className="px-4 py-3 text-right text-gray-900">{day.added}</td>
                    <td className="px-4 py-3 text-right text-gray-900">{day.sold}</td>
                    <td className="px-4 py-3 text-right font-medium text-green-600">{formatCurrency(day.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
        <h3 className="font-medium text-blue-900 mb-2">How ROI is Calculated</h3>
        <ul className="text-sm text-blue-800 space-y-1">
          <li><strong>Jobs Added:</strong> MOS recommendations added to repair orders via the "Add to RO" button</li>
          <li><strong>Jobs Sold:</strong> Added jobs that were invoiced/completed on the repair order</li>
          <li><strong>Revenue:</strong> Total price (labor + parts) of sold jobs attributed to MOS</li>
          <li><strong>Cost per View:</strong> AI processing cost divided by plans actually viewed by your team</li>
        </ul>
      </div>
    </div>
  );
}
