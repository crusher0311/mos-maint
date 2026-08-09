"use client";

/**
 * Task #1064 — read-only list of Shop-Ware tenants that have authorized
 * our Partner API. Lets on-call distinguish "typo'd tenant ID" from
 * "authorization never completed" when a shop's Connect 404s.
 */

import { useState } from "react";
import { Loader2, RefreshCw, CheckCircle, XCircle } from "lucide-react";

interface AuthRow {
  tenantId: number;
  writable: boolean;
  tenantName: string | null;
  shops: { id: number; name: string }[] | null;
}

export default function ShopwareAuthorizationsClient() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<AuthRow[] | null>(null);
  const [count, setCount] = useState<number>(0);
  const [filter, setFilter] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/platform-admin/shopware-authorizations");
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Failed to fetch authorizations");
        setRows(null);
      } else {
        setRows(data.authorizations);
        setCount(data.count);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to fetch");
      setRows(null);
    } finally {
      setLoading(false);
    }
  }

  const q = filter.trim().toLowerCase();
  const visible = (rows || []).filter((r) => {
    if (!q) return true;
    return (
      String(r.tenantId).includes(q) ||
      (r.tenantName || "").toLowerCase().includes(q) ||
      (r.shops || []).some(
        (s) => String(s.id).includes(q) || s.name.toLowerCase().includes(q)
      )
    );
  });

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold text-gray-900">Shop-Ware Authorizations</h1>
        <button
          onClick={load}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {rows ? "Refresh" : "Load from Shop-Ware"}
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Tenants that have authorized our Partner API, fetched live from Shop-Ware. If a shop&apos;s
        Connect fails with a tenant 404, and their tenant isn&apos;t listed here, the shop still
        needs to authorize the partner connection in Shop-Ware. If it IS listed, the entered
        Tenant ID is likely a typo (note: a blank Tenant ID falls back to the Shop ID).
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center gap-2">
          <XCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {rows && (
        <>
          <div className="flex items-center gap-3 mb-3">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by tenant ID, tenant name, shop ID, or shop name…"
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {visible.length} of {count} authorized tenant{count === 1 ? "" : "s"}
            </span>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-2">Tenant ID</th>
                  <th className="px-4 py-2">Tenant Name</th>
                  <th className="px-4 py-2">Writable</th>
                  <th className="px-4 py-2">Shops</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((r) => (
                  <tr key={r.tenantId}>
                    <td className="px-4 py-2 font-mono">{r.tenantId}</td>
                    <td className="px-4 py-2">{r.tenantName ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-2">
                      {r.writable ? (
                        <span className="inline-flex items-center gap-1 text-green-700">
                          <CheckCircle className="w-3.5 h-3.5" /> yes
                        </span>
                      ) : (
                        <span className="text-gray-500">read-only</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {r.shops === null ? (
                        <span className="text-gray-400">not fetched</span>
                      ) : r.shops.length === 0 ? (
                        <span className="text-gray-400">none</span>
                      ) : (
                        r.shops.map((s) => (
                          <span
                            key={s.id}
                            className="inline-block mr-1 mb-1 px-2 py-0.5 bg-gray-100 rounded text-xs"
                          >
                            {s.id} · {s.name}
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-gray-400">
                      No matching tenants
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!rows && !loading && !error && (
        <div className="p-6 text-center text-gray-400 border border-dashed border-gray-300 rounded-lg text-sm">
          Click &quot;Load from Shop-Ware&quot; to fetch the authorized-tenants list on demand.
        </div>
      )}
    </div>
  );
}
