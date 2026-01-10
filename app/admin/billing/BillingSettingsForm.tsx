"use client";

import { useState } from "react";
import { Save, ExternalLink, RefreshCw, Copy, Check, Package, CreditCard, Gift } from "lucide-react";
import type { BillingSettings } from "@/lib/stripe";

type StripePrice = {
  id: string;
  productId: string;
  productName: string | null;
  unitAmount: number | null;
  currency: string;
  type: string;
  recurring: { interval: string; intervalCount: number } | null;
  metadata: Record<string, string>;
};

type StripeProduct = {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  active: boolean;
};

export default function BillingSettingsForm({
  initialSettings,
}: {
  initialSettings: BillingSettings;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [stripeData, setStripeData] = useState<{ products: StripeProduct[]; prices: StripePrice[] } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/billing/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to save");
      }

      setMessage({ type: "success", text: "Billing settings saved successfully" });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleSyncFromStripe = async () => {
    setSyncing(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/billing/sync-stripe");
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to sync from Stripe");
      }

      const data = await res.json();
      setStripeData(data);
      setMessage({ type: "success", text: `Found ${data.products?.length || 0} products and ${data.prices?.length || 0} prices in Stripe` });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSyncing(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatPrice = (amount: number | null, currency: string) => {
    if (amount === null) return "N/A";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  };

  return (
    <div className="space-y-6">
      {message && (
        <div
          className={`p-4 rounded-lg ${
            message.type === "success"
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="bg-white shadow rounded-lg divide-y divide-gray-200">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                <CreditCard className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">MOS Pro Subscription</h3>
                <p className="text-sm text-gray-500">$199/month - 300 VINs included</p>
              </div>
            </div>
            <a
              href="https://dashboard.stripe.com/products"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:text-blue-500 inline-flex items-center gap-1"
            >
              <ExternalLink className="w-4 h-4" />
              Stripe Dashboard
            </a>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Product ID
              </label>
              <input
                type="text"
                value={settings.mosProProductId}
                onChange={(e) => setSettings({ ...settings, mosProProductId: e.target.value })}
                placeholder="prod_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Price ID
              </label>
              <input
                type="text"
                value={settings.mosProPriceId}
                onChange={(e) => setSettings({ ...settings, mosProPriceId: e.target.value })}
                placeholder="price_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Price ($)
              </label>
              <input
                type="number"
                value={settings.mosProPrice}
                onChange={(e) => setSettings({ ...settings, mosProPrice: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Included VINs
              </label>
              <input
                type="number"
                value={settings.mosProIncludedVins}
                onChange={(e) => setSettings({ ...settings, mosProIncludedVins: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
              <Package className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">VIN Packs (One-Time Purchases)</h3>
              <p className="text-sm text-gray-500">For shops that exceed their monthly limit</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium text-gray-900">100 VINs - $39</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={settings.vinPack100ProductId}
                    onChange={(e) => setSettings({ ...settings, vinPack100ProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={settings.vinPack100PriceId}
                    onChange={(e) => setSettings({ ...settings, vinPack100PriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ($)</label>
                  <input
                    type="number"
                    value={settings.vinPack100Price}
                    onChange={(e) => setSettings({ ...settings, vinPack100Price: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium text-gray-900">250 VINs - $79</span>
                <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">Best Value</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={settings.vinPack250ProductId}
                    onChange={(e) => setSettings({ ...settings, vinPack250ProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={settings.vinPack250PriceId}
                    onChange={(e) => setSettings({ ...settings, vinPack250PriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ($)</label>
                  <input
                    type="number"
                    value={settings.vinPack250Price}
                    onChange={(e) => setSettings({ ...settings, vinPack250Price: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium text-gray-900">500 VINs - $149</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Product ID</label>
                  <input
                    type="text"
                    value={settings.vinPack500ProductId}
                    onChange={(e) => setSettings({ ...settings, vinPack500ProductId: e.target.value })}
                    placeholder="prod_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ID</label>
                  <input
                    type="text"
                    value={settings.vinPack500PriceId}
                    onChange={(e) => setSettings({ ...settings, vinPack500PriceId: e.target.value })}
                    placeholder="price_..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Price ($)</label>
                  <input
                    type="number"
                    value={settings.vinPack500Price}
                    onChange={(e) => setSettings({ ...settings, vinPack500Price: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
              <Gift className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Onboarding & Setup Fee</h3>
              <p className="text-sm text-gray-500">$495 one-time (optional - can be waived for Founding Shops)</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Product ID</label>
              <input
                type="text"
                value={settings.onboardingProductId}
                onChange={(e) => setSettings({ ...settings, onboardingProductId: e.target.value })}
                placeholder="prod_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Price ID</label>
              <input
                type="text"
                value={settings.onboardingPriceId}
                onChange={(e) => setSettings({ ...settings, onboardingPriceId: e.target.value })}
                placeholder="price_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Price ($)</label>
              <input
                type="number"
                value={settings.onboardingPrice}
                onChange={(e) => setSettings({ ...settings, onboardingPrice: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center">
              <Gift className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Trial & Bonus Settings</h3>
              <p className="text-sm text-gray-500">Configure free trial and skip-trial bonus incentive</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Trial Period (days)
              </label>
              <input
                type="number"
                value={settings.trialDays}
                onChange={(e) => setSettings({ ...settings, trialDays: parseInt(e.target.value) || 0 })}
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Trial VIN Limit
              </label>
              <input
                type="number"
                value={settings.trialVinLimit}
                onChange={(e) => setSettings({ ...settings, trialVinLimit: parseInt(e.target.value) || 0 })}
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">VINs allowed during free trial</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Skip Trial Bonus VINs
              </label>
              <input
                type="number"
                value={settings.skipTrialBonusVins}
                onChange={(e) => setSettings({ ...settings, skipTrialBonusVins: parseInt(e.target.value) || 0 })}
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">Extra VINs for skipping trial (300 + 50 = 350)</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Pro Plan VIN Limit
              </label>
              <input
                type="number"
                value={settings.defaultVinLimit}
                onChange={(e) => setSettings({ ...settings, defaultVinLimit: parseInt(e.target.value) || 0 })}
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">Default for paid subscribers</p>
            </div>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-amber-800">
              <strong>Skip Trial Incentive:</strong> When a new shop skips the {settings.trialVinLimit} VIN free trial and subscribes immediately, 
              they receive {settings.mosProIncludedVins} + {settings.skipTrialBonusVins} = <strong>{settings.mosProIncludedVins + settings.skipTrialBonusVins} VINs</strong> for their first month.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="foundingShopPricing"
              checked={settings.foundingShopPricing}
              onChange={(e) => setSettings({ ...settings, foundingShopPricing: e.target.checked })}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <label htmlFor="foundingShopPricing" className="text-sm font-medium text-gray-700">
              Founding Shop Pricing Active
            </label>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          <Save className="w-4 h-4 mr-2" />
          {saving ? "Saving..." : "Save Settings"}
        </button>

        <button
          onClick={handleSyncFromStripe}
          disabled={syncing}
          className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing..." : "Fetch from Stripe"}
        </button>
      </div>

      {stripeData && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">Stripe Products & Prices</h3>
            <p className="text-sm text-gray-500 mt-1">Click any ID to copy it, then paste into the fields above</p>
          </div>

          {stripeData.products.length > 0 && (
            <div className="p-6 border-b border-gray-200">
              <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Products</h4>
              <div className="space-y-2">
                {stripeData.products.map((product) => (
                  <div key={product.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div>
                      <span className="font-medium text-gray-900">{product.name}</span>
                      {product.description && (
                        <span className="text-gray-500 text-sm ml-2">- {product.description}</span>
                      )}
                      {Object.keys(product.metadata).length > 0 && (
                        <div className="text-xs text-gray-400 mt-1">
                          {Object.entries(product.metadata).map(([k, v]) => `${k}: ${v}`).join(", ")}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => copyToClipboard(product.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-mono bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
                    >
                      {copiedId === product.id ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                      {product.id}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stripeData.prices.length > 0 && (
            <div className="p-6">
              <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Prices</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price ID</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Amount</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Metadata</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {stripeData.prices.map((price) => (
                      <tr key={price.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {price.productName || price.productId}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => copyToClipboard(price.id)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-mono bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
                          >
                            {copiedId === price.id ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                            {price.id}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          {formatPrice(price.unitAmount, price.currency)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {price.recurring ? `${price.recurring.interval}ly` : "One-time"}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {Object.keys(price.metadata).length > 0 
                            ? Object.entries(price.metadata).map(([k, v]) => `${k}: ${v}`).join(", ")
                            : "-"
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-semibold text-blue-900 mb-2">Stripe Setup Checklist</h4>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>1. Create products in Stripe Dashboard with the correct names</li>
          <li>2. Add metadata: <code className="bg-blue-100 px-1 rounded">plan_type: pro</code>, <code className="bg-blue-100 px-1 rounded">included_vins: 300</code>, <code className="bg-blue-100 px-1 rounded">founding_plan: true</code></li>
          <li>3. For VIN packs, add: <code className="bg-blue-100 px-1 rounded">vin_pack: 100</code> (or 250, 500) and <code className="bg-blue-100 px-1 rounded">type: overage</code></li>
          <li>4. Click "Fetch from Stripe" above to pull in your products</li>
          <li>5. Copy product and price IDs into the fields, then Save</li>
        </ul>
      </div>
    </div>
  );
}
