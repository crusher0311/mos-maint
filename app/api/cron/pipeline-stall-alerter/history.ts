import { WEEKEND, validateWeekendGrant } from "@/lib/protractor-weekend-policy";
import { AVID_HISTORY, validateAvidGrant } from "@/lib/protractor-avid-history-policy";
import { AFTON_PILOT, validateAftonGrant } from "@/lib/protractor-afton-pilot-policy";
import { HISTORY_SHOP, validateHistoryGrant } from "@/lib/protractor-shop-history-policy";

export const HISTORY_CAMPAIGNS = [
  WEEKEND.id, AVID_HISTORY.jobId, AFTON_PILOT.jobId, "shop538-history-2026-10-08",
] as const;

/** These one-use grants have no runner leases or grant owner. Do not invent
 * weekend authority for them, or extend their fixed policy dates. */
function legacyActive(job: any, state: any, now: number): boolean {
  const policy = job?._id === AVID_HISTORY.jobId
    ? { field: "avidHistory", version: 3, shopId: AVID_HISTORY.shopId, validate: validateAvidGrant }
    : job?._id === AFTON_PILOT.jobId
    ? { field: "aftonPilot", version: 2, shopId: AFTON_PILOT.shopId, validate: validateAftonGrant }
    : job?._id === HISTORY_CAMPAIGNS[3]
    ? { field: "shopHistory", version: 1, shopId: HISTORY_SHOP, validate: validateHistoryGrant }
    : null;
  if (!policy) return false;
  const grant = state?.[policy.field];
  try { policy.validate(grant); } catch { return false; }
  return grant.version === policy.version && job.shopId === policy.shopId &&
    job.status === "running" && job.stopped === false &&
    typeof job.owner === "string" && job.owner.length > 0 &&
    job.runId === grant.runId && job.canaryGeneration === grant.canaryGeneration &&
    job.bindingDigest === grant.bindingDigest &&
    ms(job.notBefore) === ms(grant.notBefore) && ms(job.expiresAt) === ms(grant.expiresAt) &&
    now >= ms(grant.notBefore) && now < ms(grant.expiresAt) &&
    // Unlike weekend dispatch cooldowns, these runners leave the grant open
    // throughout execution and close it only on termination.
    grant.stopped === false && state?.operatorStop?.active === false &&
    state?.canary?.generation === grant.canaryGeneration && state.canary.mode === "live" &&
    state.canary.scope === "callbacks_and_interactive" && state.canary.requiresRelay === true &&
    state.canary.workersSuspendedConfirmed === true && !state.canary.endedBy;
}

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
  const active = legacyActive(job, state, now) || (validGrant && job?._id === WEEKEND.id && job.stopped === false &&
    job.status === "running" && job.runId === grant.runId && job.owner === grant.owner &&
    job.canaryGeneration === grant.canaryGeneration &&
    grant.canaryGeneration === state?.canary?.generation &&
    state?.operatorStop?.active === false && state?.canary?.mode === "live" &&
    state.canary.scope === "callbacks_and_interactive" && state.canary.requiresRelay === true &&
    state.canary.workersSuspendedConfirmed === true && !state.canary.endedBy &&
    now >= ms(grant.notBefore) && now < ms(grant.expiresAt) &&
    now < ms(job.expiresAt) && now < ms(job.leaseUntil) && now < ms(grant.runnerLeaseUntil));
  // stopped on the dispatch grant is normal between requests and during cooldown.
  // It is NOT an operator cancellation; job.stopped and operatorStop are authoritative.
  const signals = {
    heartbeatAt: ms(job?.heartbeatAt),
    heldDayAdvanceAt: ms(job?.heldDayAdvanceAt),
    capturedPageAt: ms(job?.capturedPageAt),
    verifiedPresentAt: ms(job?.verifiedPresentAt),
    importedInvoiceAt: ms(job?.importedInvoiceAt),
    completedPageAt: ms(job?.completedPageAt),
    comparedPageAt: ms(job?.comparedPageAt),
  };
  const lastRealProgressAt = job?._id === AFTON_PILOT.jobId
    ? signals.comparedPageAt
    : Math.max(signals.verifiedPresentAt, signals.importedInvoiceAt, signals.completedPageAt);
  const waiting = active && job?._id === WEEKEND.id && ms(job.callbackWaitUntil) > now;
  const sameRun = previous?.runId === job?.runId &&
    (job?._id === WEEKEND.id || previous?.owner === job?.owner);
  // A 3-hour fleet threshold cannot detect a stall in the 15-minute pilot.
  const effectiveWindowMs = job?._id === AFTON_PILOT.jobId ? Math.min(windowMs, 5 * 60_000) : windowMs;
  // New/re-activated campaigns and callback yields receive a full eligible window.
  const baselineAt = !active || waiting || !sameRun || !previous?.active
    ? now : ms(previous.baselineAt) || now;
  const stalledMs = Math.max(0, now - Math.max(baselineAt, lastRealProgressAt));
  return {
    active: Boolean(active), waiting: Boolean(waiting), baselineAt: new Date(baselineAt),
    runId: job?.runId, owner: job?.owner, signals, lastRealProgressAt: lastRealProgressAt || null,
    stalledMs, stalled: Boolean(active && !waiting && stalledMs >= effectiveWindowMs),
  };
}
