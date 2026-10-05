"use client";

import Link from "next/link";
import { useRef, useState } from "react";

type InvoiceRow = {
  workOrderNumber: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  type: string;
  comparison: string;
};

type PreviewResult = {
  ok: true;
  partial: boolean;
  rows: InvoiceRow[];
  nativeCount: number;
  returnedCount: number;
};

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPreviewResult(value: unknown): value is PreviewResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    result.ok === true &&
    typeof result.partial === "boolean" &&
    typeof result.nativeCount === "number" &&
    Number.isSafeInteger(result.nativeCount) &&
    result.nativeCount >= 0 &&
    typeof result.returnedCount === "number" &&
    Number.isSafeInteger(result.returnedCount) &&
    result.returnedCount >= 0 &&
    Array.isArray(result.rows) &&
    result.rows.every((row: unknown) => {
      if (!row || typeof row !== "object") return false;
      const invoice = row as Record<string, unknown>;
      return (
        isNullableString(invoice.workOrderNumber) &&
        isNullableString(invoice.invoiceNumber) &&
        isNullableString(invoice.invoiceDate) &&
        typeof invoice.type === "string" &&
        typeof invoice.comparison === "string"
      );
    })
  );
}

export default function JwtInvoicePreviewClient() {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function runPreview(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/platform-admin/jwt-invoice-preview", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const blocked = await response.json().catch(() => null);
        const safeErrors = [
          "Current production policy does not permit this authenticated interactive read. No provider request was made.",
          "JWT membership for location 701 could not be verified.",
          "Approved relay transport is not active.",
          "A preview is already running on this server.",
          "The shared adapter declined or failed the read. No repair was attempted.",
        ];
        setError(
          response.status === 401 || response.status === 403
            ? "Access denied. A platform-admin session is required."
            : safeErrors.includes(blocked?.error) ? blocked.error
              : "The invoice preview request failed. Nothing was retried automatically.",
        );
        return;
      }
      const payload: unknown = await response.json();
      if (!isPreviewResult(payload)) {
        // Do not expose raw server errors, upstream response bodies, or credentials.
        setError("The invoice preview was unsuccessful or returned an invalid response. Nothing was retried automatically.");
        return;
      }
      setResult(payload);
    } catch {
      setError("The invoice preview could not be loaded. Check your connection or session before trying again. Nothing was retried automatically.");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <header>
        <Link
          href="/platform-admin/protractor-operator-stop"
          className="text-sm font-medium text-blue-700 underline underline-offset-4 hover:text-blue-800"
        >
          Back to Protractor operator controls
        </Link>
        <h1 className="mt-3 text-2xl font-bold text-gray-900">JWT invoice recovery preview</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-600">
          Admin-only, read-only inspection of invoices in one fixed recovery scope.
          The preview runs only when you explicitly request it.
        </p>
      </header>

      <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <h2 className="font-semibold">Fixed scope · no writes / no repairs</h2>
        <p className="mt-1">
          Location <strong>701</strong> (shop <strong>227</strong>) · <strong>September 1, 2026</strong>.
          This page cannot widen that scope. Results may be partial and must not be treated as a complete recovery inventory.
        </p>
        <p className="mt-2">
          This preview performs no writes and no repairs. Comparison reflects the stored snapshot,
          not reconciled live labor totals.
        </p>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Request invoice preview</h2>
            <p className="mt-1 text-sm text-gray-600">
              One request per click. No automatic fetching, polling, or retries.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runPreview()}
            disabled={loading}
            aria-controls="invoice-preview-results"
            className="rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Loading preview…" : "Run read-only preview"}
          </button>
        </div>
      </section>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      <section id="invoice-preview-results" aria-busy={loading} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Preview results</h2>
        <div role="status" aria-live="polite" className="mt-2 text-sm text-gray-600">
          {loading
            ? "Loading invoices for location 701, shop 227, September 1, 2026…"
            : result
              ? `Native count: ${result.nativeCount} · Returned count: ${result.returnedCount} · Displayed rows: ${result.rows.length}`
              : error
                ? "No preview results available. Use the button above to explicitly request another preview."
                : "No preview requested. Review the fixed scope above, then run the read-only preview."}
        </div>

        {loading && (
          <div aria-hidden="true" className="mt-4 space-y-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-9 rounded bg-slate-100" />
            ))}
          </div>
        )}

        {result && (
          <>
            {result.partial && (
              <div role="status" className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <strong>Partial preview.</strong> Only part of the fixed scope was returned.
                Missing rows do not establish that an invoice does not exist. No additional requests will run automatically.
              </div>
            )}
            {!result.partial && (
              <p className="mt-3 text-xs text-gray-500">The API did not flag this preview as partial. Results remain limited to the fixed scope.</p>
            )}
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <caption className="sr-only">
                  Invoice preview for location 701, shop 227, September 1, 2026. Comparison is a stored snapshot, not reconciled live labor totals.
                </caption>
                <thead className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="px-2 py-2">Work order</th>
                    <th scope="col" className="px-2 py-2">Invoice</th>
                    <th scope="col" className="px-2 py-2">Invoice date</th>
                    <th scope="col" className="px-2 py-2">Type</th>
                    <th scope="col" className="px-2 py-2">Comparison (stored snapshot)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-800">
                  {result.rows.map((row, index) => (
                    <tr key={index}>
                      <td className="px-2 py-3 font-mono text-xs">{row.workOrderNumber ?? "—"}</td>
                      <td className="px-2 py-3 font-mono text-xs">{row.invoiceNumber ?? "—"}</td>
                      <td className="whitespace-nowrap px-2 py-3">{row.invoiceDate ?? "—"}</td>
                      <td className="px-2 py-3">{row.type}</td>
                      <td className="min-w-48 whitespace-pre-wrap break-words px-2 py-3">{row.comparison}</td>
                    </tr>
                  ))}
                  {result.rows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-2 py-6 text-center text-gray-500">
                        No invoice rows returned for this fixed scope.
                        {result.partial && " This partial result does not establish that no invoices exist."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
