// app/dashboard/vehicles/[vin]/recommend/page.tsx
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import Link from "next/link";
import { MODELS, DEFAULT_MODEL } from "@/lib/ai";
import React from "react";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ vin: string }> };

export default async function VehicleRecommendPage({ params }: PageProps) {
  const session = await requireSession();
  const db = await getDb();
  const shopId = Number(session.shopId);

  const { vin: v } = await params;
  const vin = String(v || "").toUpperCase();

  const vehicle = await db.collection("vehicles").findOne(
    { shopId, vin },
    { projection: { year: 1, make: 1, model: 1, lastMileage: 1 } }
  );

  const headerLine = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || "Vehicle";

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-sm text-neutral-600">
            <Link href={`/dashboard/vehicles/${vin}`} className="underline">← Back</Link>
          </div>
          <h1 className="text-2xl font-bold truncate">{headerLine} — Recommended</h1>
          <div className="text-sm text-neutral-600">
            VIN <code>{vin}</code>
            {typeof vehicle?.lastMileage === "number" && <> • Current: {vehicle.lastMileage.toLocaleString()} mi</>}
          </div>
        </div>
      </div>

      {/* Client runner */}
      <Runner vin={vin} shopId={shopId} />
    </main>
  );
}

/* ---------------- Client component ---------------- */
function Runner({ vin, shopId }: { vin: string; shopId: number }) {
  "use client";
  const [model, setModel] = React.useState<string>(DEFAULT_MODEL);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [payload, setPayload] = React.useState<any>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/vehicle-analyzer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vin, shopId, model }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setError(json?.error || `HTTP ${res.status}`);
      }
      setPayload(json);
    } catch (e: any) {
      setError(e?.message || "Failed to run analyzer");
    } finally {
      setLoading(false);
    }
  }

  const recs: Array<{
    title: string; priority: number; urgency?: "overdue"|"soon"|"upcoming"|null;
    sources?: string[]; estimatedCostNote?: string|null; why: string;
  }> = payload?.data?.recommendations || [];

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border p-4 flex flex-wrap items-center gap-3">
        <div className="text-sm font-medium">Model</div>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        <button
          onClick={run}
          disabled={loading}
          className="rounded bg-black text-white px-3 py-1 text-sm disabled:opacity-50"
        >
          {loading ? "Running…" : "Run"}
        </button>

        {payload?.model && (
          <div className="text-xs text-neutral-500">Last run model: <code>{payload.model}</code></div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border p-4 text-sm text-red-600">
          {error}
        </div>
      )}

      {payload && !error && (
        <>
          <div className="rounded-2xl border p-4 bg-neutral-50 text-sm">
            <div className="font-medium mb-1">Advisor Notes</div>
            <div className="whitespace-pre-wrap">
              {payload?.data?.notesForAdvisor || "—"}
            </div>
          </div>

          {recs.length === 0 ? (
            <div className="rounded-xl border p-4 text-sm text-neutral-600">
              No recommendations returned.
            </div>
          ) : (
            <ol className="space-y-3">
              {recs
                .slice()
                .sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999))
                .map((r, i) => (
                  <li key={`${r.title}-${i}`} className="rounded-xl border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium">
                          {i + 1}. {r.title}
                        </div>
                        <div className="mt-1 text-xs text-neutral-600">
                          Priority: <span className="font-medium">{r.priority}</span>
                          {r.urgency ? <> | Urgency: <span className="uppercase tracking-wide">{r.urgency}</span></> : null}
                          {Array.isArray(r.sources) && r.sources.length > 0 && <> | Sources: {r.sources.join(", ")}</>}
                        </div>
                      </div>
                      {r.estimatedCostNote && (
                        <div className="text-xs rounded-full border px-2 py-0.5">
                          {r.estimatedCostNote}
                        </div>
                      )}
                    </div>

                    <div className="text-sm mt-2">{r.why}</div>
                  </li>
                ))}
            </ol>
          )}

          <details className="mt-6">
            <summary className="cursor-pointer">Raw JSON</summary>
            <pre className="mt-2 text-xs bg-gray-50 p-3 rounded overflow-auto max-h-96">
              {JSON.stringify(payload?.data, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
