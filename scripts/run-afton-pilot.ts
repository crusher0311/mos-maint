/**
 * One-use, read-only provider comparison. No invoice ingestion, financial repair,
 * upstream writes, automatic retry, permission renewal, or general-worker startup.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, getMongoClient } from "../lib/mongo";
import { getClient } from "../lib/db/drizzle";
import { resolveProtractorConfig, protractorFetch } from "../lib/integrations/protractor/client";
import { historyBindingDigest, runWithShopHistory } from "../lib/integrations/protractor/shop-history-context";
import { historyEndpoint, validateHistoryGrant, type ShopHistoryGrant } from "../lib/protractor-shop-history-policy";
import { AFTON_PILOT as P } from "../lib/protractor-afton-pilot-policy";
import { pilotDigest, pilotInvoiceIds, classifyPilotIds } from "../lib/protractor-afton-pilot-report";

const RATE = "protractor-physical-transport-v1";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const START = Date.parse(P.start), END = Date.parse(P.end);
let pgUsed = false;
let mongoUsed = false;

async function verifyWorkers() {
  assert.equal(process.env.WORKER_SCHEDULE_DISABLED, "true", "General-worker scheduler must remain disabled");
  const response = await fetch("https://api.render.com/v1/services?limit=100", {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY_PROD}` },
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, "Worker state could not be verified");
  const services = (await response.json()).map((row: any) => row.service);
  for (const name of ["backfill-drain-worker", "mos-maint-background-v2"]) {
    const matches = services.filter((s: any) => s.name === name);
    assert.equal(matches.length, 1, "Worker identity missing or ambiguous");
    assert.equal(matches[0].suspended, "suspended", "General worker is not suspended");
  }
}

function fleetReady(state: any, generation?: string) {
  assert.ok(state?.operatorStop?.active === false && state.canary?.mode === "live" &&
    state.canary.scope === "callbacks_and_interactive" && state.canary.requiresRelay === true &&
    state.canary.workersSuspendedConfirmed === true && !state.canary.endedBy,
    "Fleet safety state does not permit this pilot");
  if (generation) assert.equal(state.canary.generation, generation, "Fleet generation changed");
}

async function main() {
  assert.ok(process.env.RENDER && !process.env.REPLIT_DEV_DOMAIN && !process.env.REPL_ID,
    "Production Render execution required");
  assert.ok(process.argv.includes("--schedule-approved"), "Explicit scheduling command required");
  assert.ok(Date.now() < START - 60_000, "Too late to schedule this one-use pilot");
  await verifyWorkers();
  mongoUsed = true;
  const db = await getDb();
  const jobs = db.collection<any>("operator_history_import_jobs");
  const pages = db.collection<any>("operator_history_import_pages");
  const rates = db.collection<any>("api_rate_limits");
  const config = await resolveProtractorConfig(P.shopId);
  assert.ok(config.configured, "Shop-specific Protractor connection required");
  const state = await rates.findOne({ _id: RATE }, { maxTimeMS: 3000 });
  fleetReady(state);
  assert.ok(!state.aftonPilot, "Afton permission already exists; never replace or reset it");
  const grant: ShopHistoryGrant = {
    version: 2, runId: randomUUID(), shopId: P.shopId, from: P.day, until: P.until,
    canaryGeneration: state.canary.generation,
    bindingDigest: historyBindingDigest(P.shopId, config.connectionId),
    notBefore: new Date(P.start), expiresAt: new Date(P.end),
    maxRequests: P.maxRequests, consumedRequests: 0, stopped: true,
  };
  validateHistoryGrant(grant);
  const owner = randomUUID();
  // Unique _id prevents duplicate schedulers before either can open a permission.
  await jobs.insertOne({
    _id: P.jobId, runId: grant.runId, owner, status: "preparing", stopped: false,
    canaryGeneration: grant.canaryGeneration, bindingDigest: grant.bindingDigest,
    shopId: P.shopId, grantDigest: pilotDigest(grant), createdAt: new Date(),
    notBefore: grant.notBefore, expiresAt: grant.expiresAt,
    approvedTimezone: P.timezone, approvedHours: "Mon-Fri 07:00-18:00",
    mode: "comparison_only", sourceDay: P.day, nextPage: 0,
    pagesCompleted: 0, present: 0, missingCandidates: 0, ambiguous: 0,
  });
  let opened = false;
  try {
    const prepared = await rates.updateOne({
      _id: RATE, aftonPilot: { $exists: false }, "operatorStop.active": false,
      "canary.generation": grant.canaryGeneration, "canary.mode": "live",
    }, { $set: { aftonPilot: grant } });
    assert.equal(prepared.modifiedCount, 1, "Fleet changed during preparation");
    const scheduled = await jobs.updateOne({ _id: P.jobId, owner, status: "preparing", stopped: false },
      { $set: { status: "scheduled", scheduledAt: new Date() } });
    assert.equal(scheduled.modifiedCount, 1, "Scheduling ownership changed");
    console.log(JSON.stringify({ event: "afton_pilot_scheduled", shopId: P.shopId,
      start: P.start, end: P.end, maxRequests: P.maxRequests, mode: "comparison_only" }));
    while (Date.now() < START) {
      const job = await jobs.findOne({ _id: P.jobId, owner, status: "scheduled", stopped: false },
        { projection: { _id: 1 }, maxTimeMS: 3000 });
      assert.ok(job, "Scheduled pilot stopped or ownership changed");
      await sleep(Math.min(30_000, START - Date.now()));
    }
    assert.ok(Date.now() < END - 60_000, "Pilot window missed");
    await verifyWorkers();
    const fresh = await rates.findOne({ _id: RATE }, { maxTimeMS: 3000 });
    fleetReady(fresh, grant.canaryGeneration);
    assert.equal(pilotDigest(fresh.aftonPilot), pilotDigest(grant), "Prepared permission changed");
    const claimed = await jobs.updateOne({ _id: P.jobId, owner, status: "scheduled", stopped: false },
      { $set: { status: "running", startedAt: new Date() } });
    assert.equal(claimed.modifiedCount, 1, "Pilot already claimed or stopped");
    const activated = await rates.updateOne({
      _id: RATE, aftonPilot: grant, "operatorStop.active": false,
      "canary.generation": grant.canaryGeneration, "canary.mode": "live",
    }, { $set: { "aftonPilot.stopped": false } });
    assert.equal(activated.modifiedCount, 1, "Activation rejected");
    opened = true;
    const seen = new Set<string>();
    for (let page = 0; page < P.maxRequests; page++) {
      assert.ok(Date.now() < END - 60_000, "Pilot cutoff; no additional page admitted");
      const job = await jobs.findOne({ _id: P.jobId, owner, status: "running", stopped: false },
        { projection: { _id: 1 }, maxTimeMS: 3000 });
      assert.ok(job, "Pilot stopped or ownership changed");
      await jobs.updateOne({ _id: P.jobId, owner }, { $max: { heartbeatAt: new Date() } });
      const live = await rates.findOne({ _id: RATE }, { maxTimeMS: 3000 });
      fleetReady(live, grant.canaryGeneration);
      validateHistoryGrant(live.aftonPilot);
      assert.equal(live.aftonPilot.runId, grant.runId, "Permission changed");
      await verifyWorkers();
      const current = await resolveProtractorConfig(P.shopId);
      assert.ok(current.configured &&
        historyBindingDigest(P.shopId, current.connectionId) === grant.bindingDigest,
        "Shop connection changed");
      const request = { runId: grant.runId, shopId: P.shopId, day: P.day, pilot: "afton" as const };
      const response = await runWithShopHistory(live.aftonPilot, request, () =>
        protractorFetch<any>(historyEndpoint(request, page), current, { method: "GET" }, 0, P.shopId,
          { maxRetries: 0, timeoutMs: 20_000, deadlineAtMs: Math.min(END - 30_000, Date.now() + 30_000) }));
      assert.ok(response.ok, "Provider failure; pilot paused without retry");
      const ids = pilotInvoiceIds(response.data);
      for (const id of ids) {
        assert.ok(!seen.has(id), "Invoice repeated across pages; unstable pagination");
        seen.add(id);
      }
      const pageId = `${P.jobId}:${page}`;
      // Store evidence before local comparison. An ambiguous write stops, never re-fetches.
      await pages.insertOne({ _id: pageId, jobId: P.jobId, page, sourceIds: ids,
        digest: pilotDigest(ids), capturedAt: new Date(), status: "captured" });
      await jobs.updateOne({ _id: P.jobId, owner }, { $max: { capturedPageAt: new Date() } });
      let matches: Array<{ source_id: string; id: string }> = [];
      if (ids.length) {
        pgUsed = true;
        matches = await getClient().begin(async sql => {
          await sql.unsafe("set transaction read only");
          await sql.unsafe("set local statement_timeout = '5000ms'");
          return await sql.unsafe<Array<{ source_id: string; id: string }>>(`
            select distinct w.id, lower(s->>'idValue') as source_id
            from normalized_work_orders w
            cross join lateral jsonb_array_elements(w.provenance->'sourceIds') s
            where w.shop_id=$1 and s->>'system'='protractor'
              and lower(s->>'idValue')=any($2::text[])
            limit 201`, [P.shopId, sql.array(ids)]);
        });
        assert.ok(matches.length <= 200, "Local identity result truncated; do not infer absence");
      }
      const results = classifyPilotIds(ids, matches);
      const counts = {
        present: results.filter(r => r.result === "present").length,
        missingCandidates: results.filter(r => r.result === "missing_candidate").length,
        ambiguous: results.filter(r => r.result === "ambiguous").length,
      };
      const recorded = await pages.updateOne({ _id: pageId, digest: pilotDigest(ids), status: "captured" },
        { $set: { status: "compared", results, completedAt: new Date() } });
      assert.equal(recorded.modifiedCount, 1, "Comparison receipt unconfirmed");
      const advanced = await jobs.updateOne({ _id: P.jobId, owner, status: "running", stopped: false, nextPage: page },
        { $set: { nextPage: page + 1, lastProgressAt: new Date(), comparedPageAt: new Date() },
          $inc: { pagesCompleted: 1, ...counts } });
      assert.equal(advanced.modifiedCount, 1, "Checkpoint unconfirmed; no automatic continuation");
      assert.equal(counts.ambiguous, 0, "Ambiguous local identities require review");
      if (ids.length < 100) {
        const completed = await jobs.updateOne({ _id: P.jobId, owner, status: "running", stopped: false },
          { $set: { status: "comparison_completed", completedAt: new Date() } });
        assert.equal(completed.modifiedCount, 1, "Completion acknowledgment missing");
        console.log(JSON.stringify({ event: "afton_pilot_comparison_completed",
          shopId: P.shopId, invoicesCompared: seen.size, pages: page + 1, imported: 0 }));
        return;
      }
      await sleep(1000);
    }
    throw Error("Pilot page/request budget exhausted; comparison is partial");
  } catch (error) {
    // No raw upstream/driver message or customer data in process logs.
    await jobs.updateOne({ _id: P.jobId, owner }, {
      $set: { status: "paused", stopped: true, pausedAt: new Date(),
        reason: "Preflight, provider, safety, or checkpoint failure; inspect retained evidence before restart" },
    }).catch(() => {});
    console.error(JSON.stringify({ event: "afton_pilot_paused", shopId: P.shopId,
      activated: opened, errorType: error instanceof Error ? error.name : "unknown" }));
    throw Error("Afton pilot paused; no automatic retry or renewal");
  } finally {
    // Close this pilot only. The global operator stop, callbacks and other budgets are untouched.
    await rates.updateOne({ _id: RATE, "aftonPilot.runId": grant.runId },
      { $set: { "aftonPilot.stopped": true, "aftonPilot.finishedAt": new Date() } });
  }
}

main().then(() => { process.exitCode = 0; }).catch(error => {
  console.error(JSON.stringify({event: "afton_pilot_failed", errorType: error instanceof Error ? error.name : "unknown"}));
  process.exitCode = 1;
}).finally(async () => {
  if (pgUsed) await getClient().end({ timeout: 5 });
  if (mongoUsed) await (await getMongoClient()).close();
  process.exit(process.exitCode ?? 1);
});
