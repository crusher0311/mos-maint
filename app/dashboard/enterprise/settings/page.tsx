"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Building2, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import {
  ApplyRulesButton,
  EnterpriseLaborRateEditor,
  LaborRateRule,
} from "@/components/ui/EnterpriseLaborRateEditor";

type EnterpriseData = {
  enterprise: { id: string; name: string };
  locations: Array<{ shopId: number; name: string }>;
  rules: LaborRateRule[];
  consistent: boolean;
  differingLocationCount: number;
  locationCount: number;
};

export default function EnterpriseSettingsPage() {
  const [data, setData] = useState<EnterpriseData | null>(null);
  const [rules, setRules] = useState<LaborRateRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/enterprise/labor-rates");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to load enterprise labor rate rules");
      setData(result);
      setRules((result.rules || []).sort((a: LaborRateRule, b: LaborRateRule) => b.priority - a.priority));
      setDirty(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load enterprise labor rate rules");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const changeRules = (next: LaborRateRule[]) => {
    setRules(next);
    setDirty(true);
    setSuccess(null);
  };

  const applyToAll = async () => {
    if (!data) return;
    const invalid = rules.find((rule) => !rule.name.trim() || rule.rate <= 0);
    if (invalid) {
      setError("Every rule needs a name and a rate greater than zero.");
      return;
    }
    if (!confirm(
      `Apply these ${rules.length} labor rate rule${rules.length === 1 ? "" : "s"} to all ${data.locationCount} locations? Existing destination rules will be replaced.`
    )) return;

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const normalizedRules = rules.map((rule, index) => ({
        ...rule,
        priority: rules.length - index,
      }));
      const response = await fetch("/api/enterprise/labor-rates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: normalizedRules }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to apply labor rate rules");
      const appliedCount = result.matchedCount ?? result.locationCount ?? data.locationCount;
      setSuccess(`Rules applied successfully to ${appliedCount} locations.`);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to apply labor rate rules");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex min-h-[400px] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-blue-600" /></div>;

  if (!data) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-700">
          <AlertCircle className="mb-2 h-6 w-6" />
          <p>{error || "Unable to load enterprise settings."}</p>
          <button onClick={load} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-white">Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6 md:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <Link href="/dashboard/enterprise" className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
          <ArrowLeft className="h-4 w-4" /> Back to Enterprise
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Enterprise Settings</h1>
            <p className="mt-1 text-gray-500">{data.enterprise.name} · Labor Rate Rules</p>
          </div>
          <button onClick={load} disabled={saving} className="inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm text-gray-700">
            <RefreshCw className="h-4 w-4" /> Reload
          </button>
        </div>

        <div className={`rounded-xl border p-4 ${data.consistent ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
          <div className="flex items-center gap-3">
            {data.consistent ? <CheckCircle2 className="h-5 w-5 text-green-600" /> : <AlertCircle className="h-5 w-5 text-amber-600" />}
            <div>
              <p className="font-medium text-gray-900">{data.consistent ? "Rules are consistent" : "Rules differ across locations"}</p>
              <p className="text-sm text-gray-600">
                <Building2 className="mr-1 inline h-4 w-4" />
                {data.locationCount} total locations
                {!data.consistent && ` · ${data.differingLocationCount} differ from this rule set`}
              </p>
            </div>
          </div>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {success && <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{success}</div>}

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Labor Rate Rules</h2>
            <p className="text-sm text-gray-500">Changes remain local until you explicitly apply them.</p>
          </div>
          {dirty && <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">Unsaved changes</span>}
        </div>
        <EnterpriseLaborRateEditor rules={rules} onChange={changeRules} />
        <div className="flex justify-end border-t border-gray-200 pt-5">
          <ApplyRulesButton saving={saving} locationCount={data.locationCount} onApply={applyToAll} />
        </div>
      </div>
    </div>
  );
}