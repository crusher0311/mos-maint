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

import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MongoClient } = require(path.resolve("./node_modules/mongodb"));

const PROD_BASE_URL       = process.env.PROD_BASE_URL       || "https://mos.tools";
const CRON_SECRET         = process.env.CRON_SECRET         || "";
const DRY_RUN             = process.env.DRY_RUN             === "true";
const MAX_CHUNKS          = Number(process.env.MAX_CHUNKS_PER_SHOP || 30);
const POLL_INTERVAL_MS    = Number(process.env.POLL_INTERVAL_MS    || 20_000);
const STUCK_THRESHOLD_MS  = Number(process.env.STUCK_THRESHOLD_MS  || 25 * 60 * 1000);
const BOOTSTRAP_TIMEOUT   = Number(process.env.BOOTSTRAP_TIMEOUT_MS || 45_000);
const INTER_SHOP_DELAY    = Number(process.env.INTER_SHOP_DELAY_MS  || 5_000);
const ONLY_SHOPS = (process.env.ONLY_SHOPS || "").split(",").map(s=>s.trim()).filter(Boolean).map(Number).filter(n=>!isNaN(n));
const SKIP_SHOPS = (process.env.SKIP_SHOPS || "").split(",").map(s=>s.trim()).filter(Boolean).map(Number).filter(n=>!isNaN(n));

if (!CRON_SECRET) { console.error("ERROR: CRON_SECRET env var is required"); process.exit(1); }
if (!process.env.MONGODB_USERNAME || !process.env.MONGODB_PASSWORD) { console.error("ERROR: MONGODB_USERNAME and MONGODB_PASSWORD env vars are required"); process.exit(1); }

const ts = () => `[${new Date().toISOString().replace("T"," ").replace("Z","")}]`;
const log = (...a) => console.log(ts(), ...a);

const mongoUri = `mongodb+srv://${process.env.MONGODB_USERNAME}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
const mongo = new MongoClient(mongoUri);
await mongo.connect();
const db = mongo.db("mos-maintenance-mvp");

const isoOrNull = (d) => (d instanceof Date ? d.toISOString() : (typeof d === "string" ? d : null));

async function listIncomplete() {
  const docs = await db.collection("tekmetric_backfill_progress")
    .find({ complete: { $ne: true } })
    .project({ shopId:1, currentChunkEnd:1, totalJobsIndexed:1, lastError:1, lastRunAt:1, _id:0 })
    .toArray();
  let f = docs;
  if (ONLY_SHOPS.length) f = f.filter(d => ONLY_SHOPS.includes(d.shopId));
  if (SKIP_SHOPS.length) f = f.filter(d => !SKIP_SHOPS.includes(d.shopId));
  f.sort((a,b) => (a.shopId||0) - (b.shopId||0));
  return f;
}

async function getProgress(shopId) {
  return db.collection("tekmetric_backfill_progress").findOne({ shopId });
}

async function fireChunk(shopId) {
  // POST to enqueue. We DON'T need the response body — we'll detect completion
  // via Mongo. We use a short timeout: if the request is at least accepted by
  // prod within BOOTSTRAP_TIMEOUT, we trust the handler is running.
  const url = `${PROD_BASE_URL}/api/cron/tekmetric-backfill`;
  const ctrl = new AbortController();
  // Use an explicit boolean to detect OUR abort, since the resulting error
  // shape varies wildly across Node/undici versions (e.message can be empty,
  // e.name may be DOMException, the error may surface from r.text() instead
  // of fetch(), etc). If `bootstrapAborted` is true and we got an error,
  // it's our timer — the chunk is running on prod.
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
    // We got headers within BOOTSTRAP_TIMEOUT. Read the body separately —
    // if our timer then fires mid-stream, we still have the status code.
    let body = "";
    try { body = await r.text(); }
    catch {
      // Body stream aborted (likely by our timer). Status is still valid,
      // but the chunk is most likely still running on prod, not "finishedFast".
      return { status: r.status, ms: Date.now()-t0, body: "", finishedFast: false };
    }
    return { status: r.status, ms: Date.now()-t0, body, finishedFast: true };
  } catch (e) {
    // OUR timer fired → chunk is running on prod (expected for slow shops)
    if (bootstrapAborted || ctrl.signal.aborted) {
      return { status: 0, ms: Date.now()-t0, body: "", finishedFast: false };
    }
    // Real network error (DNS, TLS, connection refused, etc) before our timer
    // — surface it. Include cause for nicer diagnostics since e.message is
    // often empty for fetch errors.
    const detail = e?.message || e?.cause?.message || e?.code || e?.cause?.code || String(e);
    const wrapped = new Error(`fetch failed: ${detail}`);
    wrapped.cause = e;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

async function processShop(shopId) {
  log(`=== SHOP ${shopId} START ===`);

  for (let chunk = 1; chunk <= MAX_CHUNKS; chunk++) {
    const before = await getProgress(shopId);
    if (before?.complete) { log(`   ✓ Shop ${shopId} already complete`); return true; }
    const beforeCursor  = isoOrNull(before?.currentChunkEnd);
    const beforeRunAt   = before?.lastRunAt ? new Date(before.lastRunAt).getTime() : 0;
    const beforeMetrics = before?.lastChunkMetrics?.at ? new Date(before.lastChunkMetrics.at).getTime() : 0;
    const beforeJobs    = before?.totalJobsIndexed || 0;

    log(`   chunk ${chunk}/${MAX_CHUNKS}  before:  cursor=${beforeCursor?.slice(0,19)}  jobs=${beforeJobs}`);

    // Safety: don't stack a duplicate chunk if prod looks busy on this shop.
    // Heuristic: if inProgress=true, OR a chunk run started within the last
    // 15 min and hasn't completed (no metrics update since then), assume
    // something else (zombie from an old script run, or the daily cron) is
    // already working on it. Wait until it drains before firing.
    const looksBusy = before?.inProgress === true ||
      (beforeRunAt > Date.now() - 15 * 60 * 1000 && beforeMetrics < beforeRunAt);
    if (looksBusy) {
      log(`   ⚠ Prod looks busy on shop ${shopId} (lastRunAt=${new Date(beforeRunAt).toISOString()} inProgress=${before?.inProgress}). Waiting for it to drain before firing...`);
      const drainDeadline = Date.now() + STUCK_THRESHOLD_MS;
      while (Date.now() < drainDeadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const now = await getProgress(shopId);
        const nowMetrics = now?.lastChunkMetrics?.at ? new Date(now.lastChunkMetrics.at).getTime() : 0;
        const nowCursor  = isoOrNull(now?.currentChunkEnd);
        process.stdout.write(`${ts()}    drain-poll: cursor=${nowCursor?.slice(0,10)} metrics@=${nowMetrics > beforeMetrics ? "NEW" : "old"} inProgress=${now?.inProgress} complete=${now?.complete}\n`);
        if (now?.complete) { log(`   ✓ Shop ${shopId} COMPLETE during drain wait`); return true; }
        if (nowCursor !== beforeCursor || nowMetrics > beforeMetrics) {
          log(`   ✓ Drain wait satisfied — cursor advanced or metrics updated. Loop continues with fresh snapshot.`);
          chunk--; // re-snapshot at top of loop
          break;
        }
      }
      if (Date.now() >= drainDeadline) { log(`   ✗ Drain wait exceeded ${STUCK_THRESHOLD_MS/60000}min — moving on`); return false; }
      continue;
    }

    if (DRY_RUN) { log(`   [DRY_RUN] would POST shopId=${shopId}`); break; }

    let fired;
    try { fired = await fireChunk(shopId); }
    catch (e) { log(`   !! fire error: ${e.message} — sleeping 30s and retrying chunk`); await new Promise(r=>setTimeout(r,30_000)); chunk--; continue; }

    if (fired.status === 401) { log(`   !! 401 Unauthorized — CRON_SECRET wrong, aborting`); return false; }
    if (fired.status >= 500)  { log(`   !! HTTP ${fired.status} from prod — sleeping 60s and retrying chunk`); await new Promise(r=>setTimeout(r,60_000)); chunk--; continue; }

    if (fired.finishedFast) {
      // Got a real response. Either the chunk finished quickly OR no work was needed.
      log(`   POST returned ${fired.status} in ${fired.ms}ms (small chunk or no work)`);
    } else {
      log(`   POST sent (chunk running on prod) — polling Mongo every ${POLL_INTERVAL_MS/1000}s for cursor movement...`);
    }

    // Poll Mongo until we detect chunk completion (or stuck timeout)
    const pollDeadline = Date.now() + STUCK_THRESHOLD_MS;
    let lastSeenMetricsAt = beforeMetrics;
    let advanced = false, completed = false, stuck = false;

    while (Date.now() < pollDeadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const now = await getProgress(shopId);
      if (!now) { log(`   ?? progress doc disappeared`); stuck = true; break; }

      const nowCursor    = isoOrNull(now.currentChunkEnd);
      const nowMetricsAt = now.lastChunkMetrics?.at ? new Date(now.lastChunkMetrics.at).getTime() : 0;
      const nowJobs      = now.totalJobsIndexed || 0;
      const nowComplete  = !!now.complete;

      // Heartbeat-ish line every poll
      const elapsedSec = Math.round((Date.now() - (beforeRunAt > 0 ? beforeRunAt : Date.now())) / 1000);
      process.stdout.write(`${ts()}    poll: cursor=${nowCursor?.slice(0,10)} jobs=${nowJobs} metrics@=${nowMetricsAt > beforeMetrics ? "NEW" : "old"} complete=${nowComplete}\n`);

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
    log(`   chunk ${chunk} result: advanced=${advanced} completed=${completed} stuck=${stuck}  cursor: ${beforeCursor?.slice(0,10)} → ${isoOrNull(after?.currentChunkEnd)?.slice(0,10)}  jobs: ${beforeJobs} → ${after?.totalJobsIndexed||0}  err=${after?.lastError||"null"}`);

    if (completed) { log(`   ✓ Shop ${shopId} COMPLETE after ${chunk} chunk(s)`); return true; }
    if (stuck) {
      log(`   ✗ Shop ${shopId} STUCK (no movement in ${STUCK_THRESHOLD_MS/60000} min) — moving on`);
      return false;
    }
    // advanced — loop for next chunk
  }
  log(`   ✗ Shop ${shopId} did not complete after ${MAX_CHUNKS} chunks — moving on`);
  return false;
}

async function main() {
  log(`Tekmetric catch-up starting`);
  log(`PROD_BASE_URL=${PROD_BASE_URL}  DRY_RUN=${DRY_RUN}  MAX_CHUNKS_PER_SHOP=${MAX_CHUNKS}  POLL=${POLL_INTERVAL_MS/1000}s  STUCK_AFTER=${STUCK_THRESHOLD_MS/60000}min`);
  if (ONLY_SHOPS.length) log(`ONLY_SHOPS filter: ${ONLY_SHOPS.join(",")}`);
  if (SKIP_SHOPS.length) log(`SKIP_SHOPS filter: ${SKIP_SHOPS.join(",")}`);

  const shops = await listIncomplete();
  log(`${shops.length} incomplete shop(s) to process:`);
  for (const s of shops) log(`    shop=${s.shopId}  cursor=${isoOrNull(s.currentChunkEnd)?.slice(0,10)}  jobs=${s.totalJobsIndexed||0}  lastErr=${s.lastError ? "Y":"N"}`);

  let done=0, failed=0;
  for (let i=0; i<shops.length; i++) {
    log(`\n>>> ${i+1}/${shops.length}: shop ${shops[i].shopId}`);
    const ok = await processShop(shops[i].shopId);
    if (ok) done++; else failed++;
    if (i < shops.length-1) { log(`   sleeping ${INTER_SHOP_DELAY/1000}s before next shop...`); await new Promise(r => setTimeout(r, INTER_SHOP_DELAY)); }
  }

  log(`\n========== DONE ==========`);
  log(`completed=${done}  stuck/incomplete=${failed}  total=${shops.length}`);
  await mongo.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async e => { console.error("FATAL:", e); try { await mongo.close(); } catch {}; process.exit(2); });
