"use client";

import { useState, useEffect } from "react";
import { Settings, Save, Loader2, CreditCard, Package, Link2, Gift, ExternalLink, Copy, Check } from "lucide-react";

interface BillingSettings {
  mosProProductId: string;
  mosProPriceId: string;
  mosProPrice: number;
  mosProIncludedVins: number;
  vinPack100ProductId: string;
  vinPack100PriceId: string;
  vinPack100Price: number;
  vinPack250ProductId: string;
  vinPack250PriceId: string;
  vinPack250Price: number;
  vinPack500ProductId: string;
  vinPack500PriceId: string;
  vinPack500Price: number;
  onboardingProductId: string;
  onboardingPriceId: string;
  onboardingPrice: number;
  trialVinLimit: number;
  skipTrialBonusVins: number;
  foundingShopPricing: boolean;
}

interface PlatformSettings {
  trial: {
    vinLimit: number;
  };
  billing: BillingSettings;
  general: {
    bookDemoUrl: string;
  };
}

export default function PlatformSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [vinLimit, setVinLimit] = useState("");
  const [bookDemoUrl, setBookDemoUrl] = useState("");
  const [billing, setBilling] = useState<BillingSettings | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await fetch("/api/platform-admin/settings");
      const data = await res.json();
      if (data.ok) {
        setSettings(data.settings);
        setVinLimit(String(data.settings.trial.vinLimit));
        setBookDemoUrl(data.settings.general.bookDemoUrl);
        setBilling(data.settings.billing);
      }
    } catch (err) {
      console.error("Error loading settings:", err);
    } finally {
      setLoading(false);
    }
  };

  const saveSection = async (key: string, sectionSettings: any) => {
    setSavingSection(key);
    setMessage(null);
    try {
      const res = await fetch("/api/platform-admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, settings: sectionSettings }),
      });
      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "success", text: data.message });
        loadSettings();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to save" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save settings" });
    } finally {
      setSavingSection(null);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  };

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
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Platform Settings</h1>
        <p className="text-gray-600">Configure platform-wide defaults, billing, and integrations</p>
      </div>

      {message && (
        <div className={`px-4 py-3 rounded-lg text-sm ${
          message.type === "success" 
            ? "bg-green-50 text-green-700 border border-green-200" 
            : "bg-red-50 text-red-700 border border-red-200"
        }`}>
          {message.text}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Link2 className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">General Settings</h2>
              <p className="text-sm text-gray-500">Links and general configuration</p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 max-w-xl">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Book a Demo URL
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Calendly or other scheduling link for the "Book a Demo" button on the landing page
            </p>
            <input
              type="url"
              value={bookDemoUrl}
              onChange={(e) => setBookDemoUrl(e.target.value)}
              placeholder="https://calendly.com/your-link"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button
            onClick={() => saveSection("general", { bookDemoUrl })}
            disabled={savingSection === "general"}
            className="w-fit px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {savingSection === "general" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save General Settings
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-100 rounded-lg">
              <Settings className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Trial Settings</h2>
              <p className="text-sm text-gray-500">Configure default trial limits for new shops</p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 max-w-md">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Default Trial VIN Limit
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Number of unique VINs a shop can view during their free trial
            </p>
            <div className="flex gap-2">
              <input
                type="number"
                min="1"
                value={vinLimit}
                onChange={(e) => setVinLimit(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />
              <button
                onClick={() => saveSection("trial", { vinLimit: Number(vinLimit) })}
                disabled={savingSection === "trial" || !vinLimit || Number(vinLimit) < 1}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 flex items-center gap-2"
              >
                {savingSection === "trial" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save
              </button>
            </div>
          </div>
        </div>
      </div>

      {billing && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <CreditCard className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Stripe Billing Configuration</h2>
                <p className="text-sm text-gray-500">Product and price IDs from your Stripe dashboard</p>
              </div>
            </div>
            <a
              href="https://dashboard.stripe.com/products"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:text-blue-500 flex items-center gap-1"
            >
              <ExternalLink className="w-4 h-4" />
              Stripe Dashboard
            </a>
          </div>

          <div className="space-y-6">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <h3 className="font-semibold text-blue-900 mb-3 flex items-center gap-2">
                <CreditCard className="w-4 h-4" />
                MOS Pro Subscription - ${billing.mosProPrice}/month
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={billing.mosProProductId}
                    onChange={(e) => setBilling({ ...billing, mosProProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-blue-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={billing.mosProPriceId}
                    onChange={(e) => setBilling({ ...billing, mosProPriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-blue-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">Price ($)</label>
                  <input
                    type="number"
                    value={billing.mosProPrice}
                    onChange={(e) => setBilling({ ...billing, mosProPrice: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-blue-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">Included VINs</label>
                  <input
                    type="number"
                    value={billing.mosProIncludedVins}
                    onChange={(e) => setBilling({ ...billing, mosProIncludedVins: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-blue-300 rounded-md text-sm bg-white"
                  />
                </div>
              </div>
            </div>

            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <h3 className="font-semibold text-green-900 mb-3 flex items-center gap-2">
                <Package className="w-4 h-4" />
                VIN Packs (One-Time Purchases)
              </h3>
              <div className="space-y-4">
                {[
                  { label: "100 VINs", price: billing.vinPack100Price, productKey: "vinPack100ProductId", priceKey: "vinPack100PriceId", priceValueKey: "vinPack100Price" },
                  { label: "250 VINs", price: billing.vinPack250Price, productKey: "vinPack250ProductId", priceKey: "vinPack250PriceId", priceValueKey: "vinPack250Price", badge: "Best Value" },
                  { label: "500 VINs", price: billing.vinPack500Price, productKey: "vinPack500ProductId", priceKey: "vinPack500PriceId", priceValueKey: "vinPack500Price" },
                ].map((pack) => (
                  <div key={pack.label} className="bg-white rounded-lg p-3 border border-green-200">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-green-900">{pack.label} - ${pack.price}</span>
                      {pack.badge && <span className="text-xs bg-green-200 text-green-800 px-2 py-0.5 rounded-full">{pack.badge}</span>}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <input
                        type="text"
                        value={(billing as any)[pack.productKey]}
                        onChange={(e) => setBilling({ ...billing, [pack.productKey]: e.target.value })}
                        placeholder="prod_..."
                        className="px-2 py-1.5 border border-gray-300 rounded text-sm"
                      />
                      <input
                        type="text"
                        value={(billing as any)[pack.priceKey]}
                        onChange={(e) => setBilling({ ...billing, [pack.priceKey]: e.target.value })}
                        placeholder="price_..."
                        className="px-2 py-1.5 border border-gray-300 rounded text-sm"
                      />
                      <input
                        type="number"
                        value={(billing as any)[pack.priceValueKey]}
                        onChange={(e) => setBilling({ ...billing, [pack.priceValueKey]: parseInt(e.target.value) || 0 })}
                        className="px-2 py-1.5 border border-gray-300 rounded text-sm"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
              <h3 className="font-semibold text-purple-900 mb-3 flex items-center gap-2">
                <Gift className="w-4 h-4" />
                Onboarding Fee - ${billing.onboardingPrice}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-purple-700 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={billing.onboardingProductId}
                    onChange={(e) => setBilling({ ...billing, onboardingProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-purple-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-purple-700 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={billing.onboardingPriceId}
                    onChange={(e) => setBilling({ ...billing, onboardingPriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-purple-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-purple-700 mb-1">Price ($)</label>
                  <input
                    type="number"
                    value={billing.onboardingPrice}
                    onChange={(e) => setBilling({ ...billing, onboardingPrice: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-purple-300 rounded-md text-sm bg-white"
                  />
                </div>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <h3 className="font-semibold text-amber-900 mb-3">Skip Trial Incentive</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-amber-700 mb-1">Trial VIN Limit</label>
                  <input
                    type="number"
                    value={billing.trialVinLimit}
                    onChange={(e) => setBilling({ ...billing, trialVinLimit: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-amber-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-amber-700 mb-1">Skip Trial Bonus VINs</label>
                  <input
                    type="number"
                    value={billing.skipTrialBonusVins}
                    onChange={(e) => setBilling({ ...billing, skipTrialBonusVins: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-amber-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm text-amber-800">
                    <input
                      type="checkbox"
                      checked={billing.foundingShopPricing}
                      onChange={(e) => setBilling({ ...billing, foundingShopPricing: e.target.checked })}
                      className="h-4 w-4 text-amber-600 border-amber-300 rounded"
                    />
                    Founding Shop Pricing Active
                  </label>
                </div>
              </div>
              <p className="text-sm text-amber-800 mt-3">
                Shops that skip the {billing.trialVinLimit} VIN trial get {billing.mosProIncludedVins} + {billing.skipTrialBonusVins} = <strong>{billing.mosProIncludedVins + billing.skipTrialBonusVins} VINs</strong>
              </p>
            </div>

            <button
              onClick={() => saveSection("billing", billing)}
              disabled={savingSection === "billing"}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
            >
              {savingSection === "billing" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Billing Settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
