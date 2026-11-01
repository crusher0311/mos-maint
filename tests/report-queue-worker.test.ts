import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runReportQueueCycle, runReportQueueWorker, type ReportQueueWorkerDeps } from "../lib/report-queue-worker";

function fixture() {
  const calls: string[] = [];
  let stop = false;
  const deps: ReportQueueWorkerDeps = {
    general: async () => { calls.push("general"); return { claimed: 1, status: "succeeded" }; },
    tires: async () => { calls.push("tires"); return [{ claimed: 1, status: "preparing" }]; },
    shouldStop: () => stop,
    sleep: async ms => { calls.push(`sleep:${ms}`); stop = true; },
    onError: queue => { calls.push(`error:${queue}`); },
  };
  return { deps, calls, stop: () => { stop = true; } };
}

test("backlog advances after a one-second yield, without concurrent processors", async () => {
  const f = fixture();
  let cycles = 0;
  f.deps.sleep = async ms => { f.calls.push(`sleep:${ms}`); if (++cycles === 2) f.stop(); };
  await runReportQueueWorker(f.deps);
  assert.deepEqual(f.calls, ["general", "tires", "sleep:1000", "tires", "general", "sleep:1000"]);
});

test("empty queues back off and exceptions do not starve the other queue", async () => {
  const f = fixture();
  f.deps.general = async () => ({ claimed: 0, status: "idle" });
  f.deps.tires = async () => [{ claimed: 0, status: "idle" }];
  await runReportQueueWorker(f.deps);
  assert.deepEqual(f.calls, ["sleep:10000"]);
  const g = fixture();
  g.deps.general = async () => { throw Error("sensitive details"); };
  await runReportQueueWorker(g.deps);
  assert.deepEqual(g.calls, ["error:general", "tires", "sleep:10000"]);
});

test("failed outcomes back off; shutdown waits for current processor and skips new work", async () => {
  const f = fixture();
  f.deps.general = async () => ({ claimed: 1, status: "failed" });
  await runReportQueueWorker(f.deps);
  assert.deepEqual(f.calls, ["tires", "sleep:10000"]);
  const g = fixture();
  g.deps.general = async () => { g.stop(); return { claimed: 1, status: "succeeded" }; };
  assert.deepEqual(await runReportQueueCycle(g.deps), { claimed: 1, failed: false });
  assert.deepEqual(g.calls, []);
});

test("rollout stays opt-in, keeps refresh admission, and excludes manual collection", () => {
  const route = readFileSync("app/api/cron/report-runs/route.ts", "utf8");
  assert.ok(route.indexOf("await refreshActiveReports()") < route.indexOf('process.env.REPORTING_QUEUE_WORKER_ENABLED'));
  assert.match(route, /REPORTING_QUEUE_WORKER_ENABLED === "true"/);
  const pilot = readFileSync("scripts/heart-tire-dot-pilot-worker.ts", "utf8");
  assert.match(pilot, /!manualBudget && process.env.REPORTING_QUEUE_WORKER_ENABLED !== "true"/);
  const worker = readFileSync("scripts/report-queue-worker.ts", "utf8");
  assert.match(worker, /REPORTING_QUEUE_WORKER_ENABLED !== "true"/);
  assert.doesNotMatch(worker, /fetchTirePilotPage|tickTirePilot|refreshActiveReports/);
});
