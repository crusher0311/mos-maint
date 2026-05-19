#!/usr/bin/env node
// Cron heartbeat smoke check — task #458.
//
// Confirms the in-process scheduler is actually writing tick heartbeats to
// the `cron_status` doc that the cron-health-alerter, the platform-admin
// cron-status endpoint, and the Tekmetric webhook-subscription-status view
// all now read. The 2026-05 outage (#443 / #449) went unnoticed for 9+ days
// because the alerter was pointed at `cron_runs`, which is missing fleet-
// wide in prod — nobody noticed the silence until shops 82/122 wedged.
//
// Reads `cron_status.global.lastBoot` + `lastRuns.*` + `lastSuccessByJob.*`
// from the "mos" Mongo db (same db the scheduler hard-codes) and prints:
//   - last boot status / age
//   - most recent tick across all jobs (proves the scheduler is alive)
//   - per-job last success age vs. expected schedule interval
//   - any job whose last success is older than 2× its interval (would page)
//
// Usage:
//   node scripts/cron-heartbeat-smoke.mjs
//   MONGODB_USERNAME=... MONGODB_PASSWORD=... node scripts/cron-heartbeat-smoke.mjs
//
// Exits 0 if at least one job has run in the last hour; exits 1 if the
// scheduler appears wedged (no boot, or every job stale). Suitable for
// dropping into a one-off cron / Better Stack heartbeat / human run-book.

import { MongoClient } from "mongodb";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { CRON_JOBS } = require(path.join(__dirname, "..", "lib", "cron", "jobs.cjs"));

const user = encodeURIComponent(process.env.MONGODB_USERNAME || "");
const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || "");
if (!user || !pass) {
  console.error("MONGODB_USERNAME / MONGODB_PASSWORD must be set");
  process.exit(2);
}
const uri = `mongodb+srv://${user}:${pass}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;

function estimateIntervalMs(schedule) {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute] = parts;
  if (minute.startsWith("*/")) {
    const step = parseInt(minute.slice(2), 10);
    if (Number.isFinite(step) && step > 0) return step * 60 * 1000;
  }
  if (minute.includes(",")) {
    const slots = minute.split(",").length;
    if (slots > 0) return Math.round((60 * 60 * 1000) / slots);
  }
  if (minute === "*") return 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db("mos");
  const doc = await db.collection("cron_status").findOne({ _id: "global" });
  const now = Date.now();

  if (!doc) {
    console.error("FAIL: cron_status.global not found — scheduler has never booted in this env");
    process.exit(1);
  }

  const lastBoot = doc.lastBoot || null;
  const bootAgeMin = lastBoot
    ? Math.round((now - new Date(lastBoot.bootedAt).getTime()) / 60000)
    : null;
  console.log(`Boot: status=${lastBoot?.status ?? "none"}  bootedAt=${lastBoot?.bootedAt ?? "—"}  age=${bootAgeMin ?? "—"} min  jobs=${lastBoot?.jobsRegistered ?? "—"}`);

  const lastRuns = doc.lastRuns || {};
  const lastSuccess = doc.lastSuccessByJob || {};

  const tickTimes = Object.values(lastRuns)
    .map((r) => (r?.dt ? new Date(r.dt).getTime() : 0))
    .filter((t) => t > 0);
  const mostRecentTick = tickTimes.length ? Math.max(...tickTimes) : 0;
  const tickAgeMin = mostRecentTick ? Math.round((now - mostRecentTick) / 60000) : null;
  console.log(`Most recent tick across all jobs: ${mostRecentTick ? new Date(mostRecentTick).toISOString() : "never"}  (${tickAgeMin ?? "—"} min ago)`);

  const rows = CRON_JOBS.map((job) => {
    const intervalMs = estimateIntervalMs(job.schedule);
    const lsRaw = lastSuccess[job.name];
    const lsMs = lsRaw ? new Date(lsRaw).getTime() : 0;
    const ageMs = lsMs ? now - lsMs : null;
    const threshold = intervalMs ? intervalMs * 2 : null;
    const stale = threshold && (ageMs == null || ageMs > threshold);
    return { name: job.name, schedule: job.schedule, ageMin: ageMs == null ? null : Math.round(ageMs / 60000), thresholdMin: threshold ? Math.round(threshold / 60000) : null, stale };
  });

  console.log("\nPer-job last success:");
  for (const r of rows) {
    const flag = r.stale ? "STALE" : "ok   ";
    console.log(`  ${flag}  ${r.name.padEnd(34)} ${r.schedule.padEnd(20)} last=${(r.ageMin ?? "never").toString().padStart(6)} min  threshold=${r.thresholdMin ?? "—"} min`);
  }

  const staleJobs = rows.filter((r) => r.stale);
  const recentTick = tickAgeMin !== null && tickAgeMin <= 60;

  console.log("");
  if (!recentTick) {
    console.error(`FAIL: no cron tick in the last 60 min (most recent: ${tickAgeMin ?? "never"} min ago) — scheduler appears wedged`);
    process.exit(1);
  }
  if (staleJobs.length === rows.length) {
    console.error(`FAIL: every registered job (${rows.length}) is stale — scheduler may be booted but every handler is failing`);
    process.exit(1);
  }
  console.log(`OK: scheduler ticked ${tickAgeMin} min ago; ${rows.length - staleJobs.length}/${rows.length} jobs healthy, ${staleJobs.length} stale`);
  process.exit(0);
} finally {
  await client.close();
}
