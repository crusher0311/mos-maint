#!/usr/bin/env node
// Tekmetric prod catch-up runner — one shop at a time.
//
// Strategy: the prod cron POST endpoint runs chunks that often take 6-12 min,
// but Cloudflare/Render edge kills HTTP connections at ~5 min. The fetch will
// "fail" but the chunk keeps running on prod (Next.js doesn't cancel handlers
// on client disconnect). So we:
//   1. POST {shopId} — wait at most BOOTSTRAP_TIMEOUT for the chunk to *start*
//      on prod (detected by lastRunAt updating in Mongo)
//   2. Poll Mongo every POLL_INTERVAL_MS for cursor movement / completion /
//      lastChunkMetrics update — DO NOT POST again while we believe a chunk
//      is in flight. (Posting again starts a duplicate chunk!)
//   3. When cursor advances OR shop is marked complete OR no movement for
//      STUCK_THRESHOLD_MS, decide: continue to next chunk, mark complete,
//      or skip the shop.
//
// Required env: CRON_SECRET, MONGODB_USERNAME, MONGODB_PASSWORD
// Optional env: PROD_BASE_URL (default https://mos.tools), ONLY_SHOPS,
//               SKIP_SHOPS, MAX_CHUNKS_PER_SHOP (default 30),
//               POLL_INTERVAL_MS (default 20000), STUCK_THRESHOLD_MS
//               (default 1500000 = 25 min), BOOTSTRAP_TIMEOUT_MS (default
//               45000), DRY_RUN (default false)
//
// This file is also imported by `tests/tekmetric-catchup.smoke.mjs` to
// exercise processShop() and renderSummary() with a fake getProgress + fake
// fireChunk + fake clock — no live Mongo, no live POST. The top-level Mongo
// connect / main() runs only when invoked directly as a CLI script.

import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  buildCatchupRunSummary,
  persistCatchupRunSummary,
  CATCHUP_RUN_RETENTION,
} from "./lib/catchup-runs.mjs";

const require = createRequire(import.meta.url);

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers / config — safe to import.
// ────────────────────────────────────────────────────────────────────────────

const ts = () => `[${new Date().toISOString().replace("T", " ").replace("Z", "")}]`;
const defaultLog = (...a) => console.log(ts(), ...a);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultNow = () => Date.now();

export const isoOrNull = (d) =>
  d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null;

export function getConfig(env = process.env) {
  const onlyShops = (env.ONLY_SHOPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n));
  const skipShops = (env.SKIP_SHOPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n));
  return {
    PROD_BASE_URL:           env.PROD_BASE_URL       || "https://mos.tools",
    CRON_SECRET:             env.CRON_SECRET         || "",
    DRY_RUN:                 env.DRY_RUN             === "true",
    MAX_CHUNKS:              Number(env.MAX_CHUNKS_PER_SHOP || 30),
    POLL_INTERVAL_MS:        Number(env.POLL_INTERVAL_MS    || 20_000),
    // 60 min default. Empirical evidence from shop 99 catch-up on 2026-04-28:
    // chunk 1 took 43.7 min wall-clock end-to-end (durationMs=2,623,028 for
    // 2,187 ROs, normalize phase made ~280 fresh /jobs API calls when cache
    // missed → 57s of 429 backoff). 45 min was borderline (1.3 min margin);
    // 60 min gives real headroom for shops that have heavier normalize work
    // or hit a 429 storm during bulk-write.
    STUCK_THRESHOLD_MS:      Number(env.STUCK_THRESHOLD_MS  || 60 * 60 * 1000),
    BOOTSTRAP_TIMEOUT:       Number(env.BOOTSTRAP_TIMEOUT_MS || 45_000),
    INTER_SHOP_DELAY:        Number(env.INTER_SHOP_DELAY_MS  || 5_000),
    // When a chunk hits stuck=true (no movement in STUCK_THRESHOLD_MS), give
    // the shop ONE more shot at the same chunk after a short cooldown.
    // Empirical evidence from the 2026-04-28/29 run: shop 32 hit a transient
    // stuck on chunk 3 (POST returned but cron never updated metrics or
    // lastRunAt) and the script abandoned the shop ~9 months short of its
    // 2-year goal — a single retry would almost certainly have unstuck it.
    // Multi-retry is intentionally NOT supported: keeps prod load bounded.
    STUCK_RETRY_COOLDOWN_MS: Number(env.STUCK_RETRY_COOLDOWN_MS || 30_000),
    ONLY_SHOPS:              onlyShops,
    SKIP_SHOPS:              skipShops,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// processShop — the per-shop chunk loop. Pure modulo injected deps so tests
// can drive it without a real Mongo / real fetch / real clock.
//
// deps:
//   - getProgress(shopId): async () => progress doc | null
//   - fireChunk(shopId): async () => { status, ms, body, finishedFast }
//                        (also responsible for stamping scriptFiredAt in prod)
//   - config: as returned by getConfig()
//   - sleep(ms): async; defaults to setTimeout
//   - now(): ms epoch; defaults to Date.now (override for fake clock)
//   - log(...args): defaults to console.log with timestamp prefix
// ────────────────────────────────────────────────────────────────────────────

export async function processShop(shopId, deps) {
  const {
    getProgress,
    fireChunk,
    config,
    sleep = defaultSleep,
    now = defaultNow,
    log = defaultLog,
  } = deps;
  const {
    MAX_CHUNKS,
    POLL_INTERVAL_MS,
    STUCK_THRESHOLD_MS,
    STUCK_RETRY_COOLDOWN_MS,
    DRY_RUN,
  } = config;

  log(`=== SHOP ${shopId} START ===`);

  // Track per-shop stuck-retry state across chunks. `stuckRetryForChunk`
  // holds the chunk number for which we've already burned the one-shot
  // retry; if the same chunk stucks again we give up. `recoveredFromStuck`
  // becomes true if any chunk advanced/completed AFTER its stuck retry —
  // used to bucket the shop in the end-of-run summary.
  let stuckRetryForChunk = 0;
  let recoveredFromStuck = false;

  for (let chunk = 1; chunk <= MAX_CHUNKS; chunk++) {
    const isStuckRetry = stuckRetryForChunk === chunk;
    const before = await getProgress(shopId);
    if (before?.complete || before?.completed) {
      log(`   ✓ Shop ${shopId} already complete`);
      return { outcome: recoveredFromStuck ? "recovered" : "completed" };
    }
    const beforeCursor  = isoOrNull(before?.currentChunkEnd);
    const beforeRunAt   = before?.lastRunAt ? new Date(before.lastRunAt).getTime() : 0;
    const beforeMetrics = before?.lastChunkMetrics?.at ? new Date(before.lastChunkMetrics.at).getTime() : 0;
    const beforeJobs    = before?.totalJobsIndexed || 0;

    log(`   chunk ${chunk}/${MAX_CHUNKS}${isStuckRetry ? " [STUCK-RETRY]" : ""}  before:  cursor=${beforeCursor?.slice(0, 19)}  jobs=${beforeJobs}`);

    // Safety: don't stack a duplicate chunk if prod looks busy on this shop.
    // Three independent signals indicate a chunk is already running:
    //   1. inProgress=true (legacy field, rarely set by cron)
    //   2. A chunk run completed in the last 15 min and the metrics doc was
    //      updated AT THE SAME TIME (i.e. the daily cron just finished a
    //      chunk and a fresh one might still be processing the next date
    //      window)
    //   3. scriptFiredAt was set by a previous run of THIS script within
    //      STUCK_THRESHOLD_MS and lastChunkMetrics.at hasn't advanced past
    //      it (chunk we kicked off is still mid-bulk-write). This is the
    //      Ctrl-C + re-run safety net.
    //
    // EXCEPTION: on a stuck retry we KNOW prod hasn't moved for
    // STUCK_THRESHOLD_MS (that's why we're retrying), but the prior
    // scriptFiredAt + un-advanced metrics will still trip looksBusy. Skip
    // the busy check entirely on the retry pass — the whole point is to
    // re-fire the same window.
    const beforeFired = before?.scriptFiredAt ? new Date(before.scriptFiredAt).getTime() : 0;
    const firedRecently = beforeFired > now() - STUCK_THRESHOLD_MS;
    const firedChunkUnfinished = firedRecently && beforeMetrics < beforeFired;
    const looksBusy = !isStuckRetry && (
      before?.inProgress === true ||
      (beforeRunAt > now() - 15 * 60 * 1000 && beforeMetrics < beforeRunAt) ||
      firedChunkUnfinished
    );
    if (looksBusy) {
      const reason = firedChunkUnfinished
        ? `prior script run fired chunk at ${new Date(beforeFired).toISOString()} not yet reflected in metrics`
        : `lastRunAt=${new Date(beforeRunAt).toISOString()} inProgress=${before?.inProgress}`;
      log(`   ⚠ Prod looks busy on shop ${shopId} (${reason}). Waiting for it to drain before firing...`);
      const drainDeadline = now() + STUCK_THRESHOLD_MS;
      let drained = false;
      while (now() < drainDeadline) {
        await sleep(POLL_INTERVAL_MS);
        const cur = await getProgress(shopId);
        const nowMetrics = cur?.lastChunkMetrics?.at ? new Date(cur.lastChunkMetrics.at).getTime() : 0;
        const nowCursor  = isoOrNull(cur?.currentChunkEnd);
        log(`   drain-poll: cursor=${nowCursor?.slice(0, 10)} metrics@=${nowMetrics > beforeMetrics ? "NEW" : "old"} inProgress=${cur?.inProgress} complete=${cur?.complete || cur?.completed}`);
        if (cur?.complete || cur?.completed) {
          log(`   ✓ Shop ${shopId} COMPLETE during drain wait`);
          return { outcome: recoveredFromStuck ? "recovered" : "completed" };
        }
        if (nowCursor !== beforeCursor || nowMetrics > beforeMetrics) {
          log(`   ✓ Drain wait satisfied — cursor advanced or metrics updated. Loop continues with fresh snapshot.`);
          chunk--; // re-snapshot at top of loop
          drained = true;
          break;
        }
      }
      if (!drained) {
        log(`   ✗ Drain wait exceeded ${STUCK_THRESHOLD_MS / 60000}min — moving on`);
        return { outcome: "needs-followup", reason: `drain wait exceeded ${STUCK_THRESHOLD_MS / 60000}min on chunk ${chunk}` };
      }
      continue;
    }

    if (DRY_RUN) {
      log(`   [DRY_RUN] would POST shopId=${shopId}`);
      return { outcome: "dry-run" };
    }

    let fired;
    try {
      fired = await fireChunk(shopId);
    } catch (e) {
      log(`   !! fire error: ${e.message} — sleeping 30s and retrying chunk`);
      await sleep(30_000);
      chunk--;
      continue;
    }

    if (fired.status === 401) {
      log(`   !! 401 Unauthorized — CRON_SECRET wrong, aborting`);
      return { outcome: "needs-followup", reason: "401 Unauthorized (CRON_SECRET wrong)" };
    }
    if (fired.status >= 500) {
      log(`   !! HTTP ${fired.status} from prod — sleeping 60s and retrying chunk`);
      await sleep(60_000);
      chunk--;
      continue;
    }

    if (fired.finishedFast) {
      // Got a real response. Either the chunk finished quickly OR no work was needed.
      log(`   POST returned ${fired.status} in ${fired.ms}ms (small chunk or no work)`);
    } else {
      log(`   POST sent (chunk running on prod) — polling Mongo every ${POLL_INTERVAL_MS / 1000}s for cursor movement...`);
    }

    // Poll Mongo until we detect chunk completion (or stuck timeout)
    const pollDeadline = now() + STUCK_THRESHOLD_MS;
    let lastSeenMetricsAt = beforeMetrics;
    let advanced = false, completed = false, stuck = false;

    while (now() < pollDeadline) {
      await sleep(POLL_INTERVAL_MS);
      const cur = await getProgress(shopId);
      if (!cur) { log(`   ?? progress doc disappeared`); stuck = true; break; }

      const nowCursor    = isoOrNull(cur.currentChunkEnd);
      const nowMetricsAt = cur.lastChunkMetrics?.at ? new Date(cur.lastChunkMetrics.at).getTime() : 0;
      const nowJobs      = cur.totalJobsIndexed || 0;
      const nowComplete  = !!(cur.complete || cur.completed);

      log(`   poll: cursor=${nowCursor?.slice(0, 10)} jobs=${nowJobs} metrics@=${nowMetricsAt > beforeMetrics ? "NEW" : "old"} complete=${nowComplete}`);

      if (nowComplete) { completed = true; break; }
      if (nowCursor !== beforeCursor) { advanced = true; break; }
      if (nowMetricsAt > lastSeenMetricsAt) {
        // Chunk metrics updated even though cursor didn't change — chunk
        // completed but advanceMode said don't advance. Treat as progress.
        advanced = true; break;
      }
    }
    if (!advanced && !completed) stuck = true;

    const after = await getProgress(shopId);
    log(`   chunk ${chunk} result: advanced=${advanced} completed=${completed} stuck=${stuck}  cursor: ${beforeCursor?.slice(0, 10)} → ${isoOrNull(after?.currentChunkEnd)?.slice(0, 10)}  jobs: ${beforeJobs} → ${after?.totalJobsIndexed || 0}  err=${after?.lastError || "null"}`);

    if (completed) {
      // The cron writes BOTH `complete` and legacy `completed: true` paths;
      // we treat either as done (matches the listIncomplete + before-snapshot
      // checks above) so we don't drop a real completion just because the
      // dual-flag check didn't fire.
      const outcome = (recoveredFromStuck || isStuckRetry) ? "recovered" : "completed";
      log(`   ✓ Shop ${shopId} COMPLETE after ${chunk} chunk(s)${outcome === "recovered" ? " (recovered via stuck retry)" : ""}`);
      return { outcome };
    }
    if (stuck) {
      if (!isStuckRetry) {
        log(`   ⟳ Shop ${shopId} chunk ${chunk} STUCK — retrying once after ${STUCK_RETRY_COOLDOWN_MS / 1000}s cooldown`);
        stuckRetryForChunk = chunk;
        await sleep(STUCK_RETRY_COOLDOWN_MS);
        chunk--; // re-do this chunk; isStuckRetry will be true on the next pass
        continue;
      }
      log(`   ✗ Shop ${shopId} STUCK on chunk ${chunk} after retry — needs follow-up`);
      return { outcome: "needs-followup", reason: `stuck on chunk ${chunk} after one retry` };
    }
    // advanced — if this was the retry pass, mark recovery and loop on
    if (isStuckRetry) {
      recoveredFromStuck = true;
      log(`   ✓ Stuck retry recovered chunk ${chunk} — continuing`);
    }
  }
  log(`   ✗ Shop ${shopId} did not complete after ${MAX_CHUNKS} chunks — needs follow-up`);
  return { outcome: "needs-followup", reason: `did not complete after ${MAX_CHUNKS} chunks` };
}

// ────────────────────────────────────────────────────────────────────────────
// renderSummary — prints the end-of-run summary block. Pulled out so tests
// can assert the bucket counts and the suggested ONLY_SHOPS=… re-run line.
//
// `log` is injected so tests can capture the lines instead of writing to
// stdout. Returns the array of lines that were written, for convenience.
// ────────────────────────────────────────────────────────────────────────────

export function renderSummary(results, opts = {}, log = defaultLog) {
  const { dryRun = false } = opts;
  const completed     = results.filter((r) => r.outcome === "completed");
  const recovered     = results.filter((r) => r.outcome === "recovered");
  const needsFollowup = results.filter((r) => r.outcome === "needs-followup");
  const dryRunBucket  = results.filter((r) => r.outcome === "dry-run");

  const lines = [];
  const emit = (line) => { lines.push(line); log(line); };

  emit(`\n========== SUMMARY ==========`);
  emit(`Total shops processed: ${results.length}`);
  if (dryRun) {
    emit(`Dry-run (would have fired) (${dryRunBucket.length}): ${dryRunBucket.map((r) => r.shopId).join(", ") || "(none)"}`);
  }
  emit(`Completed cleanly (${completed.length}): ${completed.map((r) => r.shopId).join(", ") || "(none)"}`);
  emit(`Recovered via stuck-retry (${recovered.length}): ${recovered.map((r) => r.shopId).join(", ") || "(none)"}`);
  emit(`Needs follow-up (${needsFollowup.length}):${needsFollowup.length === 0 ? " (none)" : ""}`);
  for (const r of needsFollowup) {
    emit(`    shop ${r.shopId} — ${r.reason || "unknown"}`);
  }
  if (needsFollowup.length > 0) {
    const ids = needsFollowup.map((r) => r.shopId).join(",");
    emit(``);
    emit(`Suggested re-run command for the not-recovered shops:`);
    emit(`    ONLY_SHOPS=${ids} node scripts/tekmetric-catchup.mjs`);
  }
  emit(`========== DONE ==========`);

  return lines;
}

// ────────────────────────────────────────────────────────────────────────────
// CLI entrypoint — only runs when invoked directly (not when imported by a
// test). Owns Mongo connection + fireChunk(shop) wrapper that POSTs to prod.
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date();
  const config = getConfig();
  const {
    PROD_BASE_URL, CRON_SECRET, DRY_RUN, MAX_CHUNKS, POLL_INTERVAL_MS,
    STUCK_THRESHOLD_MS, BOOTSTRAP_TIMEOUT, INTER_SHOP_DELAY,
    ONLY_SHOPS, SKIP_SHOPS,
  } = config;

  if (!CRON_SECRET) { console.error("ERROR: CRON_SECRET env var is required"); process.exit(1); }
  if (!process.env.MONGODB_USERNAME || !process.env.MONGODB_PASSWORD) {
    console.error("ERROR: MONGODB_USERNAME and MONGODB_PASSWORD env vars are required");
    process.exit(1);
  }

  const { MongoClient } = require(path.resolve("./node_modules/mongodb"));
  const mongoUri = `mongodb+srv://${process.env.MONGODB_USERNAME}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  const db = mongo.db("mos-maintenance-mvp");

  const log = defaultLog;

  async function listIncomplete() {
    const docs = await db.collection("tekmetric_backfill_progress")
      // The cron writes legacy `completed: true` (with -ed) at app/api/cron/tekmetric-backfill/route.ts:475
      // when a shop reaches the oldest date or has no Tekmetric link, but never
      // sets the newer `complete: true` field that the rest of this script reads.
      // Treat either as "done" so we don't pick up already-finished shops.
      .find({ complete: { $ne: true }, completed: { $ne: true } })
      .project({ shopId: 1, currentChunkEnd: 1, totalJobsIndexed: 1, lastError: 1, lastRunAt: 1, _id: 0 })
      .toArray();
    let f = docs;
    if (ONLY_SHOPS.length) f = f.filter((d) => ONLY_SHOPS.includes(d.shopId));
    if (SKIP_SHOPS.length) f = f.filter((d) => !SKIP_SHOPS.includes(d.shopId));
    f.sort((a, b) => (a.shopId || 0) - (b.shopId || 0));
    return f;
  }

  async function getProgress(shopId) {
    return db.collection("tekmetric_backfill_progress").findOne({ shopId });
  }

  async function fireChunk(shopId) {
    // POST to enqueue. We DON'T need the response body — we'll detect
    // completion via Mongo. We use a short timeout: if the request is at
    // least accepted by prod within BOOTSTRAP_TIMEOUT, we trust the handler
    // is running.
    //
    // BEFORE posting, stamp `scriptFiredAt` on the progress doc. The prod
    // cron does NOT set any "I'm running" marker on chunk start — only on
    // chunk end (lastRunAt) — so without our own marker, a Ctrl-C + re-run
    // can't tell that a chunk is in flight and would fire a duplicate. The
    // stamp also lets the same script invocation's looksBusy check survive
    // across chunks.
    await db.collection("tekmetric_backfill_progress").updateOne(
      { shopId },
      { $set: { scriptFiredAt: new Date() } },
    );

    const url = `${PROD_BASE_URL}/api/cron/tekmetric-backfill`;
    const ctrl = new AbortController();
    // Use an explicit boolean to detect OUR abort, since the resulting error
    // shape varies wildly across Node/undici versions (e.message can be
    // empty, e.name may be DOMException, the error may surface from
    // r.text() instead of fetch(), etc). If `bootstrapAborted` is true and
    // we got an error, it's our timer — the chunk is running on prod.
    let bootstrapAborted = false;
    const timer = setTimeout(() => { bootstrapAborted = true; ctrl.abort(); }, BOOTSTRAP_TIMEOUT);
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CRON_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ shopId }),
        signal: ctrl.signal,
      });
      let body = "";
      try { body = await r.text(); }
      catch {
        // Body stream aborted (likely by our timer). Status is still valid,
        // but the chunk is most likely still running on prod, not "finishedFast".
        return { status: r.status, ms: Date.now() - t0, body: "", finishedFast: false };
      }
      return { status: r.status, ms: Date.now() - t0, body, finishedFast: true };
    } catch (e) {
      // OUR timer fired → chunk is running on prod (expected for slow shops)
      if (bootstrapAborted || ctrl.signal.aborted) {
        return { status: 0, ms: Date.now() - t0, body: "", finishedFast: false };
      }
      // Real network error (DNS, TLS, connection refused, etc) before our
      // timer — surface it. Include cause for nicer diagnostics since
      // e.message is often empty for fetch errors.
      const detail = e?.message || e?.cause?.message || e?.code || e?.cause?.code || String(e);
      const wrapped = new Error(`fetch failed: ${detail}`);
      wrapped.cause = e;
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }

  log(`Tekmetric catch-up starting`);
  log(`PROD_BASE_URL=${PROD_BASE_URL}  DRY_RUN=${DRY_RUN}  MAX_CHUNKS_PER_SHOP=${MAX_CHUNKS}  POLL=${POLL_INTERVAL_MS / 1000}s  STUCK_AFTER=${STUCK_THRESHOLD_MS / 60000}min`);
  if (ONLY_SHOPS.length) log(`ONLY_SHOPS filter: ${ONLY_SHOPS.join(",")}`);
  if (SKIP_SHOPS.length) log(`SKIP_SHOPS filter: ${SKIP_SHOPS.join(",")}`);

  const shops = await listIncomplete();
  log(`${shops.length} incomplete shop(s) to process:`);
  for (const s of shops) log(`    shop=${s.shopId}  cursor=${isoOrNull(s.currentChunkEnd)?.slice(0, 10)}  jobs=${s.totalJobsIndexed || 0}  lastErr=${s.lastError ? "Y" : "N"}`);

  // Collect per-shop outcomes for the end-of-run summary so on-call doesn't
  // have to grep the log to figure out which shops still need a follow-up
  // run.
  const results = [];
  const deps = { getProgress, fireChunk, config, log };
  for (let i = 0; i < shops.length; i++) {
    const shopId = shops[i].shopId;
    log(`\n>>> ${i + 1}/${shops.length}: shop ${shopId}`);
    const result = await processShop(shopId, deps);
    results.push({ shopId, ...result });
    if (i < shops.length - 1) {
      log(`   sleeping ${INTER_SHOP_DELAY / 1000}s before next shop...`);
      await defaultSleep(INTER_SHOP_DELAY);
    }
  }

  renderSummary(results, { dryRun: DRY_RUN }, log);

  // Persist this run's summary so admins can read the last ~20 catch-up
  // outcomes from the sync-health view instead of having to grep a
  // multi-hour log (or, worse, re-run the script). Best-effort: a Mongo
  // hiccup here must not poison the script's exit code, since the real
  // catch-up work is already done.
  const finishedAt = new Date();
  const summary = buildCatchupRunSummary({
    results,
    dryRun: DRY_RUN,
    onlyShops: ONLY_SHOPS,
    skipShops: SKIP_SHOPS,
    startedAt,
    finishedAt,
    prodBaseUrl: PROD_BASE_URL,
  });
  const persistRes = await persistCatchupRunSummary(db, summary, {
    keep: CATCHUP_RUN_RETENTION,
  });
  if (persistRes.ok) {
    log(`(Persisted run summary to tekmetric_catchup_runs; pruned ${persistRes.prunedCount} older run(s), keeping last ${CATCHUP_RUN_RETENTION}.)`);
  } else {
    log(`(WARN: failed to persist run summary: ${persistRes.error})`);
  }

  await mongo.close();
  const needsFollowup = results.filter((r) => r.outcome === "needs-followup");
  process.exit(needsFollowup.length > 0 ? 1 : 0);
}

const isMainModule = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(2);
  });
}
