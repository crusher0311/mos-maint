"use client";

import { useState } from "react";
import { Save, ExternalLink, RefreshCw } from "lucide-react";

type BillingSettings = {
  professionalProductId: string;
  professionalPriceMonthly: string;
  professionalPriceYearly: string;
  enterpriseProductId: string;
  enterprisePriceMonthly: string;
  enterprisePriceYearly: string;
  trialDays: number;
  defaultVinLimit: number;
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
  const [stripePrices, setStripePrices] = useState<any[]>([]);

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

      setMessage({ type: "success", text: "Settings saved successfully" });
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
      setStripePrices(data.prices || []);
      setMessage({ type: "success", text: `Found ${data.prices?.length || 0} active prices in Stripe` });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      {message && (
        <div
          className={`p-4 rounded-md ${
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
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900">Professional Plan</h3>
            <a
              href="https://dashboard.stripe.com/products"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-indigo-600 hover:text-indigo-500 inline-flex items-center gap-1"
            >
              <ExternalLink className="w-4 h-4" />
              Stripe Dashboard
            </a>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Product ID
              </label>
              <input
                type="text"
                value={settings.professionalProductId}
                onChange={(e) =>
                  setSettings({ ...settings, professionalProductId: e.target.value })
                }
                placeholder="prod_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Monthly Price ID
              </label>
              <input
                type="text"
                value={settings.professionalPriceMonthly}
                onChange={(e) =>
                  setSettings({ ...settings, professionalPriceMonthly: e.target.value })
                }
                placeholder="price_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Yearly Price ID
              </label>
              <input
                type="text"
                value={settings.professionalPriceYearly}
                onChange={(e) =>
                  setSettings({ ...settings, professionalPriceYearly: e.target.value })
                }
                placeholder="price_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>
        </div>

        <div className="p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Enterprise Plan</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Product ID
              </label>
              <input
                type="text"
                value={settings.enterpriseProductId}
                onChange={(e) =>
                  setSettings({ ...settings, enterpriseProductId: e.target.value })
                }
                placeholder="prod_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Monthly Price ID
              </label>
              <input
                type="text"
                value={settings.enterprisePriceMonthly}
                onChange={(e) =>
                  setSettings({ ...settings, enterprisePriceMonthly: e.target.value })
                }
                placeholder="price_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Yearly Price ID
              </label>
              <input
                type="text"
                value={settings.enterprisePriceYearly}
                onChange={(e) =>
                  setSettings({ ...settings, enterprisePriceYearly: e.target.value })
                }
                placeholder="price_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>
        </div>

        <div className="p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Defaults</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Trial Period (days)
              </label>
              <input
                type="number"
                value={settings.trialDays}
                onChange={(e) =>
                  setSettings({ ...settings, trialDays: parseInt(e.target.value) || 0 })
                }
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Default VIN Limit
              </label>
              <input
                type="number"
                value={settings.defaultVinLimit}
                onChange={(e) =>
                  setSettings({ ...settings, defaultVinLimit: parseInt(e.target.value) || 0 })
                }
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
        >
          <Save className="w-4 h-4 mr-2" />
          {saving ? "Saving..." : "Save Settings"}
        </button>

        <button
          onClick={handleSyncFromStripe}
          disabled={syncing}
          className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing..." : "Sync from Stripe"}
        </button>
      </div>

      {stripePrices.length > 0 && (
        <div className="bg-white shadow rounded-lg p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            Active Prices in Stripe
          </h3>
          <p className="text-sm text-gray-500 mb-4">
            Copy these IDs into the fields above as needed.
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Product
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Price ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Amount
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Interval
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {stripePrices.map((price) => (
                  <tr key={price.id}>
                    <td className="px-4 py-3 text-sm text-gray-900">
                      {price.productName || price.product}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-600">
                      {price.id}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">
                      ${(price.unitAmount / 100).toFixed(2)} {price.currency?.toUpperCase()}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {price.interval || "one-time"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
