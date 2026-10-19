import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as historyPolicy from "../lib/protractor-shop-history-policy";
import { AVID_HISTORY } from "../lib/protractor-avid-history-policy";
import { AFTON_PILOT } from "../lib/protractor-afton-pilot-policy";
import * as report from "../lib/protractor-afton-pilot-report";

// Execute the real orchestration with in-memory stores and a fixed clock.
// No application boot, child processes, network, or real database clients.
async function run(kind: "avid" | "afton" | "shop538", failure: boolean) {
  const p = kind === "avid" ? AVID_HISTORY : kind === "afton" ? AFTON_PILOT : {
    jobId: "shop538-history-2026-10-08", shopId: 538,
    start: historyPolicy.HISTORY_START, end: historyPolicy.HISTORY_END,
  };
  let clock = Date.parse(p.start) - 120_000;
  const end = Date.parse(p.end), stores = new Map<string, Map<string, any>>();
  let reads = 0, writes = 0;
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  const field = kind === "avid" ? "avidHistory" : kind === "afton" ? "aftonPilot" : "shopHistory";
  const rates = store("api_rate_limits");
  rates.set("protractor-physical-transport-v1", {
    operatorStop: { active: false },
    canary: { generation: "22222222-2222-4222-8222-222222222222", mode: "live",
      scope: "callbacks_and_interactive", requiresRelay: true, workersSuspendedConfirmed: true },
  });
  const set = (row: any, path: string, value: any) => {
    const keys = path.split("."), last = keys.pop()!;
    for (const key of keys) row = row[key] ??= {};
    row[last] = value;
  };
  const collection = (name: string): any => ({
    findOne: async (q: any) => store(name).get(q._id) ?? null,
    insertOne: async (row: any) => { assert.ok(!store(name).has(row._id)); store(name).set(row._id, row); },
    countDocuments: async () => [...store(name).values()].filter(r => r.complete).length,
    updateOne: async (q: any, u: any, options?: any) => {
      let row = store(name).get(q._id);
      if (!row && options?.upsert) { row = { _id: q._id }; store(name).set(q._id, row); }
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      for (const [key, value] of Object.entries(u.$set ?? {})) set(row, key, value);
      for (const [key, value] of Object.entries(u.$max ?? {})) set(row, key, value);
      for (const [key, value] of Object.entries(u.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value);
      if (u.$max?.completedPageAt || u.$set?.completedPageAt) clock = end - 59_000;
      return { matchedCount: 1, modifiedCount: 1 };
    },
  });
  const dependencies: Record<string, any> = {
    "node:assert/strict": assert,
    "node:crypto": { randomUUID, createHash },
    "node:child_process": { spawn: () => { throw Error("Empty pages must not start a child"); } },
    "../lib/mongo": { getDb: async () => ({ collection }) },
    "../lib/db/drizzle": { getClient: () => { throw Error("Empty pilot page needs no PG lookup"); } },
    "../lib/protractor-avid-history-policy": { AVID_HISTORY },
    "../lib/protractor-afton-pilot-policy": { AFTON_PILOT },
    "../lib/protractor-shop-history-policy": historyPolicy,
    "../lib/protractor-afton-pilot-report": report,
    "../lib/integrations/protractor/shop-history-context": {
      historyBindingDigest: () => "a".repeat(64),
      runWithShopHistory: async (_g: any, _r: any, fn: any) => fn(),
    },
    "../lib/integrations/protractor/client": {
      resolveProtractorConfig: async () => ({ configured: true, connectionId: "offline" }),
      protractorFetch: async () => { reads++; assert.ok(reads <= 3);
        if (failure && kind === "avid") clock = end - 120_000;
        return { ok: !failure, data: [] };
      },
    },
    "../lib/integrations/core/normalized-ingestion": {
      createIngestionService: () => ({ ingestWorkOrderWithAllEntities: () => { writes++; throw Error("No invoice expected"); } }),
    },
    "../lib/data/repositories/activity-profiles": { loadActivityProfileMap: async () => new Map() },
    "../lib/integrations/activity-profile/profile": { decideQuietWindowGate: () => ({ eligible: true }) },
    "../lib/job-index": { extractJobIndexFromWorkOrder: () => [] },
  };
  class Clock extends Date {
    constructor(value?: any) { super(value === undefined ? clock : value); }
    static now() { return clock; }
  }
  const source = readFileSync(`scripts/run-${kind === "afton" ? "afton-pilot" : `${kind}-history`}.ts`, "utf8");
  const exports: any = {};
  const processMock = { env: { RENDER: "true", WORKER_SCHEDULE_DISABLED: "true", NORMALIZED_INGEST_WRITE_CONCURRENCY: "1" },
    argv: ["node", "runner", kind === "shop538" ? "--prepare-approved" : "--schedule-approved"] };
  vm.runInNewContext(ts.transpileModule(source.slice(0, source.indexOf("\nmain().")) + "\nexports.run = main;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports, require: (name: string) => { assert.ok(dependencies[name], name); return dependencies[name]; },
    Date: Clock, process: processMock, console: { log() {}, error() {} }, AbortSignal,
    setTimeout: (fn: () => void, ms: number) => { clock += ms; fn(); },
    fetch: async () => ({ ok: true, json: async () => kind === "shop538" ? { suspended: "suspended" } :
      ["backfill-drain-worker", "mos-maint-background-v2"].map(name => ({ service: { name, suspended: "suspended" } })) }),
  });
  if (kind === "shop538") {
    await exports.run();
    processMock.argv = ["node", "runner"];
    clock = Date.parse(p.start);
  }
  try { await exports.run(); assert.ok(!failure || kind === "avid"); }
  catch (error) { if (!failure) throw error; }
  const job = store("operator_history_import_jobs").get(p.jobId);
  assert.ok(job.canaryGeneration && job.bindingDigest && job.notBefore && job.expiresAt);
  assert.ok(job.heartbeatAt, "Attempt recorded separately from progress");
  assert.equal(rates.get("protractor-physical-transport-v1")[field].stopped, true);
  assert.equal(writes, 0);
  if (failure) {
    assert.equal(job.completedPageAt, undefined);
    assert.equal(job.comparedPageAt, undefined);
    assert.equal(job.importedInvoiceAt, undefined);
    if (kind === "avid") assert.ok(job.heldDayAdvanceAt);
  } else {
    assert.ok(job.capturedPageAt);
    assert.ok(kind === "afton" ? job.comparedPageAt : job.completedPageAt);
    assert.equal(job.importedInvoiceAt, undefined, "Empty/compared page is not an import");
  }
}
async function main() {
  for (const kind of ["avid", "afton", "shop538"] as const) {
    await run(kind, false);
    await run(kind, true);
  }
  console.log("PASS real legacy runners offline: empty-page outcomes, provider failures, held days, metadata and grant closure");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
