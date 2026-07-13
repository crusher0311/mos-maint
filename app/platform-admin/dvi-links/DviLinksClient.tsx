"use client";

// Task #860: DVI share-link ingestion health dashboard.
//
// Shows per-provider counters (discovered / fetched / parsed / expired /
// failed), recent failures (a parse-failure spike = provider page-format
// change), and recently discovered links.
import { useEffect, useState } from "react";

interface HealthRow {
  provider: string;
  discovered: number;
  pending: number;
  fetchedOk: number;
  media: number;
  expired: number;
  blocked: number;
  error: number;
  parsed: number;
  parseFailed: number;
  lastDiscoveredAt: string | null;
  lastParsedAt: string | null;
}

interface LinkRow {
  id: string;
  provider: string;
  url: string;
  shopId: string;
  vin: string | null;
  workOrderNumber: string | null;
  discoveredAt: string | null;
  fetchStatus: string;
  fetchAttempts: number;
  lastFetchAt: string | null;
  lastFetchHttpStatus: number | null;
  lastFetchError: string | null;
  parseStatus: string;
  parseError: string | null;
  parsedAt: string | null;
  itemCount: number | null;
  counts: { required: number; suggested: number; ok: number; info: number } | null;
}

interface ApiResponse {
  ok: boolean;
  ingestEnabled: boolean;
  health: HealthRow[];
  failures: LinkRow[];
  recent: LinkRow[];
  error?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  autoserve1: "AutoServe1",
  autovitals: "AutoVitals (avlink.io)",
  autoflow: "AutoFlow microsite",
  mastertech: "MasterTech.ai",
  autoops: "AutoOps (media)",
};

function fmtDate(v: string | null): string {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return v;
  }
}

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    ok: "bg-green-100 text-green-800",
    parsed: "bg-green-100 text-green-800",
    media: "bg-blue-100 text-blue-800",
    expired: "bg-yellow-100 text-yellow-800",
    blocked: "bg-orange-100 text-orange-800",
    error: "bg-red-100 text-red-800",
    failed: "bg-red-100 text-red-800",
    na: "bg-gray-100 text-gray-500",
  };
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${styles[status] || "bg-gray-100 text-gray-700"}`}
    >
      {status}
    </span>
  );
}

export default function DviLinksClient() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/platform-admin/dvi-links", {
        cache: "no-store",
      });
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">
          DVI Share-Link Ingestion
        </h1>
        <button
          onClick={load}
          className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white hover:bg-gray-700"
        >
          Refresh
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Public inspection-report links found on Protractor work orders
        (AutoServe1, AutoVitals, AutoFlow, MasterTech, AutoOps), fetched and
        parsed into VHI plan-build findings.
      </p>

      {data && (
        <div
          className={`mb-4 rounded border px-3 py-2 text-sm ${
            data.ingestEnabled
              ? "border-green-300 bg-green-50 text-green-800"
              : "border-yellow-300 bg-yellow-50 text-yellow-800"
          }`}
        >
          Ingestion flag <code>DVI_LINK_INGEST_ENABLED</code>:{" "}
          <strong>{data.ingestEnabled ? "ENABLED" : "disabled"}</strong>
          {!data.ingestEnabled &&
            " — link discovery and the fetch cron are dormant."}
        </div>
      )}

      {loading && <div className="text-gray-500 py-8">Loading…</div>}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {data && (
        <>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Provider health
          </h2>
          <div className="overflow-x-auto mb-8">
            <table className="min-w-full border border-gray-200 bg-white text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2 text-right">Discovered</th>
                  <th className="px-3 py-2 text-right">Pending</th>
                  <th className="px-3 py-2 text-right">Fetched</th>
                  <th className="px-3 py-2 text-right">Parsed</th>
                  <th className="px-3 py-2 text-right">Parse failed</th>
                  <th className="px-3 py-2 text-right">Expired</th>
                  <th className="px-3 py-2 text-right">Blocked</th>
                  <th className="px-3 py-2 text-right">Error</th>
                  <th className="px-3 py-2 text-right">Media</th>
                  <th className="px-3 py-2">Last discovered</th>
                  <th className="px-3 py-2">Last parsed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.health.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-3 py-6 text-center text-gray-400">
                      No links discovered yet.
                    </td>
                  </tr>
                )}
                {data.health.map((row) => (
                  <tr key={row.provider}>
                    <td className="px-3 py-2 font-medium">
                      {PROVIDER_LABELS[row.provider] || row.provider}
                    </td>
                    <td className="px-3 py-2 text-right">{row.discovered}</td>
                    <td className="px-3 py-2 text-right">{row.pending}</td>
                    <td className="px-3 py-2 text-right">{row.fetchedOk}</td>
                    <td className="px-3 py-2 text-right text-green-700">
                      {row.parsed}
                    </td>
                    <td
                      className={`px-3 py-2 text-right ${row.parseFailed > 0 ? "font-semibold text-red-700" : ""}`}
                    >
                      {row.parseFailed}
                    </td>
                    <td className="px-3 py-2 text-right text-yellow-700">
                      {row.expired}
                    </td>
                    <td className="px-3 py-2 text-right">{row.blocked}</td>
                    <td className="px-3 py-2 text-right">{row.error}</td>
                    <td className="px-3 py-2 text-right">{row.media}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {fmtDate(row.lastDiscoveredAt)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {fmtDate(row.lastParsedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Recent failures{" "}
            <span className="font-normal text-sm text-gray-500">
              (parse failures usually mean a provider changed its page format)
            </span>
          </h2>
          <div className="overflow-x-auto mb-8">
            <table className="min-w-full border border-gray-200 bg-white text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Shop</th>
                  <th className="px-3 py-2">Link</th>
                  <th className="px-3 py-2">Fetch</th>
                  <th className="px-3 py-2">Parse</th>
                  <th className="px-3 py-2">Error</th>
                  <th className="px-3 py-2">Last attempt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.failures.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-gray-400">
                      No failures. 🎉
                    </td>
                  </tr>
                )}
                {data.failures.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2">{row.provider}</td>
                    <td className="px-3 py-2">{row.shopId}</td>
                    <td className="px-3 py-2 max-w-xs truncate">
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {row.url}
                      </a>
                    </td>
                    <td className="px-3 py-2">{statusBadge(row.fetchStatus)}</td>
                    <td className="px-3 py-2">{statusBadge(row.parseStatus)}</td>
                    <td className="px-3 py-2 max-w-sm truncate text-red-700">
                      {row.parseError || row.lastFetchError || "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {fmtDate(row.lastFetchAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Recently discovered links
          </h2>
          <div className="overflow-x-auto">
            <table className="min-w-full border border-gray-200 bg-white text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Shop</th>
                  <th className="px-3 py-2">VIN</th>
                  <th className="px-3 py-2">RO #</th>
                  <th className="px-3 py-2">Fetch</th>
                  <th className="px-3 py-2">Parse</th>
                  <th className="px-3 py-2 text-right">Items</th>
                  <th className="px-3 py-2 text-right">Red / Yellow</th>
                  <th className="px-3 py-2">Discovered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.recent.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-gray-400">
                      No links yet.
                    </td>
                  </tr>
                )}
                {data.recent.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2">{row.provider}</td>
                    <td className="px-3 py-2">{row.shopId}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {row.vin || "—"}
                    </td>
                    <td className="px-3 py-2">{row.workOrderNumber || "—"}</td>
                    <td className="px-3 py-2">{statusBadge(row.fetchStatus)}</td>
                    <td className="px-3 py-2">{statusBadge(row.parseStatus)}</td>
                    <td className="px-3 py-2 text-right">
                      {row.itemCount ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.counts
                        ? `${row.counts.required} / ${row.counts.suggested}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {fmtDate(row.discoveredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
