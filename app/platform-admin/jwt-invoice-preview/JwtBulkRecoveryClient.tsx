"use client";

import { useEffect, useRef, useState } from "react";

type RecoveryStatus = {
  ok: true;
  status: "idle" | "running" | "paused" | "complete";
  total: number;
  processed: number;
  phase?: "collect" | "repair" | "complete";
  sourceScanned?: number;
  outcomes: { wo: string | number; state: string; reason?: string }[];
  error?: string;
};

function isRecoveryStatus(value: unknown): value is RecoveryStatus {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.ok === true &&
    ["idle", "running", "paused", "complete"].includes(String(data.status)) &&
    Number.isSafeInteger(data.total) && Number(data.total) >= 0 &&
    Number.isSafeInteger(data.processed) && Number(data.processed) >= 0 &&
    Number(data.processed) <= Number(data.total) &&
    (data.phase === undefined || ["collect", "repair", "complete"].includes(String(data.phase))) &&
    (data.sourceScanned === undefined || (Number.isSafeInteger(data.sourceScanned) && Number(data.sourceScanned) >= 0)) &&
    (data.error === undefined || typeof data.error === "string") &&
    Array.isArray(data.outcomes) && data.outcomes.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Record<string, unknown>;
      return (typeof row.wo === "string" || typeof row.wo === "number") &&
        typeof row.state === "string" &&
        (row.reason === undefined || typeof row.reason === "string");
    });
}

// A single serialized client session. Only an explicit run() enables writes.
// Kept independently testable without mounting or contacting the live endpoint.
export function createRecoverySession(options: {
  onStatus: (status: RecoveryStatus) => void;
  onError: (error: string | null) => void;
  onActivity: (activity: { running: boolean; busy: boolean; pausing: boolean }) => void;
  fetcher?: typeof fetch;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const fetcher = options.fetcher ?? fetch;
  const schedule = options.schedule ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
  let disposed = false;
  let running = false;
  let busy = false;
  let pendingPause = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: RecoveryStatus | null = null;

  function clearTimer() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }
  function notify() {
    if (!disposed) options.onActivity({ running, busy, pausing: pendingPause });
  }
  function stop(error: string) {
    running = false;
    pendingPause = false;
    clearTimer();
    if (!disposed) options.onError(error);
  }

  async function request(action?: "start" | "step" | "pause") {
    if (disposed || busy) return;
    busy = true;
    notify();
    let succeeded = false;
    try {
      const response = await fetcher("/api/platform-admin/jwt-september-recovery", {
        method: action ? "POST" : "GET",
        credentials: "include",
        cache: "no-store",
        headers: action
          ? { "content-type": "application/json", accept: "application/json" }
          : { accept: "application/json" },
        ...(action ? { body: JSON.stringify({ action }) } : {}),
      });
      if (disposed) return;
      if (!response.ok) {
        stop(response.status === 401 || response.status === 403
          ? "Access denied. Processing stopped; a platform-admin session is required."
          : response.status === 409
            ? "Recovery lease is busy. This page stopped; no duplicate step or automatic retry was sent. Refresh status before resuming."
            : "Recovery request failed. Processing stopped; check status before resuming. The last request may have reached the server.");
        return;
      }
      const payload: unknown = await response.json();
      if (disposed) return;
      if (!isRecoveryStatus(payload)) {
        stop("Invalid recovery response. Processing stopped; check status before resuming.");
        return;
      }
      current = payload;
      options.onStatus(payload);
      if (payload.error) {
        stop("The server reported a recovery error. Processing stopped; review the reported outcomes and refresh status before resuming.");
        return;
      }
      succeeded = true;
      if (payload.status !== "running") running = false;
    } catch {
      if (!disposed) stop("Connection or session error. Processing stopped; check status before resuming. The last request may have reached the server.");
    } finally {
      busy = false;
      if (!disposed) {
        if (succeeded && pendingPause && action !== "pause") {
          // Wait for the current transaction response before sending pause.
          void request("pause");
        } else {
          if (action === "pause") pendingPause = false;
          notify();
          if (succeeded && running && current?.status === "running") {
            timer = schedule(() => {
              timer = undefined;
              if (!disposed && running && !busy) void request("step");
            }, 1000);
          }
        }
      }
    }
  }

  return {
    refresh() {
      if (disposed || busy || running || pendingPause) return;
      options.onError(null);
      return request();
    },
    run() {
      if (disposed || busy || running || pendingPause || !current || current.status === "complete") return;
      clearTimer();
      options.onError(null);
      running = true;
      return request("start");
    },
    pause() {
      if (disposed || pendingPause || (!running && current?.status !== "running")) return;
      running = false;
      pendingPause = true;
      clearTimer();
      notify();
      if (!busy) return request("pause");
    },
    dispose() {
      disposed = true;
      running = false;
      clearTimer();
      // Do not abort an in-flight database transaction or issue unload writes.
      // The server checkpoint survives; a new page must explicitly resume.
    },
  };
}

export default function JwtBulkRecoveryClient() {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState({ running: false, busy: true, pausing: false });
  const session = useRef<ReturnType<typeof createRecoverySession> | null>(null);

  useEffect(() => {
    const client = createRecoverySession({
      onStatus: setStatus,
      onError: setError,
      onActivity: setActivity,
    });
    session.current = client;
    void client.refresh();
    const onPageHide = () => session.current?.dispose();
    // BFCache restoration must also stay read-only until the next explicit run.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        const restored = createRecoverySession({
          onStatus: setStatus, onError: setError, onActivity: setActivity,
        });
        session.current = restored;
        void restored.refresh();
      }
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      client.dispose();
      session.current?.dispose();
      session.current = null;
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return (
    <section aria-labelledby="september-recovery-title" className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <h2 id="september-recovery-title" className="text-lg font-semibold text-gray-900">September recovery · Run / Resume</h2>
      <p className="mt-1 text-sm text-gray-600">
        Location <strong>701</strong> · September <strong>2026</strong> remaining candidates.
        This separate recovery writes safe repairs automatically and holds conflicts.
        Existing customer and vehicle details are left untouched.
      </p>
      <p className="mt-2 text-sm text-amber-900">
        Keep this page open while running. Closing it stops client processing; resume uses the saved server checkpoint.
        Pause waits for the current piece to finish, not an aborted database transaction.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" onClick={() => void session.current?.run()}
          disabled={!status || activity.busy || activity.running || activity.pausing || status.status === "complete"}
          className="rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
          {activity.running ? "Running…" : status && (status.processed > 0 || status.status !== "idle") ? "Resume September recovery" : "Run September recovery"}
        </button>
        <button type="button" onClick={() => void session.current?.pause()}
          disabled={activity.pausing || (!activity.running && status?.status !== "running")}
          className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-800 disabled:cursor-not-allowed disabled:opacity-50">
          {activity.pausing ? "Pausing after current piece…" : "Pause"}
        </button>
        <button type="button" onClick={() => void session.current?.refresh()}
          disabled={activity.busy || activity.running || activity.pausing}
          className="px-2 py-2 text-sm font-medium text-blue-700 underline disabled:cursor-not-allowed disabled:opacity-50">
          Refresh status (read-only)
        </button>
      </div>
      {error && <p role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <div role="status" aria-live="polite" className="mt-4 text-sm text-gray-700">
        {status
          ? `${status.phase === "collect" ? `Collecting source invoices · ${status.sourceScanned ?? "Not yet reported"} source invoices scanned · ` : ""}${status.processed} of ${status.total} candidates processed · Server: ${status.status} · ${activity.pausing ? "Pause requested" : activity.running ? "This page is processing" : "This page is not processing"}`
          : activity.busy ? "Loading saved recovery status…" : "Recovery status unavailable. Refresh status to retry."}
      </div>
      {status && (
        <>
          <progress aria-label="Recovery candidates processed" value={status.processed} max={status.total || 1} className="mt-2 h-2 w-full accent-blue-700" />
          {status.status === "complete" && <p className="mt-2 text-sm text-gray-600">The server reports processing complete. Held exceptions may remain; this is not a reconciliation or verification of all invoices or labor totals.</p>}
          <h3 className="mt-4 text-sm font-semibold text-gray-900">Reported outcomes and held exceptions</h3>
          {status.outcomes.length === 0
            ? <p className="mt-1 text-sm text-gray-500">No work-order outcomes reported yet. This does not establish that there are no conflicts.</p>
            : <div className="mt-2 max-h-64 overflow-auto">
              <table className="min-w-full text-left text-sm">
                <caption className="sr-only">Server-reported recovery outcomes, including held exceptions and reasons</caption>
                <thead className="border-b border-gray-200 text-gray-500"><tr>
                  <th scope="col" className="px-2 py-2">Work order</th>
                  <th scope="col" className="px-2 py-2">State</th>
                  <th scope="col" className="px-2 py-2">Reason</th>
                </tr></thead>
                <tbody className="divide-y divide-gray-100 text-gray-800">{status.outcomes.map((row, index) => (
                  <tr key={`${row.wo}-${index}`}>
                    <td className="px-2 py-2 font-mono text-xs">{row.wo}</td>
                    <td className="px-2 py-2">{row.state}</td>
                    <td className="break-words px-2 py-2">{row.reason || "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>}
        </>
      )}
    </section>
  );
}
