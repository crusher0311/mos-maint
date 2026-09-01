const cron = require("node-cron");
const os = require("os");
const http = require("http");
const https = require("https");
const {
  evaluateProtractorOutboundPolicy,
  logProtractorPolicyDenial,
} = require("../integrations/protractor/outbound-policy.cjs");

// Internal HTTP client for invoking cron routes.
//
// We deliberately do NOT use global `fetch` (undici) here. undici applies a
// default `headersTimeout` of 300s (5 min): if a route does not emit response
// headers within 5 minutes, undici aborts the request with a generic
// "fetch failed" — REGARDLESS of the per-job `timeoutMs` we set via the
// AbortController below. Long-running crons (e.g. protractor-sync, configured
// for a 25-min budget) emit headers only after all work completes, so they were
// silently killed at ~300s and `lastSuccessByJob` never advanced — the route's
// own AbortController never got the chance to fire. These are internal
// localhost calls, so we use Node's `http`/`https` modules, which have no such
// hidden header timeout: the AbortController (per-job `timeoutMs`) becomes the
// single, authoritative deadline. Returns a minimal fetch-like result.
function requestWithAbort(urlStr, { method = "GET", headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = urlObj.protocol === "https:" ? https : http;
    const req = mod.request(urlObj, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode || 0;
        resolve({ ok: status >= 200 && status < 300, status, text: () => body });
      });
    });
    req.on("error", (err) => reject(err));
    if (signal) {
      if (signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        req.destroy(e);
      } else {
        signal.addEventListener(
          "abort",
          () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            req.destroy(e);
          },
          { once: true }
        );
      }
    }
    req.end();
  });
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;
const LOCK_COLLECTION = "cron_locks";
const STATUS_COLLECTION = "cron_status";
const RUNS_COLLECTION = "cron_runs";
const RUNS_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATUS_DOC_ID = "global";
const BOOT_HISTORY_LIMIT = 10;
let runsIndexEnsured = false;

let started = false;
const tasks = [];

async function getDb() {
  const { MongoClient } = require("mongodb");
  if (!global.__cronMongoClient) {
    const user = encodeURIComponent(process.env.MONGODB_USERNAME || "");
    const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || "");
    const uri = `mongodb+srv://${user}:${pass}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;
    const client = new MongoClient(uri);
    await client.connect();
    global.__cronMongoClient = client;
  }
  return global.__cronMongoClient.db("mos");
}

// ---------------------------------------------------------------------------
// Distributed cron lock.
//
// Two interchangeable backends, selected per boot by the
// `CRON_LOCK_PG_CANONICAL` flag (task #557, Mongo → Postgres migration):
//   - unset / not "1"  → Mongo `cron_locks` collection in db `mos` (default,
//                        unchanged historical behavior).
//   - "1"              → Postgres `cron_locks` table.
// Both implement the same contract: atomic take-over only when the existing
// lease is expired (or already held by this instance, refreshing the TTL),
// and an instance-fenced release so a slow holder cannot delete a successor's
// lock. The flag defaults off so flipping it is an operator action on the
// production deploy; nothing changes in dev/prod until then.
// ---------------------------------------------------------------------------

function isCronLockPgCanonical() {
  return process.env.CRON_LOCK_PG_CANONICAL === "1";
}

// Singleton postgres-js client for the cron lock. Kept tiny (max:1) — the
// lock makes at most a couple of round-trips per job fire (minutes apart), so
// a single pooled connection is plenty and avoids competing with the app's
// own pool. `require("postgres")` works here because scheduler.cjs is plain
// CommonJS and `postgres` ships a CJS entry.
function getCronPgSql() {
  if (!global.__cronPgSql) {
    const postgres = require("postgres");
    const url = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "Missing database URL for cron PG lock. Set DATAONE_DATABASE_URL or DATABASE_URL."
      );
    }
    global.__cronPgSql = postgres(url, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 30,
    });
  }
  return global.__cronPgSql;
}

// Postgres lock acquire. `sqlOverride` is a test seam (inject a fake
// postgres-js client exposing `.unsafe(query, params)`).
async function tryAcquireLockPg(jobName, ttlMs, instanceId, sqlOverride) {
  const sql = sqlOverride || getCronPgSql();
  // INSERT, or take over an EXPIRED lease, or refresh our own lease. The
  // ON CONFLICT WHERE clause is what makes this atomic: a live lease held by
  // a *different* instance fails the predicate, so no row is updated and
  // RETURNING yields nothing → we did not acquire.
  const rows = await sql.unsafe(
    `INSERT INTO cron_locks (job_name, locked_at, expires_at, instance_id)
     VALUES ($1, now(), now() + ($2::bigint * interval '1 millisecond'), $3)
     ON CONFLICT (job_name) DO UPDATE
       SET locked_at = excluded.locked_at,
           expires_at = excluded.expires_at,
           instance_id = excluded.instance_id
       WHERE cron_locks.expires_at <= now()
          OR cron_locks.instance_id = excluded.instance_id
     RETURNING instance_id`,
    [jobName, ttlMs, instanceId]
  );
  return Array.isArray(rows) && rows.length > 0 && rows[0].instance_id === instanceId;
}

// Postgres lock release — fenced on instance_id so a stale holder never
// deletes a successor's lock.
async function releaseLockPg(jobName, instanceId, sqlOverride) {
  const sql = sqlOverride || getCronPgSql();
  await sql.unsafe(
    `DELETE FROM cron_locks WHERE job_name = $1 AND instance_id = $2`,
    [jobName, instanceId]
  );
}

async function tryAcquireLockMongo(jobName, ttlMs, instanceId) {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    await db.collection(LOCK_COLLECTION).updateOne(
      {
        _id: jobName,
        $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }],
      },
      {
        $set: { lockedAt: now, expiresAt, instanceId },
        $setOnInsert: { _id: jobName },
      },
      { upsert: true }
    );
    const doc = await db.collection(LOCK_COLLECTION).findOne({ _id: jobName });
    return doc && doc.instanceId === instanceId && doc.expiresAt > now;
  } catch (err) {
    if (err && err.code === 11000) return false;
    console.error(`[Cron] Lock error for ${jobName}:`, err.message);
    return false;
  }
}

async function releaseLockMongo(jobName, instanceId) {
  try {
    const db = await getDb();
    await db.collection(LOCK_COLLECTION).deleteOne({ _id: jobName, instanceId });
  } catch (err) {
    console.warn(`[Cron] Lock release error for ${jobName}:`, err.message);
  }
}

async function tryAcquireLock(jobName, ttlMs, instanceId) {
  if (isCronLockPgCanonical()) {
    try {
      return await tryAcquireLockPg(jobName, ttlMs, instanceId);
    } catch (err) {
      // Fail closed: if PG is unreachable we skip the job this tick rather
      // than risk two instances running it. The next tick retries.
      console.error(`[Cron] PG lock error for ${jobName}:`, err && err.message);
      return false;
    }
  }
  return tryAcquireLockMongo(jobName, ttlMs, instanceId);
}

async function releaseLock(jobName, instanceId) {
  if (isCronLockPgCanonical()) {
    try {
      await releaseLockPg(jobName, instanceId);
    } catch (err) {
      console.warn(`[Cron] PG lock release error for ${jobName}:`, err && err.message);
    }
    return;
  }
  return releaseLockMongo(jobName, instanceId);
}

async function seedLastSuccessByJob() {
  // Task #455: on first boot after the task #449 deploy, the
  // `lastSuccessByJob` map is empty for every job until each one runs
  // successfully once. For daily jobs that creates up to 24h of false
  // "no last success" state where the cron-health alerter has no signal
  // and falls back to `sinceBootMs > threshold`. Seed the map from any
  // existing `lastRuns.{jobName}` entries that succeeded so the alerter
  // has signal immediately after a deploy. Only fills in jobs that don't
  // already have a `lastSuccessByJob` entry — never overwrites a fresher
  // success that was already recorded.
  try {
    const db = await getDb();
    const doc = await db
      .collection(STATUS_COLLECTION)
      .findOne({ _id: STATUS_DOC_ID }, { projection: { lastRuns: 1, lastSuccessByJob: 1 } });
    if (!doc || !doc.lastRuns) return;
    const existing = doc.lastSuccessByJob || {};
    const toSet = {};
    let seeded = 0;
    for (const [jobName, run] of Object.entries(doc.lastRuns)) {
      if (!run || run.ok !== true) continue;
      if (existing[jobName]) continue;
      const finishedAt = run.dt instanceof Date ? run.dt : new Date(run.dt || 0);
      if (!Number.isFinite(finishedAt.getTime()) || finishedAt.getTime() === 0) continue;
      const startedAt = new Date(finishedAt.getTime() - (run.ms || 0));
      toSet[`lastSuccessByJob.${jobName}`] = startedAt;
      seeded += 1;
    }
    if (seeded === 0) {
      console.log("[Cron] lastSuccessByJob seed: nothing to backfill");
      return;
    }
    toSet.updatedAt = new Date();
    await db
      .collection(STATUS_COLLECTION)
      .updateOne({ _id: STATUS_DOC_ID }, { $set: toSet }, { upsert: true });
    console.log(`[Cron] lastSuccessByJob seed: backfilled ${seeded} job(s) from lastRuns`);
  } catch (err) {
    console.warn("[Cron] lastSuccessByJob seed failed:", err.message);
  }
}

async function recordBoot(entry) {
  try {
    const db = await getDb();
    await db.collection(STATUS_COLLECTION).updateOne(
      { _id: STATUS_DOC_ID },
      {
        $set: { lastBoot: entry, updatedAt: new Date() },
        $push: {
          bootHistory: {
            $each: [entry],
            $position: 0,
            $slice: BOOT_HISTORY_LIMIT,
          },
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn("[Cron] Failed to record boot status:", err.message);
  }
}

async function ensureRunsIndex(db) {
  if (runsIndexEnsured) return;
  try {
    await db.collection(RUNS_COLLECTION).createIndex(
      { startedAt: 1 },
      { expireAfterSeconds: RUNS_TTL_SECONDS, name: "startedAt_ttl" }
    );
    await db
      .collection(RUNS_COLLECTION)
      .createIndex({ jobName: 1, startedAt: -1 }, { name: "jobName_startedAt" });
    runsIndexEnsured = true;
  } catch (err) {
    console.warn("[Cron] Failed to ensure cron_runs indexes:", err.message);
  }
}

async function recordRun(jobName, result) {
  try {
    const db = await getDb();
    // `lastRuns.${jobName}` is the latest run regardless of outcome — used
    // by the platform observability UI. `lastSuccessByJob.${jobName}` is
    // only stamped on successful runs and is what the cron-health alerter
    // reads to decide "is this job stale?" (task #449 / diagnosis #443).
    // Previously the alerter aggregated the `cron_runs` time-series
    // collection; in prod that collection is missing entirely (the insert
    // path fails silently in some deploy configurations), so the alerter
    // never paged. Reading from a sibling field on the same status doc the
    // alerter already loads removes that dependency.
    const finishedAtForStamp =
      result.dt instanceof Date ? result.dt : new Date(result.dt || Date.now());
    const startedAtForStamp = new Date(finishedAtForStamp.getTime() - (result.ms || 0));
    const statusSet = {
      [`lastRuns.${jobName}`]: result,
      updatedAt: new Date(),
    };
    if (result.ok) {
      statusSet[`lastSuccessByJob.${jobName}`] = startedAtForStamp;
    }
    await db.collection(STATUS_COLLECTION).updateOne(
      { _id: STATUS_DOC_ID },
      { $set: statusSet },
      { upsert: true }
    );

    // Append a per-run row to the cron_runs time-series collection (TTL-7d).
    // The status doc above only tracks the *latest* run per job; cron_runs is
    // what powers the staleness/heartbeat checks in the platform observability
    // page and the cron-health alerter, including no-op runs that emit a
    // green "still alive" record even when the underlying job had nothing
    // to do.
    try {
      await ensureRunsIndex(db);
      const finishedAt =
        result.dt instanceof Date ? result.dt : new Date(result.dt || Date.now());
      const startedAt = new Date(finishedAt.getTime() - (result.ms || 0));
      await db.collection(RUNS_COLLECTION).insertOne({
        jobName,
        startedAt,
        finishedAt,
        durationMs: result.ms || 0,
        ok: !!result.ok,
        status: result.status || 0,
        instanceId: result.instanceId || null,
        schedule: result.schedule || null,
        errorSummary: result.error || null,
      });
    } catch (innerErr) {
      console.warn(
        `[Cron] Failed to insert cron_runs row for ${jobName}:`,
        innerErr.message
      );
    }
  } catch (err) {
    // best-effort, do not interrupt job flow
    console.warn(`[Cron] Failed to record run for ${jobName}:`, err.message);
  }
}

async function runJob(job, baseUrl, secret, instanceId) {
  const ttl = job.lockTtlMs || DEFAULT_LOCK_TTL_MS;
  const acquired = await tryAcquireLock(job.name, ttl, instanceId);
  if (!acquired) {
    console.log(`[Cron] Skip ${job.name} (lock held by another instance)`);
    return;
  }

  const url = `${baseUrl}${job.path}`;
  const method = job.method || "GET";
  const timeout = job.timeoutMs || DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let outcome = { ok: false, status: 0, ms: 0, error: null };
  try {
    console.log(`[Cron] ▶ ${job.name} ${method} ${job.path}`);
    const res = await requestWithAbort(url, {
      method,
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    const ms = Date.now() - startedAt;
    let text = "";
    try {
      text = res.text();
    } catch (e) {
      text = "";
    }
    if (res.ok) {
      console.log(`[Cron] ✓ ${job.name} ${res.status} in ${ms}ms`);
      outcome = { ok: true, status: res.status, ms, error: null };
    } else {
      console.warn(`[Cron] ✗ ${job.name} ${res.status} in ${ms}ms — ${text.substring(0, 200)}`);
      outcome = { ok: false, status: res.status, ms, error: text.substring(0, 500) };
    }
  } catch (err) {
    const ms = Date.now() - startedAt;
    if (err && err.name === "AbortError") {
      console.warn(`[Cron] ⏱ ${job.name} timed out after ${ms}ms`);
      outcome = { ok: false, status: 0, ms, error: "timeout" };
    } else {
      console.error(`[Cron] ✗ ${job.name} error after ${ms}ms:`, err.message);
      outcome = { ok: false, status: 0, ms, error: err.message || String(err) };
    }
  } finally {
    clearTimeout(timer);
    await releaseLock(job.name, instanceId);
    await recordRun(job.name, {
      dt: new Date(),
      instanceId,
      schedule: job.schedule,
      ...outcome,
    });
  }
}

function startScheduler(jobs) {
  if (started) {
    console.log("[Cron] Scheduler already started, skipping");
    return;
  }

  const host = (() => {
    try {
      return os.hostname();
    } catch {
      return "unknown";
    }
  })();
  const enabled = process.env.ENABLE_INPROCESS_CRON === "true";
  if (!enabled) {
    console.log("[Cron] ENABLE_INPROCESS_CRON not set — scheduler disabled");
    recordBoot({
      status: "disabled",
      reason: "ENABLE_INPROCESS_CRON not set",
      bootedAt: new Date(),
      host,
      pid: process.pid,
    });
    return;
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn("[Cron] CRON_SECRET not set — scheduler disabled (cron endpoints would reject)");
    recordBoot({
      status: "disabled",
      reason: "CRON_SECRET not set",
      bootedAt: new Date(),
      host,
      pid: process.pid,
    });
    return;
  }

  const port = process.env.PORT || "5000";
  const baseUrl = process.env.CRON_BASE_URL || `http://127.0.0.1:${port}`;
  const instanceId = `${process.env.RENDER_INSTANCE_ID || "local"}-${process.pid}-${Date.now()}`;

  console.log(`[Cron] Starting in-process scheduler (instance=${instanceId}, base=${baseUrl})`);

  // Surgical pause flag: when set to "true", any job whose name starts with
  // "tekmetric-" is skipped at registration time so it never fires. Used to
  // free up the Tekmetric API quota during one-off historical backfills run
  // by scripts/job-index-mileage-backfill-tekmetric.ts. Unset (or set to
  // anything other than "true") to resume normal operation — requires a
  // service restart for the env-var change to take effect.
  const pauseTekmetric = process.env.PAUSE_TEKMETRIC_CRON === "true";
  if (pauseTekmetric) {
    console.log("[Cron] PAUSE_TEKMETRIC_CRON=true — Tekmetric jobs will NOT be scheduled this boot");
  }
  // Same pattern as PAUSE_TEKMETRIC_CRON above, scoped to Protractor jobs.
  // Used to free the Protractor 300 req/min quota during one-off historical
  // backfills run by scripts/drain-protractor-backfill.ts. Skips any job
  // whose name starts with "protractor-" (sync, backfill, weekend-boost).
  // Requires a service restart for the env-var change to take effect.
  const pauseProtractor = process.env.PAUSE_PROTRACTOR_CRON === "true";
  if (pauseProtractor) {
    console.log("[Cron] PAUSE_PROTRACTOR_CRON=true — Protractor jobs will NOT be scheduled this boot");
  }
  // Time-bounded pause for Protractor cron jobs. Set to an ISO 8601 datetime
  // (e.g. "2026-05-04T10:00:00Z" = Mon 06:00 ET in May). Jobs are still
  // REGISTERED at boot, but each fire is short-circuited until the cutoff
  // passes — so the pause auto-clears on its own with no second deploy.
  // Useful for "pause through the weekend drain, resume Monday morning"
  // without having to remember to flip a flag back. Invalid date strings
  // log a warning and disable the gate (fail-open: jobs run normally).
  // Time-bounded pause for the two daytime Tekmetric backfill crons that
  // run inline on the web instance and contend with interactive traffic:
  // `fullpage-backfill-tekmetric` and `weekday-backfill-boost`. Neither is
  // covered by PAUSE_TEKMETRIC_CRON (name-prefix based, and the boost was
  // deliberately named to dodge it). Same semantics as
  // PROTRACTOR_PAUSE_UNTIL below: ISO 8601 cutoff, jobs stay registered,
  // fires are short-circuited until the cutoff, auto-resumes with no
  // second deploy. Invalid values warn and fail open.
  const TEKMETRIC_BACKFILL_PAUSED_JOBS = new Set([
    "fullpage-backfill-tekmetric",
    "weekday-backfill-boost",
  ]);
  let tekmetricBackfillPauseUntilMs = null;
  if (process.env.TEKMETRIC_BACKFILL_PAUSE_UNTIL) {
    const parsed = Date.parse(process.env.TEKMETRIC_BACKFILL_PAUSE_UNTIL);
    if (Number.isFinite(parsed)) {
      tekmetricBackfillPauseUntilMs = parsed;
      const remainingMin = Math.max(0, Math.round((parsed - Date.now()) / 60000));
      console.log(`[Cron] TEKMETRIC_BACKFILL_PAUSE_UNTIL=${process.env.TEKMETRIC_BACKFILL_PAUSE_UNTIL} — ${[...TEKMETRIC_BACKFILL_PAUSED_JOBS].join(", ")} suppressed for next ~${remainingMin}min (auto-resumes after cutoff)`);
    } else {
      console.warn(`[Cron] TEKMETRIC_BACKFILL_PAUSE_UNTIL="${process.env.TEKMETRIC_BACKFILL_PAUSE_UNTIL}" is not a valid ISO datetime — ignoring`);
    }
  }
  let protractorPauseUntilMs = null;
  if (process.env.PROTRACTOR_PAUSE_UNTIL) {
    const parsed = Date.parse(process.env.PROTRACTOR_PAUSE_UNTIL);
    if (Number.isFinite(parsed)) {
      protractorPauseUntilMs = parsed;
      const remainingMin = Math.max(0, Math.round((parsed - Date.now()) / 60000));
      console.log(`[Cron] PROTRACTOR_PAUSE_UNTIL=${process.env.PROTRACTOR_PAUSE_UNTIL} — Protractor fires suppressed for next ~${remainingMin}min (auto-resumes after cutoff)`);
    } else {
      console.warn(`[Cron] PROTRACTOR_PAUSE_UNTIL="${process.env.PROTRACTOR_PAUSE_UNTIL}" is not a valid ISO datetime — ignoring`);
    }
  }

  let registered = 0;
  const skipped = [];
  const skippedProtractor = [];
  // Task #1079: when the incremental sync lane lives on the background
  // worker service (TEKMETRIC_INCREMENTAL_ON_WORKER=true — see
  // workers/tekmetric-incremental-loop.ts), the web scheduler must not
  // also register the cron or the cycle would run on both services and
  // double the background load on the Tekmetric key. One shared env var
  // flips both sides atomically.
  const incrementalOnWorker = process.env.TEKMETRIC_INCREMENTAL_ON_WORKER === "true";
  if (incrementalOnWorker) {
    console.log("[Cron] TEKMETRIC_INCREMENTAL_ON_WORKER=true — tekmetric-incremental-sync will NOT be scheduled on this (web) instance; the worker runs it");
  }

  const registeredJobs = [];
  const protractorOutboundPolicy = evaluateProtractorOutboundPolicy(process.env);
  for (const job of jobs) {
    if (pauseTekmetric && job.name.startsWith("tekmetric-")) {
      skipped.push(job.name);
      continue;
    }
    if (incrementalOnWorker && job.name === "tekmetric-incremental-sync") {
      skipped.push(job.name);
      continue;
    }
    if (pauseProtractor && job.name.startsWith("protractor-")) {
      skippedProtractor.push(job.name);
      continue;
    }
    if (job.name.startsWith("protractor-") && !protractorOutboundPolicy.allowed) {
      skippedProtractor.push(job.name);
      logProtractorPolicyDenial(protractorOutboundPolicy, "cron_scheduler_registration");
      continue;
    }
    if (!cron.validate(job.schedule)) {
      console.error(`[Cron] Invalid schedule for ${job.name}: ${job.schedule}`);
      continue;
    }
    const isProtractorJob = job.name.startsWith("protractor-");
    const task = cron.schedule(
      job.schedule,
      () => {
        if (
          isProtractorJob &&
          protractorPauseUntilMs !== null &&
          Date.now() < protractorPauseUntilMs
        ) {
          const remainingMin = Math.round((protractorPauseUntilMs - Date.now()) / 60000);
          console.log(`[Cron] ${job.name} suppressed by PROTRACTOR_PAUSE_UNTIL (resumes in ~${remainingMin}min)`);
          return;
        }
        if (
          tekmetricBackfillPauseUntilMs !== null &&
          TEKMETRIC_BACKFILL_PAUSED_JOBS.has(job.name) &&
          Date.now() < tekmetricBackfillPauseUntilMs
        ) {
          const remainingMin = Math.round((tekmetricBackfillPauseUntilMs - Date.now()) / 60000);
          console.log(`[Cron] ${job.name} suppressed by TEKMETRIC_BACKFILL_PAUSE_UNTIL (resumes in ~${remainingMin}min)`);
          return;
        }
        runJob(job, baseUrl, secret, instanceId).catch((err) => {
          console.error(`[Cron] Unhandled error in ${job.name}:`, err);
        });
      },
      // Per-job timezone (default UTC, unchanged for every existing job).
      // A job may set `timezone: "America/Chicago"` so its schedule is
      // interpreted in that zone with automatic DST handling — used by the
      // worker-power suspend/resume jobs that must fire on Central wall-clock.
      { timezone: job.timezone || "UTC" }
    );
    tasks.push(task);
    registered += 1;
    registeredJobs.push({
      name: job.name,
      schedule: job.schedule,
      timezone: job.timezone || "UTC",
      method: job.method || "GET",
      path: job.path,
    });
    console.log(`[Cron]   • ${job.name.padEnd(28)} ${job.schedule.padEnd(15)} ${(job.timezone || "UTC").padEnd(16)} ${(job.method || "GET").padEnd(5)} ${job.path}`);
  }
  console.log(`[Cron] ${registered} jobs registered and scheduled`);
  if (skipped.length) {
    console.log(`[Cron] ${skipped.length} jobs skipped due to PAUSE_TEKMETRIC_CRON: ${skipped.join(", ")}`);
  }
  if (skippedProtractor.length) {
    console.log(`[Cron] ${skippedProtractor.length} jobs skipped due to PAUSE_PROTRACTOR_CRON: ${skippedProtractor.join(", ")}`);
  }
  recordBoot({
    status: "running",
    bootedAt: new Date(),
    instanceId,
    host,
    pid: process.pid,
    baseUrl,
    jobsRegistered: registered,
    jobs: registeredJobs,
  });
  // Fire-and-forget: prime `lastSuccessByJob` from any existing successful
  // `lastRuns` entries so the cron-health alerter has signal immediately
  // after a deploy instead of waiting up to 24h for each daily job to land
  // its first post-deploy success (task #455).
  seedLastSuccessByJob().catch((err) => {
    console.warn("[Cron] lastSuccessByJob seed crashed:", err && err.message);
  });
  started = true;
}

function stopScheduler() {
  for (const task of tasks) {
    try { task.stop(); } catch (e) {}
  }
  tasks.length = 0;
  started = false;
}

module.exports = {
  startScheduler,
  stopScheduler,
  requestWithAbort,
  // Test seams for the Postgres cron-lock backend (task #557).
  isCronLockPgCanonical,
  tryAcquireLockPg,
  releaseLockPg,
};
