"use client";

import { useState, useEffect } from "react";
import { Save, Loader2, Check, AlertCircle, Grid3X3 } from "lucide-react";

interface PlatformFeature {
  _id: string;
  name: string;
  slug: string;
  description: string;
  category: "core" | "addon" | "bundled";
  status: "active" | "inactive";
  includedInTiers: string[];
  order: number;
}

const TIERS = [
  { slug: "starter", name: "Starter", color: "bg-gray-100" },
  { slug: "plus", name: "Plus", color: "bg-blue-100" },
  { slug: "elite", name: "Elite", color: "bg-blue-100" },
  { slug: "enterprise", name: "Enterprise", color: "bg-amber-100" },
];

export default function PlanFeaturesMatrixPage() {
  const [features, setFeatures] = useState<PlatformFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [changes, setChanges] = useState<Record<string, string[]>>({});
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadFeatures();
  }, []);

  const loadFeatures = async () => {
    try {
      const res = await fetch("/api/platform-admin/features");
      const data = await res.json();
      if (data.ok) {
        const sorted = data.features.sort((a: PlatformFeature, b: PlatformFeature) => a.order - b.order);
        setFeatures(sorted);
        const initialChanges: Record<string, string[]> = {};
        sorted.forEach((f: PlatformFeature) => {
          initialChanges[f._id] = [...f.includedInTiers];
        });
        setChanges(initialChanges);
      }
    } catch (err) {
      console.error("Error loading features:", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleTier = (featureId: string, tierSlug: string) => {
    setChanges((prev) => {
      const current = prev[featureId] || [];
      const updated = current.includes(tierSlug)
        ? current.filter((t) => t !== tierSlug)
        : [...current, tierSlug];
      return { ...prev, [featureId]: updated };
    });
    setHasChanges(true);
  };

  const saveChanges = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const updates = Object.entries(changes).map(([id, tiers]) => ({
        id,
        includedInTiers: tiers,
      }));

      const res = await fetch("/api/platform-admin/features/bulk-update-tiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });

      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "success", text: "Plan features updated successfully!" });
        setHasChanges(false);
        loadFeatures();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to save changes" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save changes" });
    } finally {
      setSaving(false);
    }
  };

  const isChecked = (featureId: string, tierSlug: string) => {
    return (changes[featureId] || []).includes(tierSlug);
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </div>
    );
  }

  const coreFeatures = features.filter((f) => f.category === "core" && f.status === "active");
  const addonFeatures = features.filter((f) => f.category === "addon" && f.status === "active");
  const bundledFeatures = features.filter((f) => f.category === "bundled" && f.status === "active");

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Grid3X3 className="w-6 h-6 text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">Plan Features Matrix</h1>
          </div>
          <p className="text-gray-600 mt-1">
            Configure which features are included in each subscription tier. Changes are saved together.
          </p>
        </div>
        <button
          onClick={saveChanges}
          disabled={saving || !hasChanges}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Changes
        </button>
      </div>

      {message && (
        <div
          className={`p-4 rounded-lg flex items-center gap-2 ${
            message.type === "success"
              ? "bg-green-50 border border-green-200 text-green-800"
              : "bg-red-50 border border-red-200 text-red-800"
          }`}
        >
          {message.type === "success" ? (
            <Check className="w-5 h-5" />
          ) : (
            <AlertCircle className="w-5 h-5" />
          )}
          {message.text}
        </div>
      )}

      {hasChanges && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center gap-2 text-amber-800">
          <AlertCircle className="w-5 h-5" />
          <span>You have unsaved changes. Click "Save Changes" to apply them.</span>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left py-4 px-6 font-semibold text-gray-900 w-64">Feature</th>
                {TIERS.map((tier) => (
                  <th key={tier.slug} className="text-center py-4 px-6 font-semibold text-gray-900 w-32">
                    <div className={`inline-block px-3 py-1 rounded-full text-sm ${tier.color}`}>
                      {tier.name}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {coreFeatures.length > 0 && (
                <>
                  <tr className="bg-gray-100">
                    <td colSpan={5} className="py-2 px-6 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      Core Features
                    </td>
                  </tr>
                  {coreFeatures.map((feature) => (
                    <tr key={feature._id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-4 px-6">
                        <div className="font-medium text-gray-900">{feature.name}</div>
                        <div className="text-sm text-gray-500">{feature.description}</div>
                      </td>
                      {TIERS.map((tier) => (
                        <td key={tier.slug} className="text-center py-4 px-6">
                          <button
                            onClick={() => toggleTier(feature._id, tier.slug)}
                            className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center transition-all ${
                              isChecked(feature._id, tier.slug)
                                ? "bg-green-500 border-green-500 text-white"
                                : "bg-white border-gray-300 hover:border-gray-400"
                            }`}
                          >
                            {isChecked(feature._id, tier.slug) && <Check className="w-5 h-5" />}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </>
              )}
              {addonFeatures.length > 0 && (
                <>
                  <tr className="bg-gray-100">
                    <td colSpan={5} className="py-2 px-6 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      Add-on Features
                    </td>
                  </tr>
                  {addonFeatures.map((feature) => (
                    <tr key={feature._id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-4 px-6">
                        <div className="font-medium text-gray-900">{feature.name}</div>
                        <div className="text-sm text-gray-500">{feature.description}</div>
                      </td>
                      {TIERS.map((tier) => (
                        <td key={tier.slug} className="text-center py-4 px-6">
                          <button
                            onClick={() => toggleTier(feature._id, tier.slug)}
                            className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center transition-all ${
                              isChecked(feature._id, tier.slug)
                                ? "bg-green-500 border-green-500 text-white"
                                : "bg-white border-gray-300 hover:border-gray-400"
                            }`}
                          >
                            {isChecked(feature._id, tier.slug) && <Check className="w-5 h-5" />}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </>
              )}
              {bundledFeatures.length > 0 && (
                <>
                  <tr className="bg-gray-100">
                    <td colSpan={5} className="py-2 px-6 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      Bundled Features
                    </td>
                  </tr>
                  {bundledFeatures.map((feature) => (
                    <tr key={feature._id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-4 px-6">
                        <div className="font-medium text-gray-900">{feature.name}</div>
                        <div className="text-sm text-gray-500">{feature.description}</div>
                      </td>
                      {TIERS.map((tier) => (
                        <td key={tier.slug} className="text-center py-4 px-6">
                          <button
                            onClick={() => toggleTier(feature._id, tier.slug)}
                            className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center transition-all ${
                              isChecked(feature._id, tier.slug)
                                ? "bg-green-500 border-green-500 text-white"
                                : "bg-white border-gray-300 hover:border-gray-400"
                            }`}
                          >
                            {isChecked(feature._id, tier.slug) && <Check className="w-5 h-5" />}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-sm text-gray-500">
        <p>Click on a checkbox to toggle whether a feature is included in that plan tier.</p>
        <p className="mt-1">Features shown on the billing page are filtered by these settings.</p>
      </div>
    </div>
  );
}
