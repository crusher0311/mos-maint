import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { historyHealth, HISTORY_CAMPAIGNS } from "../app/api/cron/pipeline-stall-alerter/history";
import { AVID_HISTORY as A } from "../lib/protractor-avid-history-policy";
import { AFTON_PILOT as F } from "../lib/protractor-afton-pilot-policy";
import { HISTORY_START, HISTORY_END, HISTORY_FROM, HISTORY_UNTIL } from "../lib/protractor-shop-history-policy";
import { createRequire } from "node:module";

const { CRON_JOBS } = createRequire(import.meta.url)("../lib/cron/jobs.cjs");
assert.equal(CRON_JOBS.filter((job: any) => job.path === "/api/cron/pipeline-stall-alerter").length, 1);
assert.equal(CRON_JOBS.find((job: any) => job.name === "pipeline-stall-alerter").schedule, "*/5 * * * *",
  "The existing alert path must run often enough to observe the 15-minute comparison pilot");

export const fixtures = [
  { id: A.jobId, field: "avidHistory", version: 3, shopId: A.shopId,
    from: A.from, until: A.until, start: A.start, end: A.end },
  { id: F.jobId, field: "aftonPilot", version: 2, shopId: F.shopId,
    from: F.day, until: F.until, start: F.start, end: F.end },
  { id: HISTORY_CAMPAIGNS[3], field: "shopHistory", version: 1, shopId: 538,
    from: HISTORY_FROM, until: HISTORY_UNTIL, start: HISTORY_START, end: HISTORY_END },
].map(p => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const generation = "22222222-2222-4222-8222-222222222222";
  const grant = { version: p.version, runId, shopId: p.shopId, from: p.from, until: p.until,
    canaryGeneration: generation, bindingDigest: "a".repeat(64), stopped: false,
    notBefore: new Date(p.start), expiresAt: new Date(p.end), maxRequests: 100, consumedRequests: 10 };
  const job = { _id: p.id, runId, owner: "owner", shopId: p.shopId, stopped: false,
    status: "running", canaryGeneration: generation, bindingDigest: grant.bindingDigest,
    notBefore: grant.notBefore, expiresAt: grant.expiresAt };
  const state = { [p.field]: grant, operatorStop: { active: false },
    canary: { generation, mode: "live", scope: "callbacks_and_interactive",
      requiresRelay: true, workersSuspendedConfirmed: true } };
  const start = Date.parse(p.start) + 60_000;
  const window = p.version === 2 ? 5 * 60_000 : 3 * 3600_000;
  return { ...p, job, state, grant, start, now: start + window, window };
});

for (const f of fixtures) {
  const previous = { runId: f.job.runId, owner: f.job.owner, active: true, baselineAt: new Date(f.start) };
  const check = (job = f.job as any, state = f.state as any, now = f.now, prev = previous as any) =>
    historyHealth(job, state, prev, now, 3 * 3600_000);
  assert.equal(check().stalled, true, f.id);
  for (const signal of ["heartbeatAt", "capturedPageAt", "heldDayAdvanceAt", "lastProgressAt",
    "lastCheckedAt", "retryAfter", "callbackWaitUntil"]) {
    assert.equal(check({ ...f.job, [signal]: new Date(f.now + 60_000) }).stalled, true, signal);
  }
  const outcomes = f.version === 2 ? ["comparedPageAt"] : ["verifiedPresentAt", "importedInvoiceAt", "completedPageAt"];
  for (const signal of outcomes) assert.equal(check({ ...f.job, [signal]: new Date(f.now) }).stalled, false, signal);
  if (f.version === 2) {
    assert.equal(check({ ...f.job, importedInvoiceAt: new Date(f.now) }).stalled, true,
      "Read-only comparison never claims imported progress");
  }
  for (const status of ["preparing", "scheduled", "completed", "comparison_completed", "paused", "needs-attention", "morning-stop"]) {
    assert.equal(check({ ...f.job, status }).active, false, status);
  }
  for (const patch of [{ stopped: true }, { owner: "" }, { runId: "other" }, { shopId: 999 },
    { canaryGeneration: "other" }, { bindingDigest: "b".repeat(64) }, { notBefore: null }, { expiresAt: null }]) {
    assert.equal(check({ ...f.job, ...patch }).active, false, JSON.stringify(patch));
  }
  for (const patch of [{ stopped: true }, { version: 4 }, { maxRequests: 10001 },
    { expiresAt: new Date(Date.parse(f.end) + 86400000) }, { notBefore: new Date(f.start) }]) {
    assert.equal(check(f.job, { ...f.state, [f.field]: { ...f.grant, ...patch } }).active, false);
  }
  for (const patch of [{ mode: "off" }, { generation: "other" }, { endedBy: "operator" },
    { requiresRelay: false }, { workersSuspendedConfirmed: false }, { scope: "interactive" }]) {
    assert.equal(check(f.job, { ...f.state, canary: { ...f.state.canary, ...patch } }).active, false);
  }
  assert.equal(check(f.job, { ...f.state, operatorStop: { active: true } }).active, false);
  for (const now of [f.grant.notBefore.getTime() - 1, Date.parse(f.end), Date.parse("2026-10-19")])
    assert.equal(check(f.job, f.state, now).active, false, "Outside exact approval");
  assert.equal(check(f.job, f.state, f.now, null).stalled, false);
  assert.equal(check({ ...f.job, owner: "replacement" }).stalled, false, "Owner change starts a fresh observation");
  assert.equal(check(f.job, f.state, f.now, { ...previous, active: false }).stalled, false);
  assert.ok(!JSON.stringify(check()).includes("bindingDigest"));
}
console.log("PASS legacy history health: exact grants, active windows, outcome-only progress and comparison semantics");
