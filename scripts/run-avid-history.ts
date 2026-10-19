import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { getDb } from "../lib/mongo";
import { AVID_HISTORY as P } from "../lib/protractor-avid-history-policy";
import { historyEndpoint, validateHistoryGrant, type ShopHistoryGrant } from "../lib/protractor-shop-history-policy";
import { historyBindingDigest, runWithShopHistory } from "../lib/integrations/protractor/shop-history-context";
import { resolveProtractorConfig, protractorFetch } from "../lib/integrations/protractor/client";
import { pilotInvoiceIds } from "../lib/protractor-afton-pilot-report";
const RATE = "protractor-physical-transport-v1", START = Date.parse(P.start), END = Date.parse(P.end);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const previous = (day: string) => new Date(Date.parse(day + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
async function workers() {
  assert.equal(process.env.WORKER_SCHEDULE_DISABLED, "true");
  const r = await fetch("https://api.render.com/v1/services?limit=100", {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY_PROD}` },
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(r.ok);
  const services = (await r.json()).map((x: any) => x.service);
  for (const name of ["backfill-drain-worker", "mos-maint-background-v2"]) {
    const matches = services.filter((s: any) => s.name === name);
    assert.equal(matches.length, 1); assert.equal(matches[0].suspended, "suspended");
  }
}
function fleet(s: any, generation?: string) {
  assert.ok(s?.operatorStop?.active === false && s.canary?.mode === "live" &&
    s.canary.requiresRelay === true && s.canary.scope === "callbacks_and_interactive" &&
    s.canary.workersSuspendedConfirmed === true && !s.canary.endedBy);
  if (generation) assert.equal(s.canary.generation, generation);
}
async function child(page: string, owner: string) {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "scripts/avid-history-worker.ts", page, owner],
      { stdio: ["ignore", "ignore", "ignore"], env: process.env });
    const timeout = setTimeout(() => proc.kill("SIGKILL"), Math.max(1, Math.min(900000, END - Date.now() - 60000)));
    proc.once("error", e => { clearTimeout(timeout); reject(e); });
    proc.once("exit", code => { clearTimeout(timeout); resolve(code ?? 75); });
  });
}
async function main() {
  assert.ok(process.env.RENDER && !process.env.REPLIT_DEV_DOMAIN && !process.env.REPL_ID);
  assert.ok(process.argv.includes("--schedule-approved"));
  assert.ok(Date.now() < START - 60000, "Schedule before the approved night begins");
  assert.equal(process.env.NORMALIZED_INGEST_WRITE_CONCURRENCY, "1");
  await workers();
  const db = await getDb(), jobs = db.collection<any>("operator_history_import_jobs"),
    rates = db.collection<any>("api_rate_limits"), pages = db.collection<any>("operator_history_import_pages"),
    days = db.collection<any>("operator_history_import_days");
  const config = await resolveProtractorConfig(P.shopId);
  assert.ok(config.configured);
  const state = await rates.findOne({ _id: RATE }, { maxTimeMS: 5000 }); fleet(state);
  assert.ok(!state.avidHistory && !await jobs.findOne({ _id: P.jobId }, { maxTimeMS: 5000 }),
    "Existing job or budget must not be reset");
  const owner = randomUUID(), grant: ShopHistoryGrant = {
    version: 3, shopId: P.shopId, from: P.from, until: P.until, runId: randomUUID(),
    canaryGeneration: state.canary.generation, bindingDigest: historyBindingDigest(P.shopId, config.connectionId),
    notBefore: new Date(P.start), expiresAt: new Date(P.end),
    maxRequests: P.maxRequests, consumedRequests: 0, stopped: true,
  };
  validateHistoryGrant(grant);
  await jobs.insertOne({ _id: P.jobId, owner, runId: grant.runId, shopId: P.shopId,
    canaryGeneration: grant.canaryGeneration, bindingDigest: grant.bindingDigest,
    status: "preparing", stopped: false, from: P.from, until: P.until,
    notBefore: grant.notBefore, expiresAt: grant.expiresAt, completedDays: 0,
    mode: "normalized_history_import", createdAt: new Date(), grantDigest: hash(grant) });
  try {
    const prepared = await rates.updateOne({ _id: RATE, avidHistory: { $exists: false },
      "canary.generation": grant.canaryGeneration, "canary.mode": "live", "operatorStop.active": false },
      { $set: { avidHistory: grant } });
    assert.equal(prepared.modifiedCount, 1);
    await jobs.updateOne({ _id: P.jobId, owner }, { $set: { status: "scheduled", scheduledAt: new Date() } });
    console.log(JSON.stringify({ event: "avid_history_scheduled", shopId: P.shopId,
      start: P.start, end: P.end, from: P.from, until: P.until, maxRequests: P.maxRequests }));
    while (Date.now() < START) {
      assert.ok(await jobs.findOne({ _id: P.jobId, owner, stopped: false, status: "scheduled" }, { maxTimeMS: 5000 }));
      await sleep(Math.min(30000, START - Date.now()));
    }
    await workers();
    const fresh = await rates.findOne({ _id: RATE }, { maxTimeMS: 5000 });
    fleet(fresh, grant.canaryGeneration); assert.equal(hash(fresh.avidHistory), hash(grant));
    assert.ok(Date.now() < END - 180000);
    const claimed = await jobs.updateOne({ _id: P.jobId, owner, status: "scheduled", stopped: false },
      { $set: { status: "running", startedAt: new Date() } });
    assert.equal(claimed.modifiedCount, 1);
    const opened = await rates.updateOne({ _id: RATE, avidHistory: grant, "operatorStop.active": false,
      "canary.generation": grant.canaryGeneration, "canary.mode": "live" },
      { $set: { "avidHistory.stopped": false } });
    assert.equal(opened.modifiedCount, 1);
    let workerCheck = 0;
    // Deferred days get another pass, without resetting checkpoints or budgets.
    for (let pass = 0; pass < 3 && Date.now() < END - 180000; pass++) {
      for (let day = previous(P.until); day >= P.from && Date.now() < END - 180000; day = previous(day)) {
        const id = `${P.jobId}:${day}`;
        if ((await days.findOne({ _id: id }, { maxTimeMS: 5000 }))?.complete) continue;
        let page = 0, complete = true, terminal = false;
        while (page < 100 && Date.now() < END - 180000) {
          assert.ok(await jobs.findOne({ _id: P.jobId, owner, stopped: false, status: "running" }, { maxTimeMS: 5000 }));
          const live = await rates.findOne({ _id: RATE }, { maxTimeMS: 5000 });
          fleet(live, grant.canaryGeneration); validateHistoryGrant(live.avidHistory);
          assert.ok(live.avidHistory.runId === grant.runId && !live.avidHistory.stopped);
          assert.ok(live.avidHistory.consumedRequests < live.avidHistory.maxRequests, "Request budget exhausted");
          if (Date.now() - workerCheck > 60000) { await workers(); workerCheck = Date.now(); }
          const currentConfig = await resolveProtractorConfig(P.shopId);
          assert.ok(currentConfig.configured &&
            historyBindingDigest(P.shopId, currentConfig.connectionId) === grant.bindingDigest);
          const pageId = `${id}:${page}`;
          await jobs.updateOne({ _id: P.jobId, owner }, { $set: { day, page, pass, lastCheckedAt: new Date(), heartbeatAt: new Date() } });
          let archived = await pages.findOne({ _id: pageId }, { maxTimeMS: 5000 });
          if (!archived) {
            const request = { runId: grant.runId, shopId: P.shopId, day, pilot: "avid" as const };
            let response: any;
            try {
              response = await runWithShopHistory(live.avidHistory, request, () => protractorFetch<any>(
                historyEndpoint(request, page), currentConfig, { method: "GET" }, 0, P.shopId,
                { maxRetries: 0, timeoutMs: 35000 }));
            } catch { response = { ok: false }; }
            if (!response.ok) {
              await days.updateOne({ _id: id }, { $set: { jobId: P.jobId, day, complete: false, deferredAt: new Date() } }, { upsert: true });
              complete = false; await sleep(5000); break;
            }
            pilotInvoiceIds(response.data); // reject malformed/duplicate identity envelopes
            const invoices = Array.isArray(response.data) ? response.data : response.data.ItemCollection;
            archived = { _id: pageId, jobId: P.jobId, shopId: P.shopId, day, page,
              invoices, digest: hash(invoices), imported: invoices.length === 0, capturedAt: new Date() };
            await pages.insertOne(archived);
            await jobs.updateOne({ _id: P.jobId, owner }, { $max: { capturedPageAt: new Date() } });
          }
          assert.equal(hash(archived.invoices), archived.digest);
          if (!archived.imported) {
            await child(pageId, owner);
            archived = await pages.findOne({ _id: pageId }, { maxTimeMS: 5000 });
          }
          if (!archived.imported) complete = false;
          else await jobs.updateOne({ _id: P.jobId, owner }, { $max: { completedPageAt: new Date() } });
          if (archived.invoices.length < 100) { terminal = true; break; }
          page++;
          await sleep(2000);
        }
        await days.updateOne({ _id: id }, { $set: { jobId: P.jobId, day,
          complete: complete && terminal, checkedAt: new Date() } }, { upsert: true });
        const completedDays = await days.countDocuments({ jobId: P.jobId, complete: true }, { maxTimeMS: 5000 });
        await jobs.updateOne({ _id: P.jobId, owner }, { $set: { completedDays, lastCheckedAt: new Date() },
          ...(!complete || !terminal ? { $max: { heldDayAdvanceAt: new Date() } } : {}) });
        console.log(JSON.stringify({ event: "avid_history_progress", completedDays, day, pass }));
        await sleep(2000);
      }
    }
    const expectedDays = Math.round((Date.parse(P.until) - Date.parse(P.from)) / 86400000);
    const completedDays = await days.countDocuments({ jobId: P.jobId, complete: true }, { maxTimeMS: 5000 });
    await jobs.updateOne({ _id: P.jobId, owner }, { $set: {
      status: completedDays === expectedDays ? "completed" : "needs-attention",
      expectedDays, completedDays, endedAt: new Date(),
    } });
    console.log(JSON.stringify({ event: "avid_history_outcome", expectedDays, completedDays }));
  } catch {
    await jobs.updateOne({ _id: P.jobId, owner }, { $set: { status: "needs-attention", endedAt: new Date() } });
    throw Error("Avid import paused; checkpoints and ambiguous receipts preserved");
  } finally {
    await rates.updateOne({ _id: RATE, "avidHistory.runId": grant.runId }, { $set: { "avidHistory.stopped": true } });
  }
}
main().then(() => process.exit(0)).catch(() => {
  console.error("avid_history_stopped; inspect the persisted job state"); process.exit(1);
});
