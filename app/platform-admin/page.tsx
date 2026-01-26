"use client";

import { useState, useEffect } from "react";
import { Building2, Users, DollarSign, Zap, TrendingUp } from "lucide-react";
import Link from "next/link";

interface PlatformStats {
  totalShops: number;
  totalUsers: number;
  totalRequests: number;
  totalCost: number;
  recentShops: Array<{ shopId: number; name: string; createdAt: string }>;
}

export default function PlatformAdminOverview() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const res = await fetch("/api/platform-admin/stats");
      const data = await res.json();
      if (data.ok) {
        setStats(data);
      }
    } catch (err) {
      console.error("Error loading stats:", err);
    } finally {
      setLoading(false);
    }
  };

  const formatCost = (cost: number) => {
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
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
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Platform Overview</h1>
        <p className="text-gray-600">MOS Maintenance platform statistics</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Link href="/platform-admin/shops" className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 hover:border-[rgba(60,129,195,0.3)] transition-colors">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-[rgba(60,129,195,0.15)] rounded-lg">
              <Building2 className="w-5 h-5 text-[#3c81c3]" />
            </div>
            <span className="text-sm text-gray-600">Total Shops</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {stats?.totalShops || 0}
          </div>
        </Link>

        <Link href="/platform-admin/users" className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 hover:border-[rgba(60,129,195,0.3)] transition-colors">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Users className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-gray-600">Total Users</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {stats?.totalUsers || 0}
          </div>
        </Link>

        <Link href="/platform-admin/usage" className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 hover:border-[rgba(60,129,195,0.3)] transition-colors">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-green-100 rounded-lg">
              <DollarSign className="w-5 h-5 text-green-600" />
            </div>
            <span className="text-sm text-gray-600">Total AI Cost</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {formatCost(stats?.totalCost || 0)}
          </div>
        </Link>

        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-orange-100 rounded-lg">
              <Zap className="w-5 h-5 text-orange-600" />
            </div>
            <span className="text-sm text-gray-600">API Requests</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {stats?.totalRequests?.toLocaleString() || 0}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Recent Shops</h2>
          <Link href="/platform-admin/shops" className="text-[#3c81c3] hover:text-[#3c81c3] text-sm">
            View All
          </Link>
        </div>
        <div className="divide-y divide-gray-100">
          {stats?.recentShops?.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No shops yet</div>
          ) : (
            stats?.recentShops?.slice(0, 5).map((shop) => (
              <div key={shop.shopId} className="p-4 flex items-center justify-between hover:bg-gray-50">
                <div>
                  <div className="font-medium text-gray-900">{shop.name}</div>
                  <div className="text-sm text-gray-500">ID: {shop.shopId}</div>
                </div>
                <div className="text-sm text-gray-500">
                  {new Date(shop.createdAt).toLocaleDateString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
