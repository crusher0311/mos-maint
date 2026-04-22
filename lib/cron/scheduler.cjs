const cron = require("node-cron");
const os = require("os");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;
const LOCK_COLLECTION = "cron_locks";
const STATUS_COLLECTION = "cron_status";
const STATUS_DOC_ID = "global";
const BOOT_HISTORY_LIMIT = 10;

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

async function tryAcquireLock(jobName, ttlMs, instanceId) {
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

async function releaseLock(jobName, instanceId) {
  try {
    const db = await getDb();
    await db.collection(LOCK_COLLECTION).deleteOne({ _id: jobName, instanceId });
  } catch (err) {
    console.warn(`[Cron] Lock release error for ${jobName}:`, err.message);
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

async function recordRun(jobName, result) {
  try {
    const db = await getDb();
    await db.collection(STATUS_COLLECTION).updateOne(
      { _id: STATUS_DOC_ID },
      {
        $set: {
          [`lastRuns.${jobName}`]: result,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
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
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    const ms = Date.now() - startedAt;
    const text = await res.text().catch(() => "");
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

  let registered = 0;
  const skipped = [];
  const registeredJobs = [];
  for (const job of jobs) {
    if (pauseTekmetric && job.name.startsWith("tekmetric-")) {
      skipped.push(job.name);
      continue;
    }
    if (!cron.validate(job.schedule)) {
      console.error(`[Cron] Invalid schedule for ${job.name}: ${job.schedule}`);
      continue;
    }
    const task = cron.schedule(
      job.schedule,
      () => {
        runJob(job, baseUrl, secret, instanceId).catch((err) => {
          console.error(`[Cron] Unhandled error in ${job.name}:`, err);
        });
      },
      { timezone: "UTC" }
    );
    tasks.push(task);
    registered += 1;
    registeredJobs.push({
      name: job.name,
      schedule: job.schedule,
      method: job.method || "GET",
      path: job.path,
    });
    console.log(`[Cron]   • ${job.name.padEnd(28)} ${job.schedule.padEnd(15)} ${(job.method || "GET").padEnd(5)} ${job.path}`);
  }
  console.log(`[Cron] ${registered} jobs registered and scheduled`);
  if (skipped.length) {
    console.log(`[Cron] ${skipped.length} jobs skipped due to PAUSE_TEKMETRIC_CRON: ${skipped.join(", ")}`);
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
  started = true;
}

function stopScheduler() {
  for (const task of tasks) {
    try { task.stop(); } catch (e) {}
  }
  tasks.length = 0;
  started = false;
}

module.exports = { startScheduler, stopScheduler };
