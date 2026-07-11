"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, RefreshCw, Trash2, AlertTriangle, Plus } from "lucide-react";

interface ServiceKeyOption {
  key: string;
  label: string;
}

interface OverrideRow {
  normalizedName: string;
  serviceKey: string;
  sampleName: string;
  createdBy?: string | null;
  updatedAt: string;
}

interface UnmatchedEntry {
  key: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  samples: string[];
  shopIds: string[];
}

export default function IntervalImportMatchClient() {
  const [error, setError] = useState<string | null>(null);

  const [tally, setTally] = useState<UnmatchedEntry[]>([]);
  const [tallyLoading, setTallyLoading] = useState(false);

  const [serviceKeys, setServiceKeys] = useState<ServiceKeyOption[]>([]);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [overridesLoading, setOverridesLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [assignDraft, setAssignDraft] = useState<Record<string, string>>({});

  const loadTally = useCallback(async () => {
    setTallyLoading(true);
    try {
      const res = await fetch("/api/platform-admin/interval-import-unmatched");
      const data = await res.json();
      if (data.ok) setTally(data.entries || []);
    } catch {
      /* non-fatal */
    } finally {
      setTallyLoading(false);
    }
  }, []);

  const loadOverrides = useCallback(async () => {
    setOverridesLoading(true);
    try {
      const res = await fetch("/api/platform-admin/interval-import-overrides");
      const data = await res.json();
      if (data.ok) {
        setOverrides(data.overrides || []);
        setServiceKeys(data.serviceKeys || []);
      }
    } catch {
      /* non-fatal */
    } finally {
      setOverridesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTally();
    loadOverrides();
  }, [loadTally, loadOverrides]);

  const keyLabel = useCallback(
    (key: string) => serviceKeys.find((k) => k.key === key)?.label || key,
    [serviceKeys],
  );

  async function saveOverride(name: string, serviceKey: string) {
    if (!serviceKey) return;
    setError(null);
    setSavingKey(name);
    try {
      const res = await fetch("/api/platform-admin/interval-import-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, serviceKey }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to save mapping");
      } else {
        await loadOverrides();
      }
    } catch (e: any) {
      setError(e?.message || "Failed to save mapping");
    } finally {
      setSavingKey(null);
    }
  }

  async function removeOverride(name: string) {
    try {
      await fetch(
        `/api/platform-admin/interval-import-overrides?name=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      await loadOverrides();
    } catch {
      /* non-fatal */
    }
  }

  async function clearTally() {
    if (!confirm("Clear the unmatched interval-import tally for this server process?")) return;
    try {
      await fetch("/api/platform-admin/interval-import-unmatched", { method: "DELETE" });
      loadTally();
    } catch {
      /* non-fatal */
    }
  }

  const overrideByName = new Map(overrides.map((o) => [o.normalizedName, o]));

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Interval Import Match</h1>
      <p className="text-gray-600 mb-6 text-sm">
        Service names from shops&apos; uploaded maintenance-guide documents (Settings →
        Intervals → Import) that didn&apos;t match any known service. Assign a key here so
        future imports recognize the wording, or add it permanently to the dictionary.
      </p>

      {error && (
        <div className="mb-4 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      {/* Fleet-wide unmatched tally */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Unmatched service names{" "}
            <span className="text-gray-400 font-normal">({tally.length})</span>
          </h2>
          <div className="flex gap-2">
            <button
              onClick={loadTally}
              disabled={tallyLoading}
              className="inline-flex items-center gap-1.5 text-sm text-gray-600 border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {tallyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </button>
            <button
              onClick={clearTally}
              className="inline-flex items-center gap-1.5 text-sm text-red-600 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-50"
            >
              <Trash2 className="w-4 h-4" /> Clear
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          In-memory per server process; resets on redeploy. These are document wordings that
          resolved to no canonical key — assign a key below (applies live to future imports),
          or add the wording to <code>SERVICE_KEYS</code> in <code>lib/service-keys.ts</code>{" "}
          (keep <code>toKeyFromName</code> / <code>toKeyFromFreeText</code> in sync) for a
          permanent fix.
        </p>

        {tally.length === 0 ? (
          <div className="text-sm text-gray-500 py-6 text-center">
            No unmatched service names recorded.
          </div>
        ) : (
          <div className="overflow-x-auto border border-gray-100 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Service name</th>
                  <th className="text-left px-3 py-2">Count</th>
                  <th className="text-left px-3 py-2">Shops</th>
                  <th className="text-left px-3 py-2">Last seen</th>
                  <th className="text-left px-3 py-2">Assign key</th>
                </tr>
              </thead>
              <tbody>
                {tally.map((e) => {
                  const display = e.samples[0] || e.key;
                  const mapped = overrideByName.get(e.key);
                  return (
                    <tr key={e.key} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-gray-900">
                        {display}
                        {e.samples.length > 1 && (
                          <div className="text-xs text-gray-400">
                            also: {e.samples.slice(1).join(", ")}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-700">{e.count}</td>
                      <td className="px-3 py-2 text-gray-500">{e.shopIds.join(", ") || "—"}</td>
                      <td className="px-3 py-2 text-gray-400 text-xs">
                        {new Date(e.lastSeen).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        {mapped ? (
                          <span className="text-xs text-green-700">
                            mapped → {keyLabel(mapped.serviceKey)}
                          </span>
                        ) : (
                          <AssignKey
                            name={display}
                            serviceKeys={serviceKeys}
                            value={assignDraft[e.key] || ""}
                            onChange={(v) => setAssignDraft((d) => ({ ...d, [e.key]: v }))}
                            onSave={() => saveOverride(display, assignDraft[e.key] || "")}
                            saving={savingKey === display}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Saved overrides library */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Saved key overrides{" "}
            <span className="text-gray-400 font-normal">({overrides.length})</span>
          </h2>
          <button
            onClick={loadOverrides}
            disabled={overridesLoading}
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {overridesLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          Manual document-name → interval-key mappings. These apply live to all shops&apos;
          future document imports (no code deploy). For permanent fixes, also add the wording
          to <code>SERVICE_KEYS</code> in <code>lib/service-keys.ts</code>.
        </p>

        {overrides.length === 0 ? (
          <div className="text-sm text-gray-500 py-6 text-center">
            No overrides saved yet. Assign a key to an unmatched name above.
          </div>
        ) : (
          <div className="overflow-x-auto border border-gray-100 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Service name</th>
                  <th className="text-left px-3 py-2">Interval key</th>
                  <th className="text-left px-3 py-2">Added by</th>
                  <th className="text-left px-3 py-2">Updated</th>
                  <th className="text-left px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.normalizedName} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-gray-900">{o.sampleName || o.normalizedName}</td>
                    <td className="px-3 py-2 text-gray-700">
                      {keyLabel(o.serviceKey)}{" "}
                      <span className="text-gray-400 font-mono text-xs">({o.serviceKey})</span>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{o.createdBy || "—"}</td>
                    <td className="px-3 py-2 text-gray-400 text-xs">
                      {o.updatedAt ? new Date(o.updatedAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => removeOverride(o.normalizedName)}
                        className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function AssignKey({
  name,
  serviceKeys,
  value,
  onChange,
  onSave,
  saving,
}: {
  name: string;
  serviceKeys: ServiceKeyOption[];
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs border border-gray-300 rounded px-1.5 py-1 max-w-[200px]"
        aria-label={`Assign interval key for ${name}`}
      >
        <option value="">Pick key…</option>
        {serviceKeys.map((k) => (
          <option key={k.key} value={k.key}>
            {k.label}
          </option>
        ))}
      </select>
      <button
        onClick={onSave}
        disabled={!value || saving}
        className="inline-flex items-center gap-1 text-xs text-blue-600 border border-blue-200 px-2 py-1 rounded hover:bg-blue-50 disabled:opacity-40"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
        Save
      </button>
    </div>
  );
}
