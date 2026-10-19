import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Collection } from "mongodb";
import { WEEKEND, callbackQuietEvidence, weekendFrom } from "../../lib/protractor-weekend-policy";
import { historyEndpoint, type ShopHistoryRequest } from "../../lib/protractor-shop-history-policy";
import { runWithShopHistory } from "../../lib/integrations/protractor/shop-history-context";
import { protractorFetch } from "../../lib/integrations/protractor/client";
import { pilotInvoiceIds } from "../../lib/protractor-afton-pilot-report";
import {weekendShopOrder,weekendNextShopIndex} from "../../lib/protractor-weekend-scheduling";
import {historyFailureCode,requireHistoryIdentityIndex} from "../../lib/protractor-history-existing-invoice";
import {getClient} from "../../lib/db/drizzle";
import { heldDayPush, sanitizedHeldFailure, type HeldFailure } from "../../lib/protractor-held-failure";
import {
  assertOwner, binding, collections, fleet, hash, log, RATE, recentActivity, runtime, sleep, workersSuspended,
} from "./shared";

async function child(pageId: string, owner: string): Promise<{ failure: HeldFailure; yielded: boolean }> {
  return new Promise((resolve, reject) => {
    let failure = sanitizedHeldFailure(null);
    let yielded = false;
    const deadline = Math.min(Date.now() + 180000, Date.parse(WEEKEND.end) - 120000);
    const proc = spawn(process.execPath,
      ["--import", "tsx", "scripts/protractor-weekend/main.ts", "--ingest", pageId, owner, String(deadline)],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env });
    proc.on("message", (message: any) => {
      if (message?.event === "weekend_ingest_yielded") yielded = true;
      if (message?.event === "weekend_ingest_failed") {
        failure = sanitizedHeldFailure(message);
        log("weekend_ingest_failed", { pageId, ...failure });
      }
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"),
      Math.max(1, deadline - Date.now()));
    proc.once("error", e => { clearTimeout(timer); reject(e); });
    proc.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) log("weekend_ingest_exit", { pageId, exitCode: code ?? 75 });
      resolve({ failure, yielded: yielded && code === 0 });
    });
  });
}
export async function run() {
  runtime(); await workersSuspended();
  await requireHistoryIdentityIndex(getClient());
  const { jobs, rates, pages, days } = await collections();
  const job = await jobs.findOne({ _id: WEEKEND.id, stopped: false }, { maxTimeMS: 5000 });
  assert.ok(job && ["prepared", "running", "paused"].includes(job.status), "Prepare campaign first");
  const state = await rates.findOne({ _id: RATE }, { maxTimeMS: 5000 });
  fleet(state); assert.equal(state.canary.generation, job.canaryGeneration);
  assert.ok(!state.weekendHistory || (state.weekendHistory.runId === job.runId &&
    state.weekendHistory.runnerLeaseUntil <= new Date()), "Another runner still owns the campaign");
  const owner = randomUUID(), leaseUntil = new Date(Date.now() + 240000);
  const first = job.shops[0]; assert.ok(first);
  const grant = {
    version: 4 as const, runId: job.runId, shopId: first.shopId,
    from: weekendFrom(first.shopId), until: WEEKEND.until,
    notBefore: new Date(WEEKEND.start), expiresAt: new Date(WEEKEND.end),
    canaryGeneration: job.canaryGeneration, bindingDigest: first.bindingDigest,
    maxRequests: WEEKEND.maxRequests, consumedRequests: state.weekendHistory?.consumedRequests ?? 0,
    stopped: true, owner, runnerLeaseUntil: leaseUntil, activityCheckedAt: new Date(0),
  };
  const claimed = await rates.updateOne({
    _id: RATE, "operatorStop.active": false, "canary.generation": job.canaryGeneration,
    ...(state.weekendHistory ? { "weekendHistory.runId": job.runId,
      "weekendHistory.runnerLeaseUntil": { $lte: new Date() },
      "weekendHistory.consumedRequests": grant.consumedRequests } : { weekendHistory: { $exists: false } }),
  }, { $set: { weekendHistory: grant } });
  assert.equal(claimed.matchedCount, 1);
  let stopping = false, heartbeatBusy = false;
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const own = await jobs.updateOne({ _id: WEEKEND.id, stopped: false, runId: job.runId },
      { $set: { owner, status: "running", leaseUntil, startedAt: new Date() } });
    assert.equal(own.matchedCount, 1);
    heartbeat = setInterval(async () => {
      if (heartbeatBusy || stopping) return;
      heartbeatBusy = true;
      try {
        const until = new Date(Math.min(Date.now() + 240000, Date.parse(WEEKEND.end) - 120000));
        const a = await jobs.updateOne({ _id: WEEKEND.id, owner, stopped: false, leaseUntil: { $gt: new Date() } },
          { $set: { leaseUntil: until, heartbeatAt: new Date() } });
        const b = await rates.updateOne({ _id: RATE, "weekendHistory.owner": owner,
          "weekendHistory.runnerLeaseUntil": { $gt: new Date() }, "operatorStop.active": false },
        { $set: { "weekendHistory.runnerLeaseUntil": until } });
        if (!a.matchedCount || !b.matchedCount) stopping = true;
      } catch { stopping = true; } finally { heartbeatBusy = false; }
    }, 30000);
    let lastWorkerCheck = 0, nextRequestAt = 0, consecutiveFailures = 0;
    let nextShopIndex = Number.isSafeInteger(job.nextShopIndex) ? job.nextShopIndex : 0;
    log("weekend_running", { shops: job.shops.length, cutoff: WEEKEND.end });
    while (!stopping && Date.now() < Date.parse(WEEKEND.end) - 180000) {
      await assertOwner(owner);
      if (Date.now() - lastWorkerCheck > 60000) { await workersSuspended(); lastWorkerCheck = Date.now(); }
      let unfinished = false, worked = false, cooldown = false;
      let callbackWaiting = false, nonCallbackWaiting = false;
      for (const entry of weekendShopOrder<any>(job.shops, nextShopIndex)) {
        if (stopping || Date.now() >= Date.parse(WEEKEND.end) - 180000) break;
        const shopJobId = `${WEEKEND.id}:shop:${entry.shopId}`;
        await jobs.updateOne({ _id: shopJobId }, { $setOnInsert: {
          campaignId: WEEKEND.id, shopId: entry.shopId, cursor: 0, page: 0, unresolved: 0, failures: 0,
        } }, { upsert: true });
        const cursor = await jobs.findOne({ _id: shopJobId }, { maxTimeMS: 5000 });
        if (cursor.cursor >= entry.pendingDays.length) continue;
        unfinished = true;
        if (cursor.retryAfter > new Date()) { nonCallbackWaiting = true; continue; }
        if (!callbackQuietEvidence(entry.callbackEvidence.map((d: string) => new Date(d)), new Date())) {
          callbackWaiting = true;
          await jobs.updateOne({ _id: shopJobId }, { $set: { status: "blocked-callback-evidence" } }); continue;
        }
        const activity = await recentActivity();
        if (activity.delayed >= 25) { callbackWaiting = true; nonCallbackWaiting = false; log("weekend_yield", { reason: "callback_delay" }); break; }
        if (activity.active.has(entry.shopId)) {
          callbackWaiting = true;
          await jobs.updateOne({ _id: shopJobId }, { $set: { status: "deferred-active-shop" } }); continue;
        }
        let failure: HeldFailure | undefined;
        try {
          // Persist fairness before attempting work. Restart resumes AFTER this
          // shop, but its exact day/page/held receipts remain unchanged.
          nextShopIndex=weekendNextShopIndex(job.shops.indexOf(entry),job.shops.length);
          const rotated=await jobs.updateOne({_id:WEEKEND.id,owner,stopped:false},
            {$set:{nextShopIndex}});
          assert.equal(rotated.matchedCount,1,"Campaign ownership lost");
          const current = await binding(entry.shopId);
          assert.equal(current.digest, entry.bindingDigest);
          const day = entry.pendingDays[cursor.cursor], pageNumber = cursor.page;
          const pageId = `${WEEKEND.id}:${entry.shopId}:${day}:${pageNumber}`;
          // Never open a grant before waiting: queue/activity must be fresh at dispatch.
          await sleep(Math.max(0, nextRequestAt - Date.now()));
          const fresh = await recentActivity();
          if (fresh.active.has(entry.shopId) || fresh.delayed >= 25) { callbackWaiting = true; continue; }
          nonCallbackWaiting = true;
          const updated = await rates.updateOne({ _id: RATE, "weekendHistory.owner": owner,
            "weekendHistory.runnerLeaseUntil": { $gt: new Date() }, "operatorStop.active": false,
            "canary.generation": job.canaryGeneration,
          }, { $set: { "weekendHistory.shopId": entry.shopId,
            "weekendHistory.from": weekendFrom(entry.shopId), "weekendHistory.bindingDigest": current.digest,
            "weekendHistory.stopped": false, "weekendHistory.activityCheckedAt": fresh.checkedAt } });
          assert.equal(updated.matchedCount, 1);
          const owned = await assertOwner(owner, entry.shopId);
          assert.ok(owned.state.weekendHistory.consumedRequests < WEEKEND.maxRequests, "Campaign request budget exhausted");
          let page = await pages.findOne({ _id: pageId }, { maxTimeMS: 5000 });
          if (!page) {
            const request: ShopHistoryRequest = { runId: job.runId, shopId: entry.shopId, day, pilot: "weekend" };
            // Grant is read-only Invoice list, through the existing relay/fleet pacer.
            nextRequestAt = Date.now() + 20000;
            const response = await runWithShopHistory(owned.state.weekendHistory, request, () =>
              protractorFetch<any>(historyEndpoint(request, pageNumber), current.config,
                { method: "GET" }, 0, entry.shopId,
                { maxRetries: 0, timeoutMs: 10000, deadlineAtMs: Date.now() + 12000 }));
            assert.ok(response.ok, "Provider read deferred");
            pilotInvoiceIds(response.data);
            const invoices = Array.isArray(response.data) ? response.data : response.data.ItemCollection;
            page = { _id: pageId, campaignId: WEEKEND.id, shopId: entry.shopId, day, page: pageNumber,
              invoices, digest: hash(invoices), checked: invoices.length === 0, imported: invoices.length === 0,
              unresolved: 0, capturedAt: new Date() };
            await pages.insertOne(page);
            await jobs.updateOne({ _id: WEEKEND.id, owner }, { $max: { capturedPageAt: page.capturedAt } });
          }
          assert.equal(hash(page.invoices), page.digest);
          if (!page.checked) {
            const outcome = await child(pageId, owner);
            failure = outcome.failure;
            page = await pages.findOne({ _id: pageId }, { maxTimeMS: 5000 });
            if (outcome.yielded && !page.checked && page.yieldedBy === owner) {
              await assertOwner(owner, entry.shopId);
              await jobs.updateOne({ _id: shopJobId, cursor: cursor.cursor, page: pageNumber },
                { $set: { status: "progressing", failures: 0, retryAfter: new Date(0) } });
              consecutiveFailures = 0; worked = true;
              log("weekend_page_yielded", { shopId: entry.shopId, day, page: pageNumber });
              continue; // finally closes the grant; the next shop gets its turn.
            }
          }
          // A timed-out page stays at its exact position. After three attempts,
          // preserve it as unresolved and allow other days/shops to proceed.
          if (!page.checked) throw Error("Local ingestion deferred");
          failure = undefined;
          const terminal = page.invoices.length < 100;
          const pageLimit = !terminal && pageNumber === 99;
          const unresolved = (page.unresolved || 0) + (pageLimit ? 1 : 0);
          await assertOwner(owner);
          await days.updateOne({ _id: `${WEEKEND.id}:${entry.shopId}:${day}` },
            { $set: { campaignId: WEEKEND.id, shopId: entry.shopId, day, checkedAt: new Date(),
              terminal, lastPage: pageNumber }, $inc: { unresolved } }, { upsert: true });
          await jobs.updateOne({ _id: shopJobId, cursor: cursor.cursor, page: pageNumber },
            { $set: { cursor: cursor.cursor + (terminal || pageLimit ? 1 : 0),
              page: terminal || pageLimit ? 0 : pageNumber + 1, failures: 0,
              status: "progressing", lastProgressAt: new Date() }, $inc: { unresolved } });
          consecutiveFailures = 0; worked = true;
          if (unresolved === 0) await jobs.updateOne({ _id: WEEKEND.id, owner },
            { $max: { completedPageAt: new Date() } });
          log("weekend_progress", { shopId: entry.shopId, day, page: pageNumber,
            invoiceCount: page.invoices.length, unresolved });
        } catch (error) {
          nonCallbackWaiting = true;
          consecutiveFailures++;
          const failures = (cursor.failures || 0) + 1;
          const checkpoints = jobs as Collection<{
            _id: string;
            heldDays: string[];
            heldFailures: ReturnType<typeof heldDayPush>["heldFailures"][];
            status: string;
            retryAfter: Date;
            failures: number;
            cursor: number;
            page: number;
            unresolved: number;
          }>;
          await checkpoints.updateOne({ _id: shopJobId }, {
            $set: { status: "deferred-error", retryAfter: new Date(Date.now() + 15 * 60000),
              failures: failures >= 3 ? 0 : failures,
              ...(failures >= 3 ? { cursor: cursor.cursor + 1, page: 0 } : {}) },
            ...(failures >= 3 ? { $inc: { unresolved: 1 }, $push:
              heldDayPush(entry.pendingDays[cursor.cursor], cursor.page,
                failure ?? { stage: "unknown", code: historyFailureCode(error) }) } : {}),
          });
          log("weekend_deferred", { shopId: entry.shopId, attempts: failures, code:historyFailureCode(error) });
          if (failures >= 3) await jobs.updateOne({ _id: WEEKEND.id, owner },
            { $max: { heldDayAdvanceAt: new Date() } });
          if (consecutiveFailures >= 3) {
            log("weekend_yield", { reason: "repeated_errors",nextShopIndex });
            consecutiveFailures=0;cooldown=true;break;
          }
        } finally {
          await rates.updateOne({ _id: RATE, "weekendHistory.owner": owner },
            { $set: { "weekendHistory.stopped": true } });
        }
      }
      await jobs.updateOne({ _id: WEEKEND.id, owner }, { $set: {
        callbackWaitUntil: callbackWaiting && !nonCallbackWaiting && !worked
          ? new Date(Date.now() + 120000) : new Date(0),
      } });
      // The grant has been closed by finally before waiting. Retain the fleet
      // cooldown, but resume with the next shop and a fresh failure streak.
      if(cooldown){
        await sleep(Math.max(0,Math.min(15*60000,Date.parse(WEEKEND.end)-Date.now()-180000)));
        continue;
      }
      if (!unfinished) {
        const progress = await jobs.find({ _id: { $in: job.shops.map((s: any) => `${WEEKEND.id}:shop:${s.shopId}`) } },
          { projection: { unresolved: 1 }, maxTimeMS: 5000 }).toArray();
        const unresolved = progress.reduce((n, s) => n + (s.unresolved || 0), 0);
        await jobs.updateOne({ _id: WEEKEND.id, owner },
          { $set: { status: unresolved ? "needs-attention" : "completed", unresolved, endedAt: new Date() } });
        return;
      }
      if (!worked) await sleep(60000);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    stopping = true;
    await rates.updateOne({ _id: RATE, "weekendHistory.owner": owner },
      { $set: { "weekendHistory.stopped": true, "weekendHistory.runnerLeaseUntil": new Date() } });
    await jobs.updateOne({ _id: WEEKEND.id, owner, status: "running" },
      { $set: { status: Date.now() >= Date.parse(WEEKEND.end) - 180000 ? "expired" : "paused",
        leaseUntil: new Date(), endedAt: new Date() } });
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
  }
}
