"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Building2, Plus, Check, X, RefreshCw, ArrowLeft, Search } from "lucide-react";
import Link from "next/link";

interface Shop {
  _id: string;
  shopId: number;
  name: string;
  enterpriseId?: string;
  protractor?: { baseUrl: string };
  tekmetric?: { shopId: number };
}

interface Enterprise {
  _id: string;
  name: string;
  shopIds: number[];
}

function ShopManagementContent() {
  const searchParams = useSearchParams();
  const enterpriseId = searchParams.get("id");
  
  const [enterprise, setEnterprise] = useState<Enterprise | null>(null);
  const [allShops, setAllShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [saving, setSaving] = useState<number | null>(null);

  useEffect(() => {
    if (enterpriseId) {
      loadData();
    }
  }, [enterpriseId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [entRes, shopsRes] = await Promise.all([
        fetch(`/api/enterprise?id=${enterpriseId}`),
        fetch("/api/admin/shops")
      ]);
      
      const entData = await entRes.json();
      const shopsData = await shopsRes.json();
      
      setEnterprise(entData.enterprise);
      setAllShops(shopsData.shops || []);
    } catch (err) {
      console.error("Error loading data:", err);
    } finally {
      setLoading(false);
    }
  };

  const addShopToEnterprise = async (shopId: number) => {
    if (!enterpriseId) return;
    setSaving(shopId);
    
    try {
      await fetch("/api/enterprise", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId,
          shopId,
          action: "add_shop"
        })
      });
      
      setEnterprise(prev => prev ? {
        ...prev,
        shopIds: [...prev.shopIds, shopId]
      } : null);
    } catch (err) {
      console.error("Error adding shop:", err);
    } finally {
      setSaving(null);
    }
  };

  const removeShopFromEnterprise = async (shopId: number) => {
    if (!enterpriseId) return;
    setSaving(shopId);
    
    try {
      await fetch("/api/enterprise", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enterpriseId,
          shopId,
          action: "remove_shop"
        })
      });
      
      setEnterprise(prev => prev ? {
        ...prev,
        shopIds: prev.shopIds.filter(id => id !== shopId)
      } : null);
    } catch (err) {
      console.error("Error removing shop:", err);
    } finally {
      setSaving(null);
    }
  };

  const enterpriseShops = allShops.filter(s => enterprise?.shopIds.includes(s.shopId));
  const availableShops = allShops.filter(s => 
    !enterprise?.shopIds.includes(s.shopId) &&
    (searchQuery === "" || 
     s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
     String(s.shopId).includes(searchQuery))
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!enterprise) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-gray-600">Enterprise not found</p>
          <Link href="/admin/enterprise" className="text-blue-600 hover:underline mt-4 inline-block">
            Back to Enterprise Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/admin/enterprise" className="p-2 hover:bg-gray-100 rounded-lg">
              <ArrowLeft className="w-5 h-5 text-gray-600" />
            </Link>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Manage Shops</h1>
              <p className="text-sm text-gray-500">{enterprise.name}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="bg-white rounded-xl border border-gray-200 mb-6">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="font-semibold text-gray-900">
              Enterprise Shops ({enterpriseShops.length})
            </h2>
          </div>
          <div className="divide-y divide-gray-200">
            {enterpriseShops.map((shop) => (
              <div key={shop.shopId} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                    <Building2 className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{shop.name}</p>
                    <p className="text-sm text-gray-500">Shop ID: {shop.shopId}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {shop.protractor && (
                    <span className="px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded-full">
                      Protractor
                    </span>
                  )}
                  {shop.tekmetric && (
                    <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">
                      Tekmetric
                    </span>
                  )}
                  <button
                    onClick={() => removeShopFromEnterprise(shop.shopId)}
                    disabled={saving === shop.shopId}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Remove from enterprise"
                  >
                    {saving === shop.shopId ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <X className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}
            {enterpriseShops.length === 0 && (
              <div className="px-6 py-8 text-center text-gray-500">
                No shops in this enterprise yet. Add shops from the list below.
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Available Shops</h2>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search shops..."
                  className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
          <div className="divide-y divide-gray-200 max-h-96 overflow-y-auto">
            {availableShops.map((shop) => (
              <div key={shop.shopId} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                    <Building2 className="w-5 h-5 text-gray-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{shop.name}</p>
                    <p className="text-sm text-gray-500">Shop ID: {shop.shopId}</p>
                  </div>
                </div>
                <button
                  onClick={() => addShopToEnterprise(shop.shopId)}
                  disabled={saving === shop.shopId}
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving === shop.shopId ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      Add
                    </>
                  )}
                </button>
              </div>
            ))}
            {availableShops.length === 0 && (
              <div className="px-6 py-8 text-center text-gray-500">
                {searchQuery ? "No shops match your search" : "All shops are already in this enterprise"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ShopManagementPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    }>
      <ShopManagementContent />
    </Suspense>
  );
}
