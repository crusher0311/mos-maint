"use client";

import { useState, useEffect } from "react";
import { Settings, Save, Loader2, CreditCard, Package, Link2, Gift, ExternalLink, Copy, Check, Download, X, Plus } from "lucide-react";

interface BillingSettings {
  // Tier-specific pricing
  starterProductId: string;
  starterPriceId: string;
  starterPrice: number;
  starterIncludedVins: number;
  plusProductId: string;
  plusPriceId: string;
  plusPrice: number;
  plusIncludedVins: number;
  eliteProductId: string;
  elitePriceId: string;
  elitePrice: number;
  eliteIncludedVins: number;
  // Legacy mosPro fields
  mosProProductId: string;
  mosProPriceId: string;
  mosProPrice: number;
  mosProIncludedVins: number;
  // VIN packs
  vinPack100ProductId: string;
  vinPack100PriceId: string;
  vinPack100Price: number;
  vinPack250ProductId: string;
  vinPack250PriceId: string;
  vinPack250Price: number;
  vinPack500ProductId: string;
  vinPack500PriceId: string;
  vinPack500Price: number;
  // Onboarding
  onboardingProductId: string;
  onboardingPriceId: string;
  onboardingPrice: number;
  // Trial settings
  trialVinLimit: number;
  skipTrialBonusVins: number;
  foundingShopPricing: boolean;
  defaultVinLimit: number;
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

interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
  type: string;
}

interface StripeProduct {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  prices: StripePrice[];
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
  const [showImportModal, setShowImportModal] = useState(false);
  const [stripeProducts, setStripeProducts] = useState<StripeProduct[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [newProduct, setNewProduct] = useState({
    name: "",
    description: "",
    price: "",
    type: "one_time" as "one_time" | "recurring",
    interval: "month"
  });
  const [appliedMappings, setAppliedMappings] = useState<Record<string, string>>({});

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

  const loadStripeProducts = async () => {
    setLoadingProducts(true);
    try {
      const res = await fetch("/api/platform-admin/stripe/products");
      const data = await res.json();
      if (data.ok) {
        setStripeProducts(data.products);
        setShowImportModal(true);
      } else {
        setMessage({ type: "error", text: "Failed to load Stripe products" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to connect to Stripe" });
    } finally {
      setLoadingProducts(false);
    }
  };

  const createStripeProduct = async () => {
    if (!newProduct.name || !newProduct.price) return;
    
    setCreatingProduct(true);
    try {
      const res = await fetch("/api/platform-admin/stripe/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProduct.name,
          description: newProduct.description,
          price: parseFloat(newProduct.price),
          type: newProduct.type,
          interval: newProduct.interval
        })
      });
      const data = await res.json();
      if (data.ok) {
        setStripeProducts(prev => [data.product, ...prev]);
        setNewProduct({ name: "", description: "", price: "", type: "one_time", interval: "month" });
        setShowCreateForm(false);
        setMessage({ type: "success", text: `Product "${data.product.name}" created in Stripe!` });
      } else {
        setMessage({ type: "error", text: data.error || "Failed to create product" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to create product" });
    } finally {
      setCreatingProduct(false);
    }
  };

  const applyProduct = (product: StripeProduct, priceId: string, targetField: string) => {
    if (!billing) return;
    const price = product.prices.find(p => p.id === priceId);
    const priceValue = price?.unit_amount ? price.unit_amount / 100 : 0;
    
    const updates: Partial<BillingSettings> = {};
    
    if (targetField === "starter") {
      updates.starterProductId = product.id;
      updates.starterPriceId = priceId;
      updates.starterPrice = priceValue;
    } else if (targetField === "plus") {
      updates.plusProductId = product.id;
      updates.plusPriceId = priceId;
      updates.plusPrice = priceValue;
    } else if (targetField === "elite") {
      updates.eliteProductId = product.id;
      updates.elitePriceId = priceId;
      updates.elitePrice = priceValue;
    } else if (targetField === "mosPro") {
      updates.mosProProductId = product.id;
      updates.mosProPriceId = priceId;
      updates.mosProPrice = priceValue;
    } else if (targetField === "vinPack100") {
      updates.vinPack100ProductId = product.id;
      updates.vinPack100PriceId = priceId;
      updates.vinPack100Price = priceValue;
    } else if (targetField === "vinPack250") {
      updates.vinPack250ProductId = product.id;
      updates.vinPack250PriceId = priceId;
      updates.vinPack250Price = priceValue;
    } else if (targetField === "vinPack500") {
      updates.vinPack500ProductId = product.id;
      updates.vinPack500PriceId = priceId;
      updates.vinPack500Price = priceValue;
    } else if (targetField === "onboarding") {
      updates.onboardingProductId = product.id;
      updates.onboardingPriceId = priceId;
      updates.onboardingPrice = priceValue;
    }
    
    setBilling({ ...billing, ...updates });
    setAppliedMappings({ ...appliedMappings, [priceId]: targetField });
    setMessage({ type: "success", text: `Applied ${product.name} to ${targetField}` });
  };

  const getAppliedLabel = (targetField: string) => {
    const labels: Record<string, string> = {
      starter: "Starter",
      plus: "Plus",
      elite: "Elite",
      mosPro: "MOS Pro (Legacy)",
      vinPack100: "100 VIN Pack",
      vinPack250: "250 VIN Pack",
      vinPack500: "500 VIN Pack",
      onboarding: "Onboarding",
    };
    return labels[targetField] || targetField;
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
            <div className="p-2 bg-[rgba(60,129,195,0.15)] rounded-lg">
              <Settings className="w-5 h-5 text-[#3c81c3]" />
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
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#3c81c3] focus:border-transparent"
              />
              <button
                onClick={() => saveSection("trial", { vinLimit: Number(vinLimit) })}
                disabled={savingSection === "trial" || !vinLimit || Number(vinLimit) < 1}
                className="px-4 py-2 bg-[rgba(60,129,195,0.75)] text-white rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 flex items-center gap-2"
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
            <div className="flex items-center gap-3">
              <button
                onClick={loadStripeProducts}
                disabled={loadingProducts}
                className="text-sm bg-[rgba(60,129,195,0.75)] text-white px-3 py-1.5 rounded-lg hover:bg-[#3c81c3] disabled:opacity-50 flex items-center gap-1"
              >
                {loadingProducts ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Import from Stripe
              </button>
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
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <CreditCard className="w-4 h-4" />
                Starter - ${billing.starterPrice || 199.95}/month
              </h3>
              <p className="text-xs text-gray-500 mb-3">Maintenance + Oil Sticker</p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={billing.starterProductId || ""}
                    onChange={(e) => setBilling({ ...billing, starterProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={billing.starterPriceId || ""}
                    onChange={(e) => setBilling({ ...billing, starterPriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Price ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={billing.starterPrice || 199.95}
                    onChange={(e) => setBilling({ ...billing, starterPrice: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Included VINs</label>
                  <input
                    type="number"
                    value={billing.starterIncludedVins || 300}
                    onChange={(e) => setBilling({ ...billing, starterIncludedVins: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
                  />
                </div>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-blue-900 flex items-center gap-2">
                  <CreditCard className="w-4 h-4" />
                  Plus - ${billing.plusPrice || 229.95}/month
                </h3>
                <span className="text-xs bg-blue-200 text-blue-800 px-2 py-0.5 rounded-full">Most Popular</span>
              </div>
              <p className="text-xs text-blue-700 mb-3">Maintenance + Job Lookup + Oil Sticker</p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={billing.plusProductId || billing.mosProProductId || ""}
                    onChange={(e) => setBilling({ ...billing, plusProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-blue-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={billing.plusPriceId || billing.mosProPriceId || ""}
                    onChange={(e) => setBilling({ ...billing, plusPriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-blue-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">Price ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={billing.plusPrice || 229.95}
                    onChange={(e) => setBilling({ ...billing, plusPrice: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-blue-300 rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">Included VINs</label>
                  <input
                    type="number"
                    value={billing.plusIncludedVins || 300}
                    onChange={(e) => setBilling({ ...billing, plusIncludedVins: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-blue-300 rounded-md text-sm bg-white"
                  />
                </div>
              </div>
            </div>

            <div className="bg-[rgba(60,129,195,0.1)] border border-[rgba(60,129,195,0.3)] rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-[#2d6aa3] flex items-center gap-2">
                  <CreditCard className="w-4 h-4" />
                  Elite Easy Button - ${billing.elitePrice || 279.95}/month
                </h3>
                <span className="text-xs bg-[rgba(60,129,195,0.25)] text-[#3c81c3] px-2 py-0.5 rounded-full">All Features</span>
              </div>
              <p className="text-xs text-[#3c81c3] mb-3">All features included: Maintenance, Job Lookup, Oil Sticker, Keytags, Part Cross-Reference, Auto Booking</p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#3c81c3] mb-1">Product ID</label>
                  <input
                    type="text"
                    value={billing.eliteProductId || ""}
                    onChange={(e) => setBilling({ ...billing, eliteProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-[rgba(60,129,195,0.4)] rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#3c81c3] mb-1">Price ID</label>
                  <input
                    type="text"
                    value={billing.elitePriceId || ""}
                    onChange={(e) => setBilling({ ...billing, elitePriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-[rgba(60,129,195,0.4)] rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#3c81c3] mb-1">Price ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={billing.elitePrice || 279.95}
                    onChange={(e) => setBilling({ ...billing, elitePrice: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-[rgba(60,129,195,0.4)] rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#3c81c3] mb-1">Included VINs</label>
                  <input
                    type="number"
                    value={billing.eliteIncludedVins || 300}
                    onChange={(e) => setBilling({ ...billing, eliteIncludedVins: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-[rgba(60,129,195,0.4)] rounded-md text-sm bg-white"
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

            <div className="bg-[rgba(60,129,195,0.1)] border border-[rgba(60,129,195,0.3)] rounded-lg p-4">
              <h3 className="font-semibold text-[#2d6aa3] mb-3 flex items-center gap-2">
                <Gift className="w-4 h-4" />
                Onboarding Fee - ${billing.onboardingPrice}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#3c81c3] mb-1">Product ID</label>
                  <input
                    type="text"
                    value={billing.onboardingProductId}
                    onChange={(e) => setBilling({ ...billing, onboardingProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-[rgba(60,129,195,0.4)] rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#3c81c3] mb-1">Price ID</label>
                  <input
                    type="text"
                    value={billing.onboardingPriceId}
                    onChange={(e) => setBilling({ ...billing, onboardingPriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-[rgba(60,129,195,0.4)] rounded-md text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#3c81c3] mb-1">Price ($)</label>
                  <input
                    type="number"
                    value={billing.onboardingPrice}
                    onChange={(e) => setBilling({ ...billing, onboardingPrice: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-[rgba(60,129,195,0.4)] rounded-md text-sm bg-white"
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

      {showImportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Stripe Products</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowCreateForm(!showCreateForm)}
                  className="text-sm bg-green-600 text-white px-3 py-1.5 rounded-lg hover:bg-green-700 flex items-center gap-1"
                >
                  <Plus className="w-4 h-4" />
                  Create Product
                </button>
                <button
                  onClick={() => setShowImportModal(false)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-auto p-4">
              {showCreateForm && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                  <h3 className="font-semibold text-green-900 mb-3">Create New Product in Stripe</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-green-700 mb-1">Product Name *</label>
                      <input
                        type="text"
                        value={newProduct.name}
                        onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                        placeholder="e.g., MOS Pro Subscription"
                        className="w-full px-3 py-2 border border-green-300 rounded-md text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-green-700 mb-1">Price (USD) *</label>
                      <input
                        type="number"
                        step="0.01"
                        value={newProduct.price}
                        onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })}
                        placeholder="e.g., 99.00"
                        className="w-full px-3 py-2 border border-green-300 rounded-md text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-green-700 mb-1">Type</label>
                      <select
                        value={newProduct.type}
                        onChange={(e) => setNewProduct({ ...newProduct, type: e.target.value as "one_time" | "recurring" })}
                        className="w-full px-3 py-2 border border-green-300 rounded-md text-sm"
                      >
                        <option value="one_time">One-Time Payment</option>
                        <option value="recurring">Recurring Subscription</option>
                      </select>
                    </div>
                    {newProduct.type === "recurring" && (
                      <div>
                        <label className="block text-xs font-medium text-green-700 mb-1">Billing Interval</label>
                        <select
                          value={newProduct.interval}
                          onChange={(e) => setNewProduct({ ...newProduct, interval: e.target.value })}
                          className="w-full px-3 py-2 border border-green-300 rounded-md text-sm"
                        >
                          <option value="month">Monthly</option>
                          <option value="year">Yearly</option>
                        </select>
                      </div>
                    )}
                    <div className="md:col-span-2">
                      <label className="block text-xs font-medium text-green-700 mb-1">Description (optional)</label>
                      <input
                        type="text"
                        value={newProduct.description}
                        onChange={(e) => setNewProduct({ ...newProduct, description: e.target.value })}
                        placeholder="Brief description of the product"
                        className="w-full px-3 py-2 border border-green-300 rounded-md text-sm"
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={createStripeProduct}
                      disabled={creatingProduct || !newProduct.name || !newProduct.price}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2 text-sm"
                    >
                      {creatingProduct ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                      Create in Stripe
                    </button>
                    <button
                      onClick={() => setShowCreateForm(false)}
                      className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {stripeProducts.length === 0 && !showCreateForm ? (
                <div className="text-center text-gray-500 py-8">
                  <Package className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No active products found in Stripe</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-gray-600 mb-4">
                    Select a product and price, then choose where to apply it. Click "Save Billing Settings" after importing to save changes.
                  </p>
                  {stripeProducts.map((product) => (
                    <div key={product.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-gray-900">{product.name}</h3>
                          {product.description && (
                            <p className="text-sm text-gray-500">{product.description}</p>
                          )}
                          <p className="text-xs text-gray-400 mt-1 font-mono">{product.id}</p>
                        </div>
                      </div>
                      
                      {product.prices.length === 0 ? (
                        <p className="text-sm text-gray-400">No active prices</p>
                      ) : (
                        <div className="space-y-2">
                          {product.prices.map((price) => (
                            <div key={price.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                              <div>
                                <span className="font-medium">
                                  ${(price.unit_amount || 0) / 100} {price.currency.toUpperCase()}
                                </span>
                                {price.recurring && (
                                  <span className="text-sm text-gray-500 ml-2">
                                    / {price.recurring.interval}
                                  </span>
                                )}
                                {price.type === "one_time" && (
                                  <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded ml-2">
                                    One-time
                                  </span>
                                )}
                                <p className="text-xs text-gray-400 font-mono mt-1">{price.id}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                {appliedMappings[price.id] ? (
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm bg-green-100 text-green-700 px-2 py-1 rounded font-medium">
                                      <Check className="w-3 h-3 inline mr-1" />
                                      {getAppliedLabel(appliedMappings[price.id])}
                                    </span>
                                    <button
                                      onClick={() => {
                                        const newMappings = { ...appliedMappings };
                                        delete newMappings[price.id];
                                        setAppliedMappings(newMappings);
                                      }}
                                      className="text-xs text-gray-500 hover:text-red-600"
                                    >
                                      <X className="w-4 h-4" />
                                    </button>
                                  </div>
                                ) : (
                                  <select
                                    className="text-sm border border-gray-300 rounded px-2 py-1"
                                    value=""
                                    onChange={(e) => {
                                      if (e.target.value) {
                                        applyProduct(product, price.id, e.target.value);
                                      }
                                    }}
                                  >
                                    <option value="">Apply to...</option>
                                    <option value="mosPro">MOS Pro Subscription</option>
                                    <option value="vinPack100">100 VIN Pack</option>
                                    <option value="vinPack250">250 VIN Pack</option>
                                    <option value="vinPack500">500 VIN Pack</option>
                                    <option value="onboarding">Onboarding Fee</option>
                                  </select>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div className="p-4 border-t border-gray-200 flex justify-between items-center">
              <div className="text-sm text-gray-500">
                {Object.keys(appliedMappings).length > 0 && (
                  <span>{Object.keys(appliedMappings).length} product(s) mapped</span>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowImportModal(false);
                    setAppliedMappings({});
                  }}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (billing && Object.keys(appliedMappings).length > 0) {
                      await saveSection("billing", billing);
                    }
                    setShowImportModal(false);
                    setAppliedMappings({});
                  }}
                  disabled={savingSection === "billing"}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {savingSection === "billing" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Save & Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
