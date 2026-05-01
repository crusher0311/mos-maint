/**
 * Detect Dog: Shop Migration — observability list page (T006).
 *
 * Server-rendered list of every Tekmetric shop-migration run. Operators
 * use this page to audit who ran what, when, and the resulting
 * source/dest counts. Click into a row for the detail view (audit log
 * + mapping JSON viewer).
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getDb } from "@/lib/db/drizzle";
import { tekmetricMigrationRuns } from "@/lib/db/schema/tekmetric-migration";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  created: "bg-gray-100 text-gray-700",
  dumping: "bg-amber-100 text-amber-800",
  dumped: "bg-blue-100 text-blue-800",
  loading_core: "bg-amber-100 text-amber-800",
  loaded_core: "bg-blue-100 text-blue-800",
  loading_extras: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
};

function formatDate(d: Date | string | null) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString();
}

function pickCount(counts: any, key: string): number | string {
  if (!counts || typeof counts !== "object") return "—";
  const v = counts[key];
  return typeof v === "number" ? v : "—";
}

export default async function TekmetricMigrationsListPage() {
  const db = getDb();
  const runs = await db
    .select()
    .from(tekmetricMigrationRuns)
    .orderBy(desc(tekmetricMigrationRuns.createdAt))
    .limit(200);

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tekmetric Shop Migrations</h1>
          <p className="text-sm text-gray-500">
            History of Detect Dog open-jobs migration runs. Dump and mapping
            payloads are retained for 30 days.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">Run</th>
              <th className="px-3 py-2 text-left">Source → Dest</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">ROs</th>
              <th className="px-3 py-2 text-right">Created</th>
              <th className="px-3 py-2 text-right">Reused</th>
              <th className="px-3 py-2 text-right">Failed</th>
              <th className="px-3 py-2 text-left">Operator</th>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td
                  colSpan={10}
                  className="px-3 py-6 text-center text-gray-500"
                >
                  No migration runs yet.
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr key={run.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-xs">#{run.id}</td>
                <td className="px-3 py-2">
                  <span className="font-medium">{run.sourceShopId}</span>
                  {run.sourceShopName ? (
                    <span className="text-gray-500"> ({run.sourceShopName})</span>
                  ) : null}
                  <span className="mx-1 text-gray-400">→</span>
                  <span className="font-medium">{run.destShopId}</span>
                  {run.destShopName ? (
                    <span className="text-gray-500"> ({run.destShopName})</span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      STATUS_BADGE[run.status] || "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {run.status}
                  </span>
                  {run.lastError ? (
                    <div
                      className="mt-1 text-xs text-rose-700 truncate max-w-xs"
                      title={run.lastError}
                    >
                      {run.lastError}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {pickCount(run.counts, "ros")}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {pickCount(run.counts, "rosCreated")}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {pickCount(run.counts, "rosReused")}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-rose-700">
                  {pickCount(run.counts, "rosFailed")}
                </td>
                <td className="px-3 py-2 text-xs text-gray-700">
                  {run.createdByEmail || run.createdBy}
                </td>
                <td className="px-3 py-2 text-xs text-gray-500">
                  {formatDate(run.createdAt)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      href={`/platform-admin/tekmetric-migrations/${run.id}#mapping`}
                      className="text-indigo-600 hover:text-indigo-800 text-xs"
                    >
                      View mapping
                    </Link>
                    <Link
                      href={`/platform-admin/tekmetric-migrations/${run.id}`}
                      className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 text-xs"
                    >
                      Detail
                      <ArrowRight className="w-3 h-3" />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
