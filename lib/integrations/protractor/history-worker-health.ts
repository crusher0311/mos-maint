export const HISTORY_WORKER_PROTOCOL = 2;
export const HISTORY_WORKER_FRESH_MS = 90_000;
export function historyWorkerHealth(state: any, now = Date.now()) {
  const worker = state?.fleetHistoryWorker;
  const seen = worker?.seenAt ? +new Date(worker.seenAt) : NaN;
  const fresh = Number.isFinite(seen) && seen <= now + 5000 && now - seen < HISTORY_WORKER_FRESH_MS;
  const revision = typeof worker?.revision === "string" && /^[a-f0-9]{40}$/.test(worker.revision) ? worker.revision : null;
  const status = !worker ? "not_reported" : !fresh ? "stale" :
    worker.protocol !== HISTORY_WORKER_PROTOCOL || !revision ? "upgrade_required" :
    worker.status === "stopped" ? "stopped" : worker.status === "failed" ? "failed" :
    worker.importsEnabled !== true ? "readiness_only" :
    worker.status === "running" ? "running" : worker.status === "blocked" ? "blocked" : "idle";
  return {
    status, ready: fresh && !!revision && worker?.protocol === HISTORY_WORKER_PROTOCOL && worker?.importsEnabled === true &&
      ["idle", "running", "blocked"].includes(worker?.status),
    lastSeenAt: Number.isFinite(seen) ? new Date(seen).toISOString() : null,
    revision,
  };
}
