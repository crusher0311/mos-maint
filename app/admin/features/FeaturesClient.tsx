"use client";

import { useState, useEffect } from "react";
import { 
  Search, 
  Wrench, 
  FileText, 
  Droplet, 
  RefreshCw, 
  Check, 
  X,
  Building2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

type Feature = {
  id: string;
  name: string;
  description: string;
  icon: string;
  requiresSMS: boolean;
  smsProviders: string[];
  stripeProductId?: string;
  stripePriceId?: string;
  pricePerMonth?: number;
};

type ShopFeature = {
  shopId: number;
  shopName: string;
  enabledFeatures: string[];
  featureSettings: Record<string, any>;
  subscriptions: any[];
  createdAt: string;
  updatedAt: string;
};

const iconMap: Record<string, React.ReactNode> = {
  Wrench: <Wrench className="w-5 h-5" />,
  Search: <Search className="w-5 h-5" />,
  FileText: <FileText className="w-5 h-5" />,
  Droplet: <Droplet className="w-5 h-5" />,
  RefreshCw: <RefreshCw className="w-5 h-5" />,
};

export default function FeaturesClient() {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [shopFeatures, setShopFeatures] = useState<ShopFeature[]>([]);
  const [shops, setShops] = useState<{ shopId: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedShop, setExpandedShop] = useState<number | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [featuresRes, shopsRes] = await Promise.all([
        fetch("/api/admin/features"),
        fetch("/api/admin/shops"),
      ]);

      const featuresData = await featuresRes.json();
      const shopsData = await shopsRes.json();

      if (featuresData.ok) {
        setFeatures(featuresData.features || []);
        setShopFeatures(featuresData.shopFeatures || []);
      }

      if (shopsData.ok) {
        setShops(shopsData.shops || []);
      }
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleFeature = async (shopId: number, featureId: string, enabled: boolean) => {
    setUpdating(`${shopId}-${featureId}`);
    try {
      const res = await fetch(`/api/admin/features/${shopId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: enabled ? "enable" : "disable",
          featureId,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        setShopFeatures(prev => {
          const existing = prev.find(sf => sf.shopId === shopId);
          if (existing) {
            return prev.map(sf => 
              sf.shopId === shopId 
                ? { ...sf, enabledFeatures: data.enabledFeatures }
                : sf
            );
          } else {
            return [...prev, {
              shopId,
              shopName: shops.find(s => s.shopId === shopId)?.name || `Shop ${shopId}`,
              enabledFeatures: data.enabledFeatures,
              featureSettings: {},
              subscriptions: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }];
          }
        });
      }
    } catch (err) {
      console.error("Failed to toggle feature:", err);
    } finally {
      setUpdating(null);
    }
  };

  const getShopEnabledFeatures = (shopId: number): string[] => {
    const sf = shopFeatures.find(s => s.shopId === shopId);
    return sf?.enabledFeatures || ["maintenance"];
  };

  const filteredShops = shops.filter(shop =>
    shop.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    String(shop.shopId).includes(searchTerm)
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Available Features</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map(feature => (
            <div 
              key={feature.id}
              className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 transition-colors"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-blue-50 rounded-lg text-blue-600">
                  {iconMap[feature.icon] || <Wrench className="w-5 h-5" />}
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">{feature.name}</h3>
                  <span className="text-xs text-gray-500">{feature.id}</span>
                </div>
              </div>
              <p className="text-sm text-gray-600 mb-3">{feature.description}</p>
              {feature.requiresSMS && (
                <div className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded inline-block">
                  Requires: {feature.smsProviders.join(", ")}
                </div>
              )}
              {feature.pricePerMonth && (
                <div className="text-sm font-medium text-green-600 mt-2">
                  ${feature.pricePerMonth}/month
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-gray-900">Shop Features</h2>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search shops..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        <div className="divide-y divide-gray-200">
          {filteredShops.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No shops found
            </div>
          ) : (
            filteredShops.map(shop => {
              const enabledFeatures = getShopEnabledFeatures(shop.shopId);
              const isExpanded = expandedShop === shop.shopId;

              return (
                <div key={shop.shopId} className="bg-white">
                  <button
                    onClick={() => setExpandedShop(isExpanded ? null : shop.shopId)}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3">
                      <Building2 className="w-5 h-5 text-gray-400" />
                      <div className="text-left">
                        <div className="font-medium text-gray-900">{shop.name}</div>
                        <div className="text-sm text-gray-500">
                          {enabledFeatures.length} feature{enabledFeatures.length !== 1 ? "s" : ""} enabled
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1">
                        {enabledFeatures.map(fId => {
                          const feature = features.find(f => f.id === fId);
                          return (
                            <div
                              key={fId}
                              className="w-6 h-6 rounded bg-blue-100 text-blue-600 flex items-center justify-center"
                              title={feature?.name || fId}
                            >
                              {iconMap[feature?.icon || "Wrench"] || <Wrench className="w-3 h-3" />}
                            </div>
                          );
                        })}
                      </div>
                      {isExpanded ? (
                        <ChevronUp className="w-5 h-5 text-gray-400" />
                      ) : (
                        <ChevronDown className="w-5 h-5 text-gray-400" />
                      )}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-4 bg-gray-50">
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-3">
                        {features.map(feature => {
                          const isEnabled = enabledFeatures.includes(feature.id);
                          const isUpdating = updating === `${shop.shopId}-${feature.id}`;

                          return (
                            <div
                              key={feature.id}
                              className={`p-3 rounded-lg border ${
                                isEnabled 
                                  ? "border-blue-200 bg-blue-50" 
                                  : "border-gray-200 bg-white"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <div className={`p-1.5 rounded ${
                                    isEnabled ? "bg-blue-100 text-blue-600" : "bg-gray-100 text-gray-400"
                                  }`}>
                                    {iconMap[feature.icon] || <Wrench className="w-4 h-4" />}
                                  </div>
                                  <span className={`text-sm font-medium ${
                                    isEnabled ? "text-blue-900" : "text-gray-600"
                                  }`}>
                                    {feature.name}
                                  </span>
                                </div>
                                <button
                                  onClick={() => toggleFeature(shop.shopId, feature.id, !isEnabled)}
                                  disabled={isUpdating}
                                  className={`p-1.5 rounded-full transition-colors ${
                                    isUpdating ? "opacity-50 cursor-not-allowed" : ""
                                  } ${
                                    isEnabled
                                      ? "bg-blue-600 text-white hover:bg-blue-700"
                                      : "bg-gray-200 text-gray-400 hover:bg-gray-300"
                                  }`}
                                >
                                  {isUpdating ? (
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                  ) : isEnabled ? (
                                    <Check className="w-4 h-4" />
                                  ) : (
                                    <X className="w-4 h-4" />
                                  )}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
