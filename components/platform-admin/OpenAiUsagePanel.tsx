"use client";

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { z } from "zod";

const metric = z.number().finite().nonnegative().nullable();
const metricsSchema = z.object({
  requests: metric,
  failedRequests: metric,
  promptTokens: metric,
  completionTokens: metric,
  cachedTokens: metric,
  estimatedCostUsd: metric,
  unpricedRequests: metric,
  unknownUsageRequests: metric,
  legacyRequests: metric,
});
const rowSchema = metricsSchema.extend({ name: z.union([z.string(), z.number(), z.null()]) });
const responseSchema = z.object({
  ok: z.literal(true),
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  totals: metricsSchema,
  byFeature: z.array(rowSchema),
  byModel: z.array(rowSchema),
  byShop: z.array(rowSchema),
  byDay: z.array(rowSchema),
  truncated: z.boolean(),
});
type Metrics = z.infer<typeof metricsSchema>;
type Usage = z.infer<typeof responseSchema>;
type Days = Usage["days"];

const number = (value: number | null) => value === null ? "Unknown" : value.toLocaleString();
const incompleteTokens = (row: Metrics) =>
  row.unknownUsageRequests === null || row.unknownUsageRequests > 0 ||
  row.legacyRequests === null || row.legacyRequests > 0;
const incompleteCost = (row: Metrics) =>
  incompleteTokens(row) || row.unpricedRequests === null || row.unpricedRequests > 0;
function cost(row: Metrics) {
  if (row.estimatedCostUsd === null || (row.estimatedCostUsd === 0 && incompleteCost(row))) return "Unknown";
  // Retain small recorded costs instead of rounding them to a misleading $0.00.
  const formatted = row.estimatedCostUsd > 0 && row.estimatedCostUsd < 0.000001
    ? "<$0.000001"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(row.estimatedCostUsd);
  return `${formatted}${incompleteCost(row) ? " (partial)" : ""}`;
}
function tokens(value: number | null, row: Metrics) {
  if (value === null || (value === 0 && incompleteTokens(row))) return "Unknown";
  return `${number(value)}${incompleteTokens(row) ? " (partial)" : ""}`;
}

function UsageTable({ title, label, rows }: {
  title: string;
  label: string;
  rows: Usage["byFeature"];
}) {
  const columns = [label, "Requests", "Failed", "Prompt tokens", "Completion tokens", "Cached tokens", "Estimated cost (USD)", "Unpriced", "Unknown usage", "Legacy"];
  return <div className="overflow-hidden rounded-lg border border-gray-200">
    <div className="overflow-x-auto" role="region" aria-label={title} tabIndex={0}>
      <table className="w-full text-left text-sm">
        <caption className="border-b border-gray-100 bg-gray-50 px-4 py-3 text-left font-semibold text-gray-900">{title}</caption>
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr>{columns.map((column, i) => <th key={column} scope="col" className={`whitespace-nowrap px-4 py-3 font-medium ${i ? "text-right" : ""}`}>{column}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-100 text-gray-700">
          {rows.map((row, i) => <tr key={`${row.name ?? "unassigned"}-${i}`} className="hover:bg-gray-50">
            <th scope="row" className="max-w-xs break-words px-4 py-3 font-mono text-xs font-medium text-gray-900">{row.name === null ? "Unassigned" : String(row.name)}</th>
            {[number(row.requests), number(row.failedRequests), tokens(row.promptTokens, row), tokens(row.completionTokens, row), tokens(row.cachedTokens, row), cost(row), number(row.unpricedRequests), number(row.unknownUsageRequests), number(row.legacyRequests)].map((value, index) =>
              <td key={index} className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{value}</td>)}
          </tr>)}
          {!rows.length && <tr><td colSpan={columns.length} className="px-4 py-6 text-center text-gray-500">No recorded {label.toLowerCase()} usage in this window. This does not establish zero historical usage.</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}

/** Intentionally manual: mounting this panel never queries fleet usage or starts polling. */
export default function OpenAiUsagePanel() {
  const [days, setDays] = useState<Days>(30);
  const [data, setData] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function load() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setData(null);
    setError(null);
    try {
      const response = await fetch(`/api/platform-admin/openai-usage?days=${days}`, {
        credentials: "include", cache: "no-store", signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (!response.ok || (typeof body === "object" && body !== null && "ok" in body && body.ok === false)) {
        const detail = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "Please try again.";
        throw new Error(`Unable to load OpenAI usage. ${detail}`);
      }
      const parsed = responseSchema.safeParse(body);
      if (!parsed.success || parsed.data.days !== days) throw new Error("OpenAI usage returned an unexpected response. Please retry.");
      if (!controller.signal.aborted) setData(parsed.data);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load OpenAI usage. Please retry.");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <section aria-labelledby="openai-usage-heading" className="rounded-xl border border-gray-100 bg-white shadow-sm">
    <div className="flex flex-col gap-4 border-b border-gray-100 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 id="openai-usage-heading" className="text-lg font-semibold text-gray-900">OpenAI usage &amp; estimated spend</h2>
        <p className="mt-1 text-sm text-gray-500">Recorded telemetry only. Loaded on demand, never auto-refreshed.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-600" htmlFor="openai-usage-days">Window</label>
        <select id="openai-usage-days" value={days} disabled={busy}
          onChange={event => { setDays(Number(event.target.value) as Days); setData(null); setError(null); }}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:opacity-50">
          <option value={1}>Last day</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
        </select>
        <button type="button" disabled={busy} onClick={() => void load()}
          className="flex items-center gap-2 rounded-lg bg-[rgba(60,129,195,0.75)] px-3 py-2 text-sm text-white hover:bg-[#3c81c3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50">
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          {busy ? "Loading AI spend…" : error ? "Retry AI spend" : data ? "Refresh AI spend" : "Load AI spend"}
        </button>
      </div>
    </div>
    <div className="space-y-4 p-4">
      <p className="text-sm text-gray-600">Costs are estimates from recorded usage, not an OpenAI bill. Historical incomplete telemetry cannot be reconstructed. Unknown usage or pricing is not free usage. Cached tokens are a subset of prompt tokens; do not add them again.</p>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
      {busy && <div role="status" aria-live="polite" className="space-y-3">
        <span className="sr-only">Loading recorded OpenAI usage</span>
        <div aria-hidden="true" className="animate-pulse space-y-3"><div className="h-20 rounded-lg bg-gray-100" /><div className="h-32 rounded-lg bg-gray-100" /></div>
      </div>}
      {!busy && !data && !error && <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-sm text-gray-600">
        Choose a window, then load AI spend to inspect recorded requests, token usage, and estimated costs by feature, model, shop, and day.
      </div>}
      {data && <>
        <p className="text-xs text-gray-500">Recorded window: {new Date(data.from).toISOString()} to {new Date(data.to).toISOString()} (UTC).</p>
        <div role="status" className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Telemetry coverage{incompleteCost(data.totals) ? " is incomplete" : " is limited to recorded requests"}</p>
            <p>Unpriced requests: {number(data.totals.unpricedRequests)} · Unknown usage: {number(data.totals.unknownUsageRequests)} · Legacy requests: {number(data.totals.legacyRequests)}.</p>
            <p>These categories may overlap. Partial totals exclude unknown values; even zero missing-record counts cannot prove historical completeness.</p>
            {data.truncated && <p className="font-semibold">Results truncated: additional records were not included. All totals and breakdowns shown are partial, not fleet-wide totals.</p>}
          </div>
        </div>
        {data.totals.requests === 0 && <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">No OpenAI requests were recorded in this window. This is not confirmation of zero spend.</p>}
        <dl className="grid grid-cols-1 gap-4 rounded-lg border border-gray-200 bg-gray-50 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Recorded requests", number(data.totals.requests)],
            ["Failed requests", number(data.totals.failedRequests)],
            ["Estimated cost (USD)", cost(data.totals)],
            ["Recorded tokens (prompt / completion)", `${tokens(data.totals.promptTokens, data.totals)} / ${tokens(data.totals.completionTokens, data.totals)}`],
          ].map(([label, value]) => <div key={label}><dt className="text-xs text-gray-500">{label}</dt><dd className="mt-1 break-words text-lg font-semibold tabular-nums text-gray-900">{value}</dd></div>)}
        </dl>
        <p className="text-xs text-gray-500">Feature names are stable route identifiers. Shops are numeric IDs or Unassigned; no shop-name lookup is performed. All token counts are recorded values.</p>
        <UsageTable title="By feature" label="Feature" rows={data.byFeature} />
        <UsageTable title="By model" label="Model" rows={data.byModel} />
        <UsageTable title="By shop" label="Shop" rows={data.byShop} />
        <UsageTable title="By day (UTC)" label="Day" rows={data.byDay} />
      </>}
    </div>
  </section>;
}
