"use client";

import { useState, useEffect } from "react";
import { Building2, Search, RefreshCw, LogIn, Loader2 } from "lucide-react";

interface Shop {
  _id: string;
  shopId: number;
  name: string;
  createdAt: string;
  userCount: number;
  vehicleCount: number;
  integrations: string[];
}

export default function PlatformShopsPage() {
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [impersonating, setImpersonating] = useState<number | null>(null);

  const accessShop = async (shopId: number) => {
    if (impersonating) return;
    setImpersonating(shopId);
    try {
      const res = await fetch("/api/platform-admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId }),
      });
      const data = await res.json();
      if (res.ok) {
        window.location.href = "/dashboard";
      } else {
        alert(data.error || "Failed to access shop");
      }
    } catch (err) {
      console.error("Error accessing shop:", err);
      alert("Failed to access shop");
    } finally {
      setImpersonating(null);
    }
  };

  useEffect(() => {
    loadShops();
  }, []);

  const loadShops = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/shops");
      const data = await res.json();
      if (data.ok) {
        setShops(data.shops || []);
      }
    } catch (err) {
      console.error("Error loading shops:", err);
    } finally {
      setLoading(false);
    }
  };

  const filteredShops = shops.filter(shop => 
    shop.name?.toLowerCase().includes(search.toLowerCase()) ||
    String(shop.shopId).includes(search)
  );

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-64 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">All Shops</h1>
          <p className="text-gray-600">Manage all client shops on the platform</p>
        </div>
        <button
          onClick={loadShops}
          className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
        <input
          type="text"
          placeholder="Search shops by name or ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        />
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Shop</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">ID</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Users</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Vehicles</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Integrations</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">Created</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredShops.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  {search ? "No shops match your search" : "No shops yet"}
                </td>
              </tr>
            ) : (
              filteredShops.map((shop) => (
                <tr key={shop._id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                        <Building2 className="w-4 h-4 text-purple-600" />
                      </div>
                      <span className="font-medium text-gray-900">{shop.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{shop.shopId}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.userCount}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{shop.vehicleCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 flex-wrap">
                      {shop.integrations?.length > 0 ? (
                        shop.integrations.map(int => (
                          <span key={int} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                            {int}
                          </span>
                        ))
                      ) : (
                        <span className="text-gray-400 text-sm">None</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-sm">
                    {new Date(shop.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => accessShop(shop.shopId)}
                      disabled={impersonating !== null}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {impersonating === shop.shopId ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <LogIn className="w-4 h-4" />
                      )}
                      Access
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="text-sm text-gray-500">
        Showing {filteredShops.length} of {shops.length} shops
      </div>
    </div>
  );
}
