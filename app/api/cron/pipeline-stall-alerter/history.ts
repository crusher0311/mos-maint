import { WEEKEND, validateWeekendGrant } from "@/lib/protractor-weekend-policy";

const ms = (v: unknown): number => {
  if (!(v instanceof Date) && typeof v !== "string") return 0;
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
};

/** Only outcome evidence resets the clock. Captures, held cursors and leases do not. */
export function historyHealth(job: any, state: any, previous: any, now: number, windowMs: number) {
  const grant = state?.weekendHistory;
  let validGrant = false;
  try { validateWeekendGrant(grant); validGrant = true; } catch {}
  const active = validGrant && job?._id === WEEKEND.id && job.stopped === false &&
    job.status === "running" && job.runId === grant.runId && job.owner === grant.owner &&
    job.canaryGeneration === grant.canaryGeneration &&
    grant.canaryGeneration === state?.canary?.generation &&
    state?.operatorStop?.active === false && state?.canary?.mode === "live" &&
    state.canary.scope === "callbacks_and_interactive" && state.canary.requiresRelay === true &&
    state.canary.workersSuspendedConfirmed === true && !state.canary.endedBy &&
    now >= ms(grant.notBefore) && now < ms(grant.expiresAt) &&
    now < ms(job.expiresAt) && now < ms(job.leaseUntil) && now < ms(grant.runnerLeaseUntil);
  // stopped on the dispatch grant is normal between requests and during cooldown.
  // It is NOT an operator cancellation; job.stopped and operatorStop are authoritative.
  const signals = {
    heartbeatAt: ms(job?.heartbeatAt),
    heldDayAdvanceAt: ms(job?.heldDayAdvanceAt),
    capturedPageAt: ms(job?.capturedPageAt),
    verifiedPresentAt: ms(job?.verifiedPresentAt),
    importedInvoiceAt: ms(job?.importedInvoiceAt),
    completedPageAt: ms(job?.completedPageAt),
  };
  const lastRealProgressAt = Math.max(signals.verifiedPresentAt, signals.importedInvoiceAt, signals.completedPageAt);
  const waiting = active && ms(job.callbackWaitUntil) > now;
  const sameRun = previous?.runId === job?.runId;
  // New/re-activated campaigns and callback yields receive a full eligible window.
  const baselineAt = !active || waiting || !sameRun || !previous?.active
    ? now : ms(previous.baselineAt) || now;
  const stalledMs = Math.max(0, now - Math.max(baselineAt, lastRealProgressAt));
  return {
    active: Boolean(active), waiting: Boolean(waiting), baselineAt: new Date(baselineAt),
    runId: job?.runId, signals, lastRealProgressAt: lastRealProgressAt || null,
    stalledMs, stalled: Boolean(active && !waiting && stalledMs >= windowMs),
  };
}
