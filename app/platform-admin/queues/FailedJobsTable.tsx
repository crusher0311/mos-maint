"use client";

// Client-side failed-jobs table for the queue dashboard (task #567).
// Renders the dead-lettered jobs and a per-row "Retry" button that POSTs
// to /api/platform-admin/queues. On success the row is removed from the
// local list and the page is refreshed so the queue counts re-read.

import { useRouter } from "next/navigation";
import { useState } from "react";

export type FailedJobRow = {
  id: string;
  name: string;
  queue: string;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: number;
  data: any;
};

export default function FailedJobsTable({ jobs }: { jobs: FailedJobRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const rowKey = (j: FailedJobRow) => `${j.queue}:${j.id}`;

  async function retry(j: FailedJobRow) {
    setError(null);
    setPending(rowKey(j));
    try {
      const res = await fetch("/api/platform-admin/queues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry", queue: j.queue, jobId: j.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.ok) {
        setError(
          `Retry failed for ${j.queue}:${j.id} — ${
            body?.message || body?.error || res.statusText
          }`,
        );
        return;
      }
      setDone((prev) => new Set(prev).add(rowKey(j)));
      // Re-read server counts so the failed/waiting numbers update.
      router.refresh();
    } catch (err: any) {
      setError(`Retry request error: ${String(err?.message || err)}`);
    } finally {
      setPending(null);
    }
  }

  if (jobs.length === 0) {
    return (
      <p className="text-sm text-gray-500">No failed jobs. 🎉</p>
    );
  }

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="overflow-x-auto border rounded-lg">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Queue</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Job</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Attempts</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Failed reason</th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">Failed at</th>
              <th className="px-3 py-2 text-right font-medium text-gray-600">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {jobs.map((j) => {
              const key = rowKey(j);
              const isDone = done.has(key);
              return (
                <tr key={key} className={isDone ? "opacity-50" : "hover:bg-gray-50"}>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700">{j.queue}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700">
                    <div>{j.id}</div>
                    <div className="text-gray-400">{j.name}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{j.attemptsMade}</td>
                  <td className="px-3 py-2 text-xs text-red-700 max-w-md truncate" title={j.failedReason || ""}>
                    {j.failedReason || "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {j.timestamp ? new Date(j.timestamp).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {isDone ? (
                      <span className="text-xs text-green-600 font-medium">re-enqueued</span>
                    ) : (
                      <button
                        onClick={() => retry(j)}
                        disabled={pending === key}
                        className="px-3 py-1 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {pending === key ? "Retrying…" : "Retry"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
