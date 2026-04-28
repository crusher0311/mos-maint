#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MongoClient } = require(path.resolve("./node_modules/mongodb"));

const PROD_BASE_URL    = process.env.PROD_BASE_URL    || "https://mos.tools";
const CRON_SECRET      = process.env.CRON_SECRET      || "";
const DRY_RUN          = process.env.DRY_RUN          === "true";
const MAX_CALLS        = Number(process.env.MAX_CALLS || 50);
const INTER_CALL_DELAY = Number(process.env.INTER_CALL_DELAY_MS || 5000);
const INTER_SHOP_DELAY = Number(process.env.INTER_SHOP_DELAY_MS || 5000);
const REQUEST_TIMEOUT  = Number(process.env.REQUEST_TIMEOUT_MS || 360000);
const ONLY_SHOPS       = (process.env.ONLY_SHOPS || "").split(",").map(s=>s.trim()).filter(Boolean).map(Number).filter(n=>!isNaN(n));
const SKIP_SHOPS       = (process.env.SKIP_SHOPS || "").split(",").map(s=>s.trim()).filter(Boolean).map(Number).filter(n=>!isNaN(n));

if (!CRON_SECRET) {
  console.error("ERROR: CRON_SECRET env var is required (it is the Bearer token your prod cron endpoints check)");
  process.exit(1);
}
if (!process.env.MONGODB_USERNAME || !process.env.MONGODB_PASSWORD) {
  console.error("ERROR: MONGODB_USERNAME and MONGODB_PASSWORD env vars are required");
  process.exit(1);
}

const ts = () => `[${new Date().toISOString().replace("T"," ").replace("Z","")}]`;
const log = (...a) => console.log(ts(), ...a);

const mongoUri = `mongodb+srv://${process.env.MONGODB_USERNAME}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
const mongo = new MongoClient(mongoUri);
await mongo.connect();
const db = mongo.db("mos-maintenance-mvp");

async function listIncomplete() {
  const docs = await db.collection("tekmetric_backfill_progress")
    .find({ complete: { $ne: true } })
    .project({ shopId:1, currentChunkEnd:1, totalJobsIndexed:1, lastError:1, lastRunAt:1, _id:0 })
    .toArray();
  let filtered = docs;
  if (ONLY_SHOPS.length) filtered = filtered.filter(d => ONLY_SHOPS.includes(d.shopId));
  if (SKIP_SHOPS.length) filtered = filtered.filter(d => !SKIP_SHOPS.includes(d.shopId));
  filtered.sort((a,b) => (a.shopId||0) - (b.shopId||0));
  return filtered;
}

async function getProgress(shopId) {
  return db.collection("tekmetric_backfill_progress").findOne({ shopId });
}

async function callCron(shopId) {
  const url = `${PROD_BASE_URL}/api/cron/tekmetric-backfill`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${CRON_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ shopId }),
      signal: ctrl.signal,
    });
    const body = await r.text();
    let json = null;
    try { json = JSON.parse(body); } catch {}
    return { status: r.status, ok: r.ok, json, body, ms: Date.now()-t0 };
  } finally {
    clearTimeout(t);
  }
}

async function processShop(shopId) {
  log(`=== SHOP ${shopId} START ===`);
  let beforeProgress = await getProgress(shopId);
  log(`   before: cursor=${beforeProgress?.currentChunkEnd?.toISOString?.()}  jobsIndexed=${beforeProgress?.totalJobsIndexed||0}`);

  for (let call = 1; call <= MAX_CALLS; call++) {
    if (DRY_RUN) { log(`   [DRY_RUN] would POST shopId=${shopId} (call ${call})`); break; }

    log(`   call ${call}/${MAX_CALLS}: POSTing to /api/cron/tekmetric-backfill { shopId: ${shopId} } ...`);
    let result;
    try {
      result = await callCron(shopId);
    } catch (e) {
      log(`   !! request error: ${e.message} — retrying in ${INTER_CALL_DELAY/1000}s`);
      await new Promise(r => setTimeout(r, INTER_CALL_DELAY));
      continue;
    }

    if (result.status === 401) { log(`   !! 401 Unauthorized — CRON_SECRET wrong, aborting all`); return false; }
    if (result.status >= 500) { log(`   !! HTTP ${result.status}: ${result.body.slice(0,300)} — retry in ${INTER_CALL_DELAY/1000}s`); await new Promise(r => setTimeout(r, INTER_CALL_DELAY)); continue; }

    const r0 = result.json?.processed?.[0];
    if (!r0) {
      log(`   ?? unexpected response (${result.ms}ms): ${result.body.slice(0,300)}`);
      // empty processed = no shops to backfill = shop already complete
      const after = await getProgress(shopId);
      if (after?.complete) { log(`   ✓ Shop ${shopId} is COMPLETE`); return true; }
      log(`   shop not complete but no work returned — retrying in ${INTER_CALL_DELAY/1000}s`);
      await new Promise(r => setTimeout(r, INTER_CALL_DELAY));
      continue;
    }

    log(`   call ${call} done in ${result.ms}ms — chunks=${r0.chunksProcessed} jobs+=${r0.totalJobsIndexed} skipped=${r0.totalSkipped} normalized=${r0.totalNormalized} apiCalls=${result.json.tekmetricApiCalls}`);

    const after = await getProgress(shopId);
    log(`   after:  cursor=${after?.currentChunkEnd?.toISOString?.()}  jobsIndexed=${after?.totalJobsIndexed||0}  complete=${!!after?.complete}  lastError=${after?.lastError||"null"}`);

    if (after?.complete) { log(`   ✓ Shop ${shopId} is COMPLETE after ${call} call(s)`); return true; }

    // Detect cursor-stuck: 3 consecutive calls with no cursor advance & no jobs added
    const cursorMoved = (beforeProgress?.currentChunkEnd?.toISOString?.()) !== (after?.currentChunkEnd?.toISOString?.());
    const jobsAdded   = (after?.totalJobsIndexed || 0) > (beforeProgress?.totalJobsIndexed || 0);
    if (!cursorMoved && !jobsAdded) {
      log(`   ⚠ no cursor movement and no jobs added this call`);
    }
    beforeProgress = after;

    await new Promise(r => setTimeout(r, INTER_CALL_DELAY));
  }

  log(`   ✗ Shop ${shopId} did not complete after ${MAX_CALLS} calls — moving on`);
  return false;
}

async function main() {
  log(`Tekmetric catch-up starting`);
  log(`PROD_BASE_URL=${PROD_BASE_URL}  DRY_RUN=${DRY_RUN}  MAX_CALLS_PER_SHOP=${MAX_CALLS}`);
  if (ONLY_SHOPS.length) log(`ONLY_SHOPS filter active → ${ONLY_SHOPS.join(",")}`);
  if (SKIP_SHOPS.length) log(`SKIP_SHOPS filter active → ${SKIP_SHOPS.join(",")}`);

  const shops = await listIncomplete();
  log(`${shops.length} incomplete shop(s) to process:`);
  for (const s of shops) {
    log(`    shop=${s.shopId}  cursor=${s.currentChunkEnd?.toISOString?.().slice(0,10)}  jobs=${s.totalJobsIndexed||0}  lastErr=${s.lastError ? "Y":"N"}`);
  }

  let done = 0, failed = 0;
  for (let i = 0; i < shops.length; i++) {
    log(`\n>>> ${i+1}/${shops.length}: shop ${shops[i].shopId}`);
    const ok = await processShop(shops[i].shopId);
    if (ok) done++; else failed++;
    if (i < shops.length - 1) {
      log(`   sleeping ${INTER_SHOP_DELAY/1000}s before next shop...`);
      await new Promise(r => setTimeout(r, INTER_SHOP_DELAY));
    }
  }

  log(`\n========== DONE ==========`);
  log(`completed=${done}  failed/incomplete=${failed}  total=${shops.length}`);
  await mongo.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async e => {
  console.error("FATAL:", e);
  try { await mongo.close(); } catch {}
  process.exit(2);
});
