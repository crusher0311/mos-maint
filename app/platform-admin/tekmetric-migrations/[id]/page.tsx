/**
 * Detect Dog: Shop Migration — observability detail page (T006).
 *
 * Shows full audit log + mapping JSON viewer for a single migration run.
 * Reads directly from Drizzle (not the extension API) because this page
 * runs server-side under the `requirePlatformAdmin()` session guard
 * inherited from `app/platform-admin/layout.tsx`.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getDb } from "@/lib/db/drizzle";
import {
  tekmetricMigrationRuns,
  tekmetricMigrationDumps,
  tekmetricMigrationMappings,
  tekmetricMigrationAudit,
} from "@/lib/db/schema/tekmetric-migration";
import { eq, desc } from "drizzle-orm";

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

function fmt(d: Date | string | null) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString();
}

export default async function TekmetricMigrationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const runId = Number(id);
  if (!runId) notFound();

  const db = getDb();
  const [run] = await db
    .select()
    .from(tekmetricMigrationRuns)
    .where(eq(tekmetricMigrationRuns.id, runId))
    .limit(1);
  if (!run) notFound();

  const [dump] = await db
    .select({
      id: tekmetricMigrationDumps.id,
      rosCount: tekmetricMigrationDumps.rosCount,
      expiresAt: tekmetricMigrationDumps.expiresAt,
      createdAt: tekmetricMigrationDumps.createdAt,
    })
    .from(tekmetricMigrationDumps)
    .where(eq(tekmetricMigrationDumps.runId, runId))
    .orderBy(desc(tekmetricMigrationDumps.createdAt))
    .limit(1);

  const [mapping] = await db
    .select()
    .from(tekmetricMigrationMappings)
    .where(eq(tekmetricMigrationMappings.runId, runId))
    .orderBy(desc(tekmetricMigrationMappings.createdAt))
    .limit(1);

  const audit = await db
    .select()
    .from(tekmetricMigrationAudit)
    .where(eq(tekmetricMigrationAudit.runId, runId))
    .orderBy(desc(tekmetricMigrationAudit.createdAt))
    .limit(500);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <Link
          href="/platform-admin/tekmetric-migrations"
          className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800"
        >
          <ArrowLeft className="w-4 h-4" />
          All migration runs
        </Link>
        <span className="text-xs text-gray-500 font-mono">run #{run.id}</span>
      </div>

      {/* Run header */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">
            Tekmetric {run.sourceShopId}{" "}
            <span className="text-gray-400">→</span> {run.destShopId}
          </h1>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
              STATUS_BADGE[run.status] || "bg-gray-100 text-gray-700"
            }`}
          >
            {run.status}
          </span>
        </div>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <dt className="text-xs text-gray-500">Operator</dt>
            <dd>{run.createdByEmail || run.createdBy}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Started</dt>
            <dd>{fmt(run.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Updated</dt>
            <dd>{fmt(run.updatedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Last phase</dt>
            <dd>{run.lastPhase || "—"}</dd>
          </div>
        </dl>
        {run.lastError ? (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 text-sm p-2 rounded">
            <b>Last error:</b> {run.lastError}
          </div>
        ) : null}
      </div>

      {/* Counts */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Counts</h2>
        <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto max-h-72">
{JSON.stringify(run.counts ?? {}, null, 2)}
        </pre>
      </div>

      {/* Dump + mapping summaries */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Dump</h2>
          {dump ? (
            <dl className="text-sm space-y-1">
              <div className="flex justify-between">
                <dt className="text-gray-500">ROs in dump</dt>
                <dd className="tabular-nums">{dump.rosCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Created</dt>
                <dd>{fmt(dump.createdAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Expires (30d)</dt>
                <dd>{fmt(dump.expiresAt)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-gray-500 italic">No dump persisted yet.</p>
          )}
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Mapping</h2>
          {mapping ? (
            <dl className="text-sm space-y-1">
              <div className="flex justify-between">
                <dt className="text-gray-500">Successes</dt>
                <dd className="tabular-nums text-emerald-700">
                  {mapping.successesCount}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Reused (already migrated)</dt>
                <dd className="tabular-nums">{mapping.reusedCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Failures</dt>
                <dd className="tabular-nums text-rose-700">
                  {mapping.failuresCount}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Confirmed</dt>
                <dd>{mapping.confirmed ? "Yes" : "Dry-run"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Expires (30d)</dt>
                <dd>{fmt(mapping.expiresAt)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-gray-500 italic">
              No mapping persisted yet (load-core has not been confirmed).
            </p>
          )}
        </div>
      </div>

      {/* Mapping JSON viewer */}
      {mapping ? (
        <div id="mapping" className="bg-white border border-gray-200 rounded-xl p-4 scroll-mt-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">
            Mapping JSON
          </h2>
          <details open>
            <summary className="cursor-pointer text-indigo-600 text-sm">
              Show full mapping payload
            </summary>
            <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto max-h-96 mt-2">
{JSON.stringify(mapping.mapping, null, 2)}
            </pre>
          </details>
          {Array.isArray(mapping.failures) && mapping.failures.length > 0 ? (
            <details className="mt-2" open>
              <summary className="cursor-pointer text-rose-700 text-sm">
                Failures ({mapping.failures.length})
              </summary>
              <pre className="text-xs bg-rose-50 p-3 rounded overflow-auto max-h-72 mt-2">
{JSON.stringify(mapping.failures, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {/* Audit log */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Audit log ({audit.length})
        </h2>
        <div className="overflow-auto max-h-[600px] border border-gray-100 rounded">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase sticky top-0">
              <tr>
                <th className="px-2 py-1 text-left">When</th>
                <th className="px-2 py-1 text-left">Phase</th>
                <th className="px-2 py-1 text-left">Action</th>
                <th className="px-2 py-1 text-left">Details</th>
              </tr>
            </thead>
            <tbody>
              {audit.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-2 py-4 text-center text-gray-400">
                    No audit entries.
                  </td>
                </tr>
              )}
              {audit.map((row) => (
                <tr key={row.id} className="border-t border-gray-100">
                  <td className="px-2 py-1 whitespace-nowrap text-gray-500">
                    {fmt(row.createdAt)}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap font-medium text-indigo-700">
                    {row.phase}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">{row.action}</td>
                  <td className="px-2 py-1">
                    <pre className="text-[10px] text-gray-600 max-w-2xl truncate">
                      {row.details
                        ? JSON.stringify(row.details).slice(0, 240)
                        : ""}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
