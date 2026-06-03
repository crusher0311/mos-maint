// Platform-admin dashboard for the BullMQ backfill worker queue
// (task #513 scaffold, dashboard + retry action wired in task #567).
//
// This is the JSON+React admin page that replaces BullBoard. It renders:
//   1. A pre-cutover readiness panel (Redis reachable? workers up? what
//      will the flags do right now?) — the go/no-go an operator needs
//      before routing a shop.
//   2. Per-queue counts (waiting / active / delayed / failed / completed).
//   3. The "needs-human" failed-jobs bucket with a per-row Retry action.
//
// Runs in the web service, so it calls the queue lib functions directly
// (same process) rather than fetching its own API route.
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { isQueueEnabled } from "@/lib/queue/connection";
import { getAllQueueSnapshots, getFailedJobs } from "@/lib/queue/metrics";
import { getQueueReadiness } from "@/lib/queue/readiness";
import { ALL_QUEUE_NAMES } from "@/lib/queue/queues";
import FailedJobsTable, { type FailedJobRow } from "./FailedJobsTable";

export const dynamic = "force-dynamic";

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
        ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
      }`}
    >
      {label}
    </span>
  );
}

export default async function QueuesPage() {
  const session = await requireSession();
  if (session.role !== "platform_admin") redirect("/admin");

  const enabled = isQueueEnabled();

  if (!enabled) {
    const readiness = await getQueueReadiness();
    return (
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">
          Backfill Worker Queue
        </h1>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-medium">Queue not enabled in this environment.</p>
          <p className="mt-1">
            <code>REDIS_URL</code> is not set, so every shop runs on the legacy
            in-process backfill path. See{" "}
            <code>docs/runbooks/worker-queue-cutover.md</code> to provision
            Redis and deploy the worker.
          </p>
        </div>

        <h2 className="mt-6 mb-2 text-lg font-medium text-gray-900">
          Readiness check
        </h2>
        <ReadinessPanel readiness={readiness} />
      </div>
    );
  }

  const [readiness, snapshots] = await Promise.all([
    getQueueReadiness(),
    getAllQueueSnapshots(),
  ]);

  const failedJobs: FailedJobRow[] = [];
  for (const name of ALL_QUEUE_NAMES) {
    const fj = await getFailedJobs(name, 20);
    if (fj && fj.length > 0) {
      for (const j of fj) failedJobs.push({ ...j, queue: name });
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Backfill Worker Queue
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            BullMQ-backed Tekmetric/Protractor backfill. Counts are live.
          </p>
        </div>
        <div>
          <StatusPill ok={readiness.ok} label={readiness.ok ? "READY" : "NOT READY"} />
        </div>
      </div>

      <h2 className="mb-2 text-lg font-medium text-gray-900">Readiness check</h2>
      <ReadinessPanel readiness={readiness} />

      <h2 className="mt-8 mb-2 text-lg font-medium text-gray-900">Queues</h2>
      <div className="overflow-x-auto border rounded-lg mb-8">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Queue</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Waiting</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Active</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Delayed</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Failed</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Completed</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Paused</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {snapshots.map((s) => (
              <tr key={s.name} className="hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-xs text-gray-700">{s.name}</td>
                {s.counts ? (
                  <>
                    <td className="px-3 py-2 text-right font-mono">{s.counts.waiting}</td>
                    <td className="px-3 py-2 text-right font-mono">{s.counts.active}</td>
                    <td className="px-3 py-2 text-right font-mono">{s.counts.delayed}</td>
                    <td className="px-3 py-2 text-right font-mono text-red-700">{s.counts.failed}</td>
                    <td className="px-3 py-2 text-right font-mono text-green-700">{s.counts.completed}</td>
                    <td className="px-3 py-2 text-right font-mono">{s.counts.paused}</td>
                  </>
                ) : (
                  <td colSpan={6} className="px-3 py-2 text-xs text-gray-400 italic">
                    counts unavailable{s.error ? ` (${s.error})` : ""}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mb-2 text-lg font-medium text-gray-900">
        Failed jobs (needs human)
      </h2>
      <FailedJobsTable jobs={failedJobs} />
    </div>
  );
}

function ReadinessPanel({
  readiness,
}: {
  readiness: Awaited<ReturnType<typeof getQueueReadiness>>;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="border rounded-lg p-4">
        <div className="text-xs uppercase text-gray-500 mb-2">Redis</div>
        <div className="flex items-center gap-2">
          <StatusPill
            ok={readiness.redis.reachable}
            label={readiness.redis.reachable ? "reachable" : "unreachable"}
          />
          {readiness.redis.pingMs != null && (
            <span className="text-xs text-gray-500">{readiness.redis.pingMs}ms</span>
          )}
        </div>
        <div className="mt-2 text-xs text-gray-500">
          URL set: {readiness.redis.urlSet ? "yes" : "no"}
        </div>
        {readiness.redis.error && (
          <div className="mt-1 text-xs text-red-600">{readiness.redis.error}</div>
        )}
      </div>

      <div className="border rounded-lg p-4">
        <div className="text-xs uppercase text-gray-500 mb-2">Workers</div>
        <div className="flex items-center gap-2">
          <StatusPill
            ok={readiness.workers.allQueuesCovered}
            label={`${readiness.workers.totalConsuming} consuming`}
          />
        </div>
        <ul className="mt-2 space-y-0.5">
          {readiness.workers.perQueue.map((q) => (
            <li key={q.name} className="text-xs text-gray-600 font-mono">
              {q.name}: {q.workerCount}
              {q.error ? ` (${q.error})` : ""}
            </li>
          ))}
        </ul>
      </div>

      <div className="border rounded-lg p-4">
        <div className="text-xs uppercase text-gray-500 mb-2">Flags</div>
        <div className="text-xs text-gray-700">
          Mode: <span className="font-mono">{readiness.flags.effectiveMode}</span>
        </div>
        <ul className="mt-2 space-y-0.5">
          {readiness.flags.decisions.map((d) => (
            <li key={d.shopId} className="text-xs text-gray-600">
              <span className={d.useQueue ? "text-green-700" : "text-gray-500"}>
                {d.useQueue ? "→ queue" : "→ legacy"}
              </span>{" "}
              <span className="font-mono">({d.reason})</span> — {d.label}
            </li>
          ))}
        </ul>
      </div>

      {(readiness.blockers.length > 0 || readiness.warnings.length > 0) && (
        <div className="md:col-span-3 space-y-2">
          {readiness.blockers.map((b, i) => (
            <div
              key={`b-${i}`}
              className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
            >
              ⛔ {b}
            </div>
          ))}
          {readiness.warnings.map((w, i) => (
            <div
              key={`w-${i}`}
              className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800"
            >
              ⚠️ {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
