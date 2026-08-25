"use client";

// Task #884: manage AutoFlow v4 shop numbers. The v4 UI
// (app.autoflow.com/shop/<number>/...) identifies shops by a number the
// extension can't always resolve. Unresolved numbers land here for a manual,
// fail-closed attach to the right shop's autoflow.shopNumbers.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Building2, Link2, RefreshCw, Trash2 } from "lucide-react";

interface UnresolvedNumber {
  number: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  seenCount: number;
  candidateShopIds: (string | number)[];
  candidateCount: number;
  reason: string | null;
}

interface AutoflowShop {
  shopId: string | number;
  name: string;
  autoflowDomain: string | null;
  canonicalIdentifiers: string[];
  shopNumbers: string[];
}

interface AutoflowClaim {
  shopId: string | number;
  shopName: string;
  claimType: "canonical" | "alias";
  field: string;
  value: string;
}

interface AutoflowConflict {
  identifier: string;
  reason: "multiple_canonical" | "multiple_aliases" | "canonical_alias_collision";
  canonicalClaims: AutoflowClaim[];
  aliasClaims: AutoflowClaim[];
}

export default function AutoflowNumbersPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<UnresolvedNumber[]>([]);
  const [shops, setShops] = useState<AutoflowShop[]>([]);
  const [conflicts, setConflicts] = useState<AutoflowConflict[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/platform-admin/autoflow-numbers");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setUnresolved(data.unresolved || []);
      setShops(data.shops || []);
      setConflicts(data.conflicts || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function attach(number: string) {
    const shopId = selection[number];
    if (!shopId) {
      setNotice("Pick a shop first.");
      return;
    }
    setBusy(number);
    setNotice(null);
    try {
      const res = await fetch("/api/platform-admin/autoflow-numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number, shopId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setNotice(`Attached ${number} to shop ${shopId}.`);
      await load();
    } catch (e: any) {
      setNotice(e?.message || "Attach failed");
    } finally {
      setBusy(null);
    }
  }

  async function detach(number: string, shopId: string | number) {
    if (!confirm(`Remove v4 number ${number} from shop ${shopId}? The extension will stop resolving this number until re-attached.`)) return;
    setBusy(number);
    setNotice(null);
    try {
      const res = await fetch("/api/platform-admin/autoflow-numbers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number, shopId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setNotice(`Removed ${number} from shop ${shopId}.`);
      await load();
    } catch (e: any) {
      setNotice(e?.message || "Remove failed");
    } finally {
      setBusy(null);
    }
  }

  const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : "—");
  const mapped = shops.filter((s) => (s.shopNumbers || []).length > 0);
  const conflictLabel = (reason: AutoflowConflict["reason"]) => {
    if (reason === "multiple_canonical") return "Multiple canonical owners";
    if (reason === "multiple_aliases") return "Duplicate learned aliases";
    return "Alias overrides another shop's canonical identity";
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Building2 className="w-6 h-6 text-blue-600" />
            AutoFlow v4 Shop Numbers
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            AutoFlow v4 pages (app.autoflow.com/shop/&lt;number&gt;/…) identify shops by a number.
            Unresolved numbers reported by the extension appear below — attach each one to the
            correct shop. The extension never guesses: until attached, those pages fail closed.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {notice && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm py-12 text-center">Loading…</div>
      ) : (
        <>
          <div className="bg-amber-50 rounded-xl border border-amber-200 shadow-sm mb-8">
            <div className="px-5 py-4 border-b border-amber-200">
              <h2 className="font-semibold text-amber-950 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                Identity conflicts{" "}
                <span className="text-amber-700 font-normal">({conflicts.length})</span>
              </h2>
              <p className="text-sm text-amber-800 mt-1">
                Canonical domains always win at runtime. Remove incorrect learned aliases below;
                canonical fields must be corrected on the shop record itself.
              </p>
            </div>
            {conflicts.length === 0 ? (
              <div className="px-5 py-8 text-sm text-amber-800 text-center">
                No conflicting AutoFlow identities found.
              </div>
            ) : (
              <div className="divide-y divide-amber-200">
                {conflicts.map((conflict) => (
                  <div key={conflict.identifier} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="font-mono font-semibold text-amber-950">
                          {conflict.identifier}
                        </div>
                        <div className="text-xs text-amber-800 mt-0.5">
                          {conflictLabel(conflict.reason)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2">
                      {conflict.canonicalClaims.map((claim) => (
                        <div
                          key={`canonical-${claim.shopId}-${claim.field}`}
                          className="flex items-center justify-between gap-3 rounded-lg bg-white border border-amber-200 px-3 py-2 text-sm"
                        >
                          <span>
                            <strong>{claim.shopName}</strong>{" "}
                            <span className="text-gray-500">#{claim.shopId}</span>
                          </span>
                          <span className="text-xs text-emerald-700 font-medium">
                            Canonical · {claim.field}
                          </span>
                        </div>
                      ))}
                      {conflict.aliasClaims.map((claim) => (
                        <div
                          key={`alias-${claim.shopId}-${claim.value}`}
                          className="flex items-center justify-between gap-3 rounded-lg bg-white border border-amber-200 px-3 py-2 text-sm"
                        >
                          <span>
                            <strong>{claim.shopName}</strong>{" "}
                            <span className="text-gray-500">#{claim.shopId}</span>
                          </span>
                          <button
                            onClick={() => detach(claim.value, claim.shopId)}
                            disabled={busy === claim.value}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-red-700 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-40"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Remove learned alias
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm mb-8">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">
                Unresolved numbers <span className="text-gray-400 font-normal">({unresolved.length})</span>
              </h2>
            </div>
            {unresolved.length === 0 ? (
              <div className="px-5 py-8 text-sm text-gray-500 text-center">
                No unresolved AutoFlow numbers. 🎉
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="px-5 py-2 font-medium">Number</th>
                    <th className="px-3 py-2 font-medium">Last seen</th>
                    <th className="px-3 py-2 font-medium">Hits</th>
                    <th className="px-3 py-2 font-medium">Candidates</th>
                     <th className="px-3 py-2 font-medium">Reason</th>
                    <th className="px-3 py-2 font-medium">Attach to shop</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {unresolved.map((u) => (
                    <tr key={u.number} className="border-b border-gray-50">
                      <td className="px-5 py-3 font-mono text-gray-900">{u.number}</td>
                      <td className="px-3 py-3 text-gray-600">{fmt(u.lastSeenAt)}</td>
                      <td className="px-3 py-3 text-gray-600">{u.seenCount}</td>
                      <td className="px-3 py-3 text-gray-600">
                        {u.candidateShopIds.length > 0 ? u.candidateShopIds.join(", ") : "—"}
                      </td>
                       <td className="px-3 py-3 text-gray-600">
                         {u.reason ? u.reason.replaceAll("_", " ") : "unknown"}
                       </td>
                      <td className="px-3 py-3">
                        <select
                          value={selection[u.number] || ""}
                          onChange={(e) =>
                            setSelection((s) => ({ ...s, [u.number]: e.target.value }))
                          }
                          className="border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white max-w-[260px]"
                        >
                          <option value="">Select shop…</option>
                          {shops.map((s) => (
                            <option key={String(s.shopId)} value={String(s.shopId)}>
                              {s.name} (#{s.shopId})
                              {s.autoflowDomain ? ` — ${s.autoflowDomain}` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <button
                          onClick={() => attach(u.number)}
                          disabled={busy === u.number || !selection[u.number]}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-40"
                        >
                          <Link2 className="w-3.5 h-3.5" /> Attach
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">
                Current mappings <span className="text-gray-400 font-normal">({mapped.length} shops)</span>
              </h2>
            </div>
            {mapped.length === 0 ? (
              <div className="px-5 py-8 text-sm text-gray-500 text-center">
                No shops have v4 numbers attached yet.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="px-5 py-2 font-medium">Shop</th>
                    <th className="px-3 py-2 font-medium">AutoFlow domain</th>
                    <th className="px-3 py-2 font-medium">v4 numbers</th>
                  </tr>
                </thead>
                <tbody>
                  {mapped.map((s) => (
                    <tr key={String(s.shopId)} className="border-b border-gray-50">
                      <td className="px-5 py-3 text-gray-900">
                        {s.name} <span className="text-gray-400">#{s.shopId}</span>
                      </td>
                      <td className="px-3 py-3 text-gray-600">{s.autoflowDomain || "—"}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          {s.shopNumbers.map((n) => (
                            <span
                              key={n}
                              className="inline-flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-md font-mono text-gray-800"
                            >
                              {n}
                              <button
                                onClick={() => detach(n, s.shopId)}
                                disabled={busy === n}
                                title="Remove this number"
                                className="text-gray-400 hover:text-red-600 disabled:opacity-40"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
