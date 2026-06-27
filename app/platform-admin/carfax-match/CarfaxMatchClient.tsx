"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Search, RefreshCw, Trash2, AlertTriangle, CheckCircle2, Plus, Wand2 } from "lucide-react";

interface DiagEntry {
  source: "record" | "category";
  description: string;
  date: string | null;
  miles: number | null;
  matchedKeys: string[];
  impliedChildKeys: string[];
  dedupedAgainstShop: boolean;
  outOfDateRange: boolean;
  unmatched: boolean;
  matchedViaOverride: boolean;
}

interface ServiceKeyOption {
  key: string;
  label: string;
}

interface OverrideRow {
  normalizedDescription: string;
  serviceKey: string;
  sampleDescription: string;
  createdBy?: string | null;
  updatedAt: string;
}

interface DiagResponse {
  ok: boolean;
  error?: string;
  vin?: string;
  shopId?: number;
  mileage?: number;
  vehicleYear?: number | null;
  carfaxAvailable?: boolean;
  shopHistoryCount?: number;
  summary?: {
    totalRecords: number;
    totalCategories: number;
    matched: number;
    impliedOnly: number;
    unmatched: number;
  };
  entries?: DiagEntry[];
}

interface UnmatchedEntry {
  key: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sources: string[];
  samples: string[];
  vins: string[];
  shopIds: string[];
}

export default function CarfaxMatchClient() {
  const [vin, setVin] = useState("");
  const [shopId, setShopId] = useState("");
  const [mileage, setMileage] = useState("");
  const [loading, setLoading] = useState(false);
  const [diag, setDiag] = useState<DiagResponse | null>(null);
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
      const res = await fetch("/api/platform-admin/carfax-unmatched");
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
      const res = await fetch("/api/platform-admin/carfax-overrides");
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

  async function saveOverride(description: string, serviceKey: string) {
    if (!serviceKey) return;
    setSavingKey(description);
    try {
      const res = await fetch("/api/platform-admin/carfax-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, serviceKey }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to save mapping");
      } else {
        await loadOverrides();
        // Re-run the diagnostic so the row reflects the new mapping live.
        if (diag?.vin) runDiagnostic();
      }
    } catch (e: any) {
      setError(e?.message || "Failed to save mapping");
    } finally {
      setSavingKey(null);
    }
  }

  async function removeOverride(description: string) {
    try {
      await fetch(
        `/api/platform-admin/carfax-overrides?description=${encodeURIComponent(description)}`,
        { method: "DELETE" },
      );
      await loadOverrides();
      if (diag?.vin) runDiagnostic();
    } catch {
      /* non-fatal */
    }
  }

  async function runDiagnostic() {
    setError(null);
    setDiag(null);
    const v = vin.trim().toUpperCase();
    if (v.length !== 17) {
      setError("Enter a valid 17-character VIN.");
      return;
    }
    if (!mileage || parseInt(mileage, 10) <= 0) {
      setError("Enter the current mileage.");
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({
        diag: "carfax",
        vin: v,
        mileage: String(parseInt(mileage, 10)),
      });
      if (shopId.trim()) params.set("shopId", shopId.trim());
      const res = await fetch(`/api/plan-build?${params.toString()}`, { method: "POST" });
      const data: DiagResponse = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || `Request failed (${res.status})`);
      } else {
        setDiag(data);
      }
      // A diagnostic run also records fresh unmatched descriptions.
      loadTally();
    } catch (e: any) {
      setError(e?.message || "Request failed");
    } finally {
      setLoading(false);
    }
  }

  async function clearTally() {
    if (!confirm("Clear the unmatched CARFAX tally for this server process?")) return;
    try {
      await fetch("/api/platform-admin/carfax-unmatched", { method: "DELETE" });
      loadTally();
    } catch {
      /* non-fatal */
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">CARFAX Match Diagnostic</h1>
      <p className="text-gray-600 mb-6 text-sm">
        See how a vehicle&apos;s CARFAX services map to canonical service keys, and review
        descriptions that didn&apos;t match anything (so they can be added to the dictionary).
      </p>

      {/* Per-vehicle diagnostic */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Per-vehicle check</h2>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-500 mb-1">VIN</label>
            <input
              value={vin}
              onChange={(e) => setVin(e.target.value)}
              placeholder="17-character VIN"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm uppercase"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Mileage</label>
            <input
              value={mileage}
              onChange={(e) => setMileage(e.target.value)}
              placeholder="e.g. 84000"
              inputMode="numeric"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Shop ID (optional)</label>
            <input
              value={shopId}
              onChange={(e) => setShopId(e.target.value)}
              placeholder="target shop"
              inputMode="numeric"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>
        <button
          onClick={runDiagnostic}
          disabled={loading}
          className="inline-flex items-center gap-2 bg-[#3c81c3] text-white px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Run diagnostic
        </button>

        {error && (
          <div className="mt-4 flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="w-4 h-4" /> {error}
          </div>
        )}

        {diag && diag.summary && (
          <div className="mt-6">
            <div className="flex flex-wrap gap-4 text-sm text-gray-700 mb-4">
              <span>VIN <strong>{diag.vin}</strong></span>
              <span>Shop <strong>{diag.shopId}</strong></span>
              <span>Year <strong>{diag.vehicleYear ?? "—"}</strong></span>
              <span>CARFAX <strong>{diag.carfaxAvailable ? "available" : "unavailable"}</strong></span>
              <span>Shop history rows <strong>{diag.shopHistoryCount}</strong></span>
            </div>
            <div className="flex flex-wrap gap-3 mb-4 text-sm">
              <Stat label="Records" value={diag.summary.totalRecords} />
              <Stat label="Categories" value={diag.summary.totalCategories} />
              <Stat label="Matched" value={diag.summary.matched} tone="good" />
              <Stat label="Implied only" value={diag.summary.impliedOnly} />
              <Stat label="Unmatched" value={diag.summary.unmatched} tone={diag.summary.unmatched > 0 ? "bad" : "good"} />
            </div>

            <div className="overflow-x-auto border border-gray-100 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Description</th>
                    <th className="text-left px-3 py-2">Src</th>
                    <th className="text-left px-3 py-2">Date</th>
                    <th className="text-left px-3 py-2">Miles</th>
                    <th className="text-left px-3 py-2">Matched keys</th>
                    <th className="text-left px-3 py-2">Implied resets</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">Assign key</th>
                  </tr>
                </thead>
                <tbody>
                  {(diag.entries || []).map((e, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-gray-900">{e.description}</td>
                      <td className="px-3 py-2 text-gray-500">{e.source}</td>
                      <td className="px-3 py-2 text-gray-500">{e.date ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-500">{e.miles ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-700">
                        {e.matchedKeys.map((k) => keyLabel(k)).join(", ") || "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-500">{e.impliedChildKeys.join(", ") || "—"}</td>
                      <td className="px-3 py-2">
                        {e.unmatched ? (
                          <span className="inline-flex items-center gap-1 text-red-600">
                            <AlertTriangle className="w-3.5 h-3.5" /> unmatched
                          </span>
                        ) : e.matchedViaOverride ? (
                          <span className="inline-flex items-center gap-1 text-blue-600">
                            <Wand2 className="w-3.5 h-3.5" /> override
                          </span>
                        ) : e.outOfDateRange ? (
                          <span className="text-amber-600">out of range</span>
                        ) : e.dedupedAgainstShop ? (
                          <span className="text-gray-500">deduped w/ shop</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-green-600">
                            <CheckCircle2 className="w-3.5 h-3.5" /> matched
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <AssignKey
                          description={e.description}
                          serviceKeys={serviceKeys}
                          value={assignDraft[e.description] || ""}
                          onChange={(v) =>
                            setAssignDraft((d) => ({ ...d, [e.description]: v }))
                          }
                          onSave={() => saveOverride(e.description, assignDraft[e.description] || "")}
                          saving={savingKey === e.description}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Fleet-wide unmatched tally */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Unmatched descriptions <span className="text-gray-400 font-normal">({tally.length})</span>
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
          In-memory per server process; resets on redeploy. These are CARFAX wordings that
          resolved to no canonical key — add them to <code>SERVICE_KEYS</code> in
          <code>lib/service-keys.ts</code> (keep <code>toKeyFromName</code> /
          <code>toKeyFromFreeText</code> in sync).
        </p>

        {tally.length === 0 ? (
          <div className="text-sm text-gray-500 py-6 text-center">
            No unmatched descriptions recorded.
          </div>
        ) : (
          <div className="overflow-x-auto border border-gray-100 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Description</th>
                  <th className="text-left px-3 py-2">Count</th>
                  <th className="text-left px-3 py-2">Sources</th>
                  <th className="text-left px-3 py-2">Sample VINs</th>
                  <th className="text-left px-3 py-2">Shops</th>
                  <th className="text-left px-3 py-2">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {tally.map((e) => (
                  <tr key={e.key} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-gray-900">{e.samples[0] || e.key}</td>
                    <td className="px-3 py-2 text-gray-700">{e.count}</td>
                    <td className="px-3 py-2 text-gray-500">{e.sources.join(", ")}</td>
                    <td className="px-3 py-2 text-gray-500 font-mono text-xs">{e.vins.join(", ") || "—"}</td>
                    <td className="px-3 py-2 text-gray-500">{e.shopIds.join(", ") || "—"}</td>
                    <td className="px-3 py-2 text-gray-400 text-xs">{new Date(e.lastSeen).toLocaleString()}</td>
                  </tr>
                ))}
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
          Manual CARFAX-description → service-key mappings. These apply live to VHI for all
          shops (no code deploy) — a matched row shows the{" "}
          <span className="text-blue-600">override</span> badge above. For permanent fixes,
          also add the wording to <code>SERVICE_KEYS</code> in <code>lib/service-keys.ts</code>.
        </p>

        {overrides.length === 0 ? (
          <div className="text-sm text-gray-500 py-6 text-center">
            No overrides saved yet. Run a diagnostic above and assign a key to an unmatched row.
          </div>
        ) : (
          <div className="overflow-x-auto border border-gray-100 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Description</th>
                  <th className="text-left px-3 py-2">Service key</th>
                  <th className="text-left px-3 py-2">Added by</th>
                  <th className="text-left px-3 py-2">Updated</th>
                  <th className="text-left px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.normalizedDescription} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-gray-900">{o.sampleDescription || o.normalizedDescription}</td>
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
                        onClick={() => removeOverride(o.normalizedDescription)}
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
  description,
  serviceKeys,
  value,
  onChange,
  onSave,
  saving,
}: {
  description: string;
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
        className="text-xs border border-gray-300 rounded px-1.5 py-1 max-w-[160px]"
        aria-label={`Assign service key for ${description}`}
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

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" }) {
  const color =
    tone === "good" ? "text-green-700 bg-green-50" : tone === "bad" ? "text-red-700 bg-red-50" : "text-gray-700 bg-gray-50";
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${color}`}>
      <strong>{value}</strong> {label}
    </span>
  );
}
