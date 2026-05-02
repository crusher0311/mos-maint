"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2, MessageCircleQuestion, RotateCcw } from "lucide-react";

interface StatItem {
  scope: "shop" | "global";
  shopId: string | null;
  symptomCategory: string;
  normalizedQuestion: string;
  question: string;
  asked: number;
  skipped: number;
  answered: number;
  skipRate: number;
  lastUpdated: string | null;
}

interface CategoryGroup {
  category: string;
  totalAsked: number;
  totalSkipped: number;
  skipRate: number;
  items: StatItem[];
}

interface ApiResponse {
  ok: boolean;
  minAsked: number;
  shopId: string | null;
  knownShopIds: string[];
  shop: CategoryGroup[];
  global: CategoryGroup[];
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function rateClass(rate: number): string {
  if (rate >= 0.6) return "bg-red-100 text-red-700";
  if (rate >= 0.4) return "bg-amber-100 text-amber-700";
  return "bg-emerald-100 text-emerald-700";
}

function CategorySection({
  groups,
  scopeLabel,
  onReset,
  resettingKey,
}: {
  groups: CategoryGroup[];
  scopeLabel: string;
  onReset: (item: StatItem) => void;
  resettingKey: string | null;
}) {
  if (!groups.length) {
    return (
      <div className="text-sm text-gray-500 italic px-4 py-6">
        No questions in this scope yet have been asked enough times to show up.
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <div key={g.category} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div>
              <div className="font-semibold text-gray-900">{g.category}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {g.totalSkipped} skipped / {g.totalAsked} asked
                <span className={`ml-2 inline-block px-2 py-0.5 rounded ${rateClass(g.skipRate)}`}>
                  {pct(g.skipRate)} overall skip rate
                </span>
              </div>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-white text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Question</th>
                <th className="text-right px-4 py-2 w-20">Asked</th>
                <th className="text-right px-4 py-2 w-20">Skipped</th>
                <th className="text-right px-4 py-2 w-24">Skip Rate</th>
                <th className="text-left px-4 py-2 w-44">Last Updated</th>
                <th className="text-right px-4 py-2 w-24">Reset</th>
              </tr>
            </thead>
            <tbody>
              {g.items.map((it) => {
                const key = `${scopeLabel}|${it.symptomCategory}|${it.normalizedQuestion}`;
                const isResetting = resettingKey === key;
                return (
                  <tr key={key} className="border-t border-gray-100 align-top">
                    <td className="px-4 py-2 text-gray-900">{it.question}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{it.asked}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{it.skipped}</td>
                    <td className="px-4 py-2 text-right">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${rateClass(it.skipRate)}`}>
                        {pct(it.skipRate)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-600 text-xs">{fmtDate(it.lastUpdated)}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => onReset(it)}
                        disabled={isResetting}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                        title="Clear stats for this question in this scope"
                      >
                        {isResetting ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3 h-3" />
                        )}
                        Reset
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export default function ConcernSkipStatsPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [shopId, setShopId] = useState<string>("");
  const [minAsked, setMinAsked] = useState<number>(3);
  const [resettingKey, setResettingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (shopId.trim()) params.set("shopId", shopId.trim());
      params.set("minAsked", String(minAsked));
      const res = await fetch(`/api/admin/concern-skip-stats?${params.toString()}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Failed (${res.status})`);
      }
      const j: ApiResponse = await res.json();
      setData(j);
    } catch (e: any) {
      setError(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [shopId, minAsked]);

  useEffect(() => {
    load();
  }, [load]);

  const handleReset = async (item: StatItem) => {
    const scopeLabel =
      item.scope === "global" ? "global" : `shop ${item.shopId}`;
    if (
      !confirm(
        `Reset stats for this question in ${scopeLabel}?\n\n"${item.question}"\n\nThis clears ${item.asked} asked / ${item.skipped} skipped.`,
      )
    ) {
      return;
    }
    const key = `${item.scope === "global" ? "global" : "shop"}|${item.symptomCategory}|${item.normalizedQuestion}`;
    try {
      setResettingKey(key);
      const res = await fetch("/api/admin/concern-skip-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset",
          shopId: item.scope === "global" ? "global" : item.shopId,
          symptomCategory: item.symptomCategory,
          question: item.question,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Reset failed (${res.status})`);
      }
      await load();
    } catch (e: any) {
      alert(e.message || "Reset failed");
    } finally {
      setResettingKey(null);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <MessageCircleQuestion className="w-6 h-6 text-blue-600" />
            Concern Assistant — Skipped Questions
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Which AI follow-up questions advisors leave blank, broken down by
            symptom category. Use this to spot dead phrasings and decide which
            entries to retire from the seed guide.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Shop ID (blank = global only)
          </label>
          <input
            type="text"
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            placeholder="e.g. 12345"
            list="known-shop-ids"
            className="border border-gray-300 rounded px-2 py-1.5 text-sm w-48"
          />
          {data?.knownShopIds.length ? (
            <datalist id="known-shop-ids">
              {data.knownShopIds.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          ) : null}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Min times asked
          </label>
          <input
            type="number"
            min={1}
            value={minAsked}
            onChange={(e) => setMinAsked(Math.max(1, Number(e.target.value) || 1))}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm w-24"
          />
        </div>
        <div className="text-xs text-gray-500 ml-auto">
          {data?.knownShopIds.length ?? 0} shop{(data?.knownShopIds.length ?? 0) === 1 ? "" : "s"} have recorded stats so far.
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading…
        </div>
      ) : data ? (
        <div className="space-y-10">
          {shopId.trim() && (
            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">
                Shop {shopId.trim()}
              </h2>
              <CategorySection
                groups={data.shop}
                scopeLabel="shop"
                onReset={handleReset}
                resettingKey={resettingKey}
              />
            </section>
          )}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">
              Global (across all shops)
            </h2>
            <CategorySection
              groups={data.global}
              scopeLabel="global"
              onReset={handleReset}
              resettingKey={resettingKey}
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}
