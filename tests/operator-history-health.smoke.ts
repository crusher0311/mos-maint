import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { historyHealth, HISTORY_CAMPAIGNS } from "../app/api/cron/pipeline-stall-alerter/history";
import { buildAlertKey, type StallHit } from "../app/api/cron/pipeline-stall-alerter/lib";
import { WEEKEND, weekendFrom } from "../lib/protractor-weekend-policy";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { fixtures } from "./legacy-history-health.smoke";

const start = Date.parse(WEEKEND.start) + 3600000, windowMs = 3 * 3600000;
const now = start + windowMs, future = new Date(now + 240000);
const runId = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
const job = { _id: WEEKEND.id, runId, owner: "owner", canaryGeneration: generation,
  stopped: false, status: "running", expiresAt: new Date(WEEKEND.end),
  leaseUntil: future, heartbeatAt: new Date(now) };
const state = { operatorStop: { active: false },
  canary: { generation, mode: "live", scope: "callbacks_and_interactive",
    requiresRelay: true, workersSuspendedConfirmed: true },
  weekendHistory: { version: 4, runId, owner: "owner", shopId: 538,
    canaryGeneration: generation, bindingDigest: "a".repeat(64),
    from: weekendFrom(538), until: WEEKEND.until,
    notBefore: new Date(WEEKEND.start), expiresAt: new Date(WEEKEND.end),
    stopped: true, runnerLeaseUntil: future, maxRequests: 10000, consumedRequests: 10 } };
const previous = { runId, active: true, baselineAt: new Date(start) };
const check = (patch: any = {}, prev = previous, time = now, rate = state) =>
  historyHealth({ ...job, ...patch }, rate, prev, time, windowMs);

assert.equal(check().stalled, true, "Fresh lease/heartbeat cannot mask a stall");
assert.equal(check({ heldDayAdvanceAt: new Date(now), cursor: 500 }).stalled, true);
assert.equal(check({ capturedPageAt: new Date(now) }).stalled, true);
assert.equal(check({ lastProgressAt: new Date(now) }).stalled, true, "Legacy page-check timestamp is not completion");
for (const field of ["verifiedPresentAt", "importedInvoiceAt", "completedPageAt"]) {
  const healthy = check({ [field]: new Date(now) });
  assert.equal(healthy.stalled, false, field);
  assert.equal(healthy.lastRealProgressAt, now);
}
assert.equal(check({ status: "completed" }).active, false);
assert.equal(check({ status: "needs-attention" }).active, false);
assert.equal(check({ retryAfter: future }).stalled, true, "Error cooldown is not callback priority");
const waiting = check({ callbackWaitUntil: future });
assert.equal(waiting.stalled, false);
assert.equal(waiting.waiting, true);
assert.equal(check({ callbackWaitUntil: new Date(now - 1) }).stalled, true, "Expired wait cannot suppress");
assert.equal(check({}, waiting).stalled, false, "Callback wait resets eligible window, not real progress");
assert.equal(waiting.lastRealProgressAt, null);
assert.equal(check({}, previous, Date.parse(WEEKEND.end)).active, false);
assert.equal(check({ stopped: true }).active, false);
assert.equal(check({ leaseUntil: new Date(now) }).active, false);
assert.equal(check({}, previous, now, { ...state, operatorStop: { active: true } }).active, false);
assert.equal(check({}, previous, now, { ...state, weekendHistory: { ...state.weekendHistory, owner: "other" } }).active, false);
assert.equal(check({}, { ...previous, runId: "other" }).stalled, false);
assert.equal(historyHealth(null, null, null, now, windowMs).active, false);
assert.equal(check({}, previous, now, { ...state, weekendHistory: { ...state.weekendHistory, expiresAt: future } }).active, false);

const hit = (signals: Record<string, number>): StallHit => ({
  reason: "history_import", campaignId: WEEKEND.id, stalledMs: windowMs,
  lastRealProgressAt: null, signals,
});
assert.equal(buildAlertKey([hit(check().signals)]), buildAlertKey([hit(check({ heartbeatAt: future }).signals)]),
  "Heartbeat/cooldown churn must reuse the existing alert dedup key");
assert.equal(buildAlertKey([]), "", "Recovery clears the breach");
assert.equal(JSON.stringify(check()).includes("bindingDigest"), false);
console.log("PASS operator history health: outcomes, held days, heartbeat, captures, waits, cooldown, expiry and dedup");

// Execute the real cron handler against metadata-only stores. No DB, email,
// provider requests, or app boot; validates shared escalation and auto-clear.
async function routeScenario(fixture?: typeof fixtures[number]) {
  const scenarioStart = fixture?.start ?? start, scenarioNow = fixture?.now ?? now;
  const scenarioId = fixture?.id ?? WEEKEND.id;
  let clock = scenarioStart;
  const heartbeats = new Map<string, any>(), alerts = new Map<string, any>();
  const notifications: any[] = [];
  const mutableJob: any = { ...(fixture?.job ?? job), invoices: [{ customer: "DO-NOT-REPORT" }] };
  const collection = (name: string): any => {
    const map = name === "pipeline_progress_heartbeat" ? heartbeats : alerts;
    return {
      findOne: async (q: any, options?: any) => {
        if (name === "operator_history_import_jobs") {
          assert.ok(options.projection);
          return q._id === mutableJob._id ? mutableJob : null;
        }
        if (name === "api_rate_limits") return fixture?.state ?? state;
        if (name === "cron_status") return {};
        return map.get(q._id) ?? null;
      },
      find: () => ({ toArray: async () => [] }),
      updateOne: async (q: any, u: any) => {
        map.set(q._id, { ...(map.get(q._id) ?? u.$setOnInsert), ...u.$set });
      },
      deleteOne: async (q: any) => { map.delete(q._id); },
    };
  };
  const helpers = await import("../app/api/cron/pipeline-stall-alerter/lib");
  const dependencies: Record<string, any> = {
    "next/server": { NextResponse: { json: (body: any, options?: any) => ({ body, status: options?.status ?? 200 }) } },
    "@/lib/mongo": { getDb: async () => ({ collection }) },
    "@/lib/email": { sendEmail: async (message: any) => { notifications.push(message); } },
    "@/lib/super-admins": { getPlatformAdminEmails: async () => ["offline@example.test"] },
    "@/lib/alerts/notify": { sendOpsAlert: async (message: any) => { notifications.push(message); } },
    "@/lib/queue/metrics": { getAllQueueSnapshots: async () => [] },
    "@/lib/queue/connection": { isQueueEnabled: () => false },
    "@/lib/data/repositories/tekmetric-ops": { listProgress: async () => [], getDrainLock: async () => null },
    "@/lib/data/repositories/protractor-backfill-progress": { findAllProgress: async () => [] },
    "@/lib/protractor-weekend-policy": { WEEKEND },
    "./history": { historyHealth, HISTORY_CAMPAIGNS },
    "./lib": helpers,
  };
  class Clock extends Date { constructor() { super(clock); } static now() { return clock; } }
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync("app/api/cron/pipeline-stall-alerter/route-handler.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Date: Clock, console, process: { env: { CRON_SECRET: "offline-only" } },
    require: (name: string) => { assert.ok(dependencies[name], name); return dependencies[name]; } });
  const request = { headers: { get: () => "Bearer offline-only" } };
  assert.equal((await exports.GET({ headers: { get: () => null } })).status, 401);
  assert.equal((await exports.GET(request)).body.action, "none");
  clock = scenarioNow;
  assert.equal((await exports.GET(request)).body.action, "alerted");
  assert.equal(notifications.length, 2, "Existing ops and email channels each send once");
  mutableJob.heartbeatAt = new Date(now + 1);
  mutableJob.heldDayAdvanceAt = new Date(now);
  mutableJob.retryAfter = future;
  assert.equal((await exports.GET(request)).body.action, "deduped");
  assert.equal(notifications.length, 2, "Error cooldown must not re-page");
  assert.ok(JSON.stringify(notifications).includes(scenarioId));
  assert.ok(!JSON.stringify(notifications).includes("DO-NOT-REPORT"));
  assert.ok(!JSON.stringify(notifications).includes("bindingDigest"));
  const outcome = fixture?.version === 2 ? "comparedPageAt" : "importedInvoiceAt";
  mutableJob[outcome] = new Date(scenarioNow);
  assert.equal((await exports.GET(request)).body.action, "cleared");
  delete mutableJob[outcome];
  if (!fixture) {
  mutableJob.callbackWaitUntil = future;
  assert.equal((await exports.GET(request)).body.history.waiting, true);
  assert.equal(notifications.length, 2);
  clock = Date.parse(WEEKEND.end);
  assert.equal((await exports.GET(request)).body.history.active, false);
  assert.equal(notifications.length, 2, "Expired campaign cannot page");
  } else {
    clock = Date.parse(fixture.end);
    const response = (await exports.GET(request)).body;
    assert.equal(response.histories.find((h: any) => h.campaignId === scenarioId).active, false);
    assert.equal(notifications.length, 2, "Expired legacy campaign cannot page");
  }
  console.log("PASS real pipeline route: authorization, escalation, dedup, recovery, waits, expiry and payload redaction");
}
async function main() {
  await routeScenario();
  for (const fixture of fixtures) await routeScenario(fixture);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
