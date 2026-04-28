#!/usr/bin/env node
/**
 * Tekmetric backfill catch-up runner — sequential, one shop at a time.
 *
 * Reads incomplete Tekmetric backfill shops from MongoDB, then walks them
 * one at a time calling the prod platform-admin run-now SSE endpoint. Each
 * call processes up to 25 chunks (~270s) for a single shop. If the shop
 * still isn't complete after a call, the script keeps re-calling for that
 * SAME shop until it's marked complete OR the cursor stops moving OR a
 * per-shop retry budget is exhausted. Only then does it move to the next
 * shop. Restartable: it re-queries Mongo on every loop so anything finished
 * by a prior run (or by the daily cron) is auto-skipped.
 *
 * Required env (set in shell before running):
 *   PROD_BASE_URL    e.g. https://app.mos.tools  (no trailing slash)
 *   SESSION_COOKIE   the value of the `session_token` cookie copied from
 *                    your platform-admin browser tab in prod
 *   MONGODB_USERNAME / MONGODB_PASSWORD (already in this Replit env)
 *
 * Optional env:
 *   ONLY_SHOPS       comma-separated shopIds to restrict to (e.g. "32,57")
 *   SKIP_SHOPS       comma-separated shopIds to skip
 *   MAX_RETRIES      max run-now calls per shop before giving up (default 5)
 *   INTER_SHOP_DELAY ms to wait between shops (default 5000)
 *   DRY_RUN          if "1", just prints the plan and exits
 *
 * Usage:
 *   PROD_BASE_URL=https://app.mos.tools \
 *   SESSION_COOKIE='paste-cookie-value-here' \
 *   node scripts/tekmetric-catchup.mjs
 */

import { MongoClient } from "mongodb";

const PROD_BASE_URL = (process.env.PROD_BASE_URL || "").replace(/\/+$/, "");
const SESSION_COOKIE = process.env.SESSION_COOKIE || "";
const ONLY_SHOPS = (process.env.ONLY_SHOPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));
const SKIP_SHOPS = new Set(
  (process.env.SKIP_SHOPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n))
);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || "5");
const INTER_SHOP_DELAY = Number(process.env.INTER_SHOP_DELAY || "5000");
const DRY_RUN = process.env.DRY_RUN === "1";

if (!DRY_RUN) {
  if (!PROD_BASE_URL) die("PROD_BASE_URL is required (e.g. https://app.mos.tools)");
  if (!SESSION_COOKIE) die("SESSION_COOKIE is required (paste session_token cookie value from prod browser tab)");
}
if (!process.env.MONGODB_USERNAME || !process.env.MONGODB_PASSWORD) {
  die("MONGODB_USERNAME and MONGODB_PASSWORD must be set");
}

function die(msg) {
  console.error(`\n[catchup] FATAL: ${msg}\n`);
  process.exit(2);
}

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const enc = encodeURIComponent(process.env.MONGODB_PASSWORD);
const MONGO_URI = `mongodb+srv://${process.env.MONGODB_USERNAME}:${enc}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;

async function getIncompleteShops() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const db = client.db("mos-maintenance-mvp");
    const rows = await db
      .collection("tekmetric_backfill_progress")
      .find(
        { complete: { $ne: true } },
        {
          projection: {
            shopId: 1,
            currentChunkEnd: 1,
            previousChunkEnd: 1,
            totalJobsIndexed: 1,
            lastRunAt: 1,
            lastError: 1,
          },
        }
      )
      .toArray();
    // Sort: deepest cursor (oldest currentChunkEnd) last so quick wins land first.
    rows.sort((a, b) => {
      const ax = a.currentChunkEnd ? new Date(a.currentChunkEnd).getTime() : 0;
      const bx = b.currentChunkEnd ? new Date(b.currentChunkEnd).getTime() : 0;
      return bx - ax;
    });
    return rows;
  } finally {
    await client.close();
  }
}

async function getShopProgressSnapshot(shopId) {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const db = client.db("mos-maintenance-mvp");
    const row = await db
      .collection("tekmetric_backfill_progress")
      .findOne(
        { shopId },
        {
          projection: {
            shopId: 1,
            complete: 1,
            currentChunkEnd: 1,
            totalJobsIndexed: 1,
            lastError: 1,
            consecutiveChunkErrors: 1,
          },
        }
      );
    return row;
  } finally {
    await client.close();
  }
}

/**
 * Calls /api/platform-admin/shops/:shopId/tekmetric-run-now and consumes
 * the SSE stream until the server closes it. Returns a summary object.
 */
async function runNowForShop(shopId) {
  const url = `${PROD_BASE_URL}/api/platform-admin/shops/${shopId}/tekmetric-run-now`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: `session_token=${SESSION_COOKIE}`,
      Accept: "text/event-stream",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from run-now (${body.slice(0, 200)})`);
  }
  if (!res.body) throw new Error("No response body from run-now");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastEventName = "message";
  const summary = {
    chunks: 0,
    completed: false,
    timedOut: false,
    aborted: false,
    totalJobs: 0,
    totalNormalized: 0,
    totalSkipped: 0,
    apiCalls: 0,
    error: null,
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleSseBlock(block);
    }
  }

  function handleSseBlock(block) {
    let eventName = "message";
    let dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // heartbeat
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    lastEventName = eventName;

    if (eventName === "start") {
      console.log(`  [${ts()}] start: shop=${payload.shopId} tek=${payload.tekmetricShopId ?? "?"} from=${payload.currentChunkEnd ?? "?"}`);
    } else if (eventName === "chunk") {
      const totals = payload.totals || {};
      summary.chunks = totals.chunksProcessed ?? payload.index ?? summary.chunks + 1;
      summary.totalJobs = totals.totalJobsIndexed ?? summary.totalJobs;
      summary.totalNormalized = totals.totalNormalized ?? summary.totalNormalized;
      summary.totalSkipped = totals.totalSkipped ?? summary.totalSkipped;
      summary.apiCalls = payload.tekmetricApiCalls ?? summary.apiCalls;
      const dur = payload.chunkDurationMs ? `${(payload.chunkDurationMs / 1000).toFixed(1)}s` : "?";
      console.log(
        `  [${ts()}] chunk #${summary.chunks} dur=${dur} jobs+=${payload.jobsIndexed ?? "?"} skipped=${payload.skipped ?? 0} cursor→${payload.cursor ?? "?"}${payload.complete ? "  [BACKFILL COMPLETE]" : ""}`
      );
      if (payload.lastError) {
        console.log(`  [${ts()}]   chunk reported lastError on progress doc: ${String(payload.lastError).slice(0, 200)}`);
      }
    } else if (eventName === "chunk_error") {
      summary.error = `chunk #${payload.index ?? "?"} error: ${payload.message ?? "(unknown)"}`;
      console.log(`  [${ts()}] CHUNK ERROR: ${summary.error}`);
    } else if (eventName === "complete") {
      summary.completed = !!payload.completed;
      summary.timedOut = !!payload.timedOut;
      summary.aborted = !!payload.aborted;
      summary.chunks = payload.chunksProcessed ?? summary.chunks;
      summary.totalJobs = payload.totalJobsIndexed ?? summary.totalJobs;
      summary.totalNormalized = payload.totalNormalized ?? summary.totalNormalized;
      summary.totalSkipped = payload.totalSkipped ?? summary.totalSkipped;
      summary.apiCalls = payload.tekmetricApiCalls ?? summary.apiCalls;
      console.log(
        `  [${ts()}] complete: completed=${summary.completed} timedOut=${summary.timedOut} chunks=${summary.chunks} jobsThisCall=${summary.totalJobs} apiCalls=${summary.apiCalls}`
      );
    } else if (eventName === "error") {
      summary.error = payload.message || JSON.stringify(payload);
      console.log(`  [${ts()}] ERROR event: ${summary.error}`);
    }
  }

  if (lastEventName !== "complete" && lastEventName !== "error" && !summary.error) {
    summary.error = "stream ended without 'complete' or 'error' event";
  }
  return summary;
}

async function processShop(shopId) {
  console.log(`\n=== [${ts()}] SHOP ${shopId} ===`);
  let priorCursor = null;
  let priorJobs = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const before = await getShopProgressSnapshot(shopId);
    if (!before) {
      console.log(`  [${ts()}] no progress doc found — skipping`);
      return { shopId, status: "no-progress-doc" };
    }
    if (before.complete === true) {
      console.log(`  [${ts()}] already complete — skipping`);
      return { shopId, status: "already-complete" };
    }
    const cur = before.currentChunkEnd ? new Date(before.currentChunkEnd).toISOString() : "(null)";
    console.log(`  [${ts()}] attempt ${attempt}/${MAX_RETRIES} — cursor=${cur} jobsIndexed=${before.totalJobsIndexed ?? 0}`);

    let summary;
    try {
      summary = await runNowForShop(shopId);
    } catch (e) {
      console.log(`  [${ts()}] call failed: ${e.message}`);
      return { shopId, status: "call-failed", error: e.message, attempts: attempt };
    }

    const after = await getShopProgressSnapshot(shopId);
    const newCur = after?.currentChunkEnd ? new Date(after.currentChunkEnd).toISOString() : "(null)";
    const jobsNow = after?.totalJobsIndexed ?? 0;
    console.log(`  [${ts()}] post-call: complete=${after?.complete} cursor=${newCur} jobsIndexed=${jobsNow}`);

    if (after?.complete === true) {
      return { shopId, status: "completed", attempts: attempt, totalJobs: jobsNow };
    }
    if (summary.error) {
      return { shopId, status: "errored", attempts: attempt, error: summary.error };
    }
    // If neither cursor nor jobsIndexed moved AND we already had at least
    // one prior attempt, we're stuck — bail to avoid spinning forever.
    if (
      attempt > 1 &&
      newCur === priorCursor &&
      jobsNow === priorJobs &&
      summary.chunks === 0
    ) {
      return { shopId, status: "stalled-no-progress", attempts: attempt };
    }
    priorCursor = newCur;
    priorJobs = jobsNow;
    // Brief breath before next attempt so Tekmetric quota recovers.
    await sleep(2000);
  }
  return { shopId, status: "max-retries-hit", attempts: MAX_RETRIES };
}

async function main() {
  console.log(`[${ts()}] Tekmetric catch-up starting`);
  console.log(`[${ts()}] PROD_BASE_URL=${PROD_BASE_URL || "(unset)"}  DRY_RUN=${DRY_RUN}  MAX_RETRIES=${MAX_RETRIES}`);

  let shops = await getIncompleteShops();
  if (ONLY_SHOPS.length) {
    shops = shops.filter((s) => ONLY_SHOPS.includes(s.shopId));
    console.log(`[${ts()}] ONLY_SHOPS filter active → ${shops.length} shop(s)`);
  }
  shops = shops.filter((s) => !SKIP_SHOPS.has(s.shopId));

  console.log(`[${ts()}] ${shops.length} incomplete shop(s) to process:`);
  for (const s of shops) {
    const cur = s.currentChunkEnd ? new Date(s.currentChunkEnd).toISOString().slice(0, 10) : "(null)";
    console.log(`    shop=${s.shopId}  cursor=${cur}  jobs=${s.totalJobsIndexed ?? 0}  lastErr=${s.lastError ? "Y" : "N"}`);
  }
  if (DRY_RUN) {
    console.log(`\n[${ts()}] DRY_RUN=1 — exiting before any HTTP calls.`);
    process.exit(0);
  }
  if (shops.length === 0) {
    console.log(`[${ts()}] nothing to do — all shops complete.`);
    process.exit(0);
  }

  const results = [];
  for (let i = 0; i < shops.length; i++) {
    const s = shops[i];
    console.log(`\n[${ts()}] >>> ${i + 1}/${shops.length}: shop ${s.shopId}`);
    const r = await processShop(s.shopId);
    results.push(r);
    if (i < shops.length - 1) {
      console.log(`[${ts()}] sleeping ${INTER_SHOP_DELAY}ms before next shop...`);
      await sleep(INTER_SHOP_DELAY);
    }
  }

  console.log(`\n=== [${ts()}] FINAL SUMMARY (${results.length} shops) ===`);
  const counts = {};
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    console.log(
      `  shop=${String(r.shopId).padStart(4)}  status=${r.status.padEnd(20)}  attempts=${r.attempts ?? "-"}  ${r.error ? "err=" + r.error : ""}`
    );
  }
  console.log(`\n  totals:`, counts);
  console.log(`[${ts()}] done.`);
}

main().catch((e) => {
  console.error(`[${ts()}] FATAL:`, e);
  process.exit(1);
});
