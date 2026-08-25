async function recordSchedulerStatus(
  status: "failed" | "disabled",
  reason: string,
  message?: string,
) {
  try {
    const nodeRequire = eval("require") as NodeRequire;
    const { MongoClient } = nodeRequire("mongodb") as typeof import("mongodb");
    let uri = process.env.MONGODB_URI || "";
    if (!uri || uri.includes("localhost")) {
      const user = encodeURIComponent(process.env.MONGODB_USERNAME || "");
      const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || "");
      if (!user || !pass) return;
      uri = `mongodb+srv://${user}:${pass}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;
    }
    const client = new MongoClient(uri);
    await client.connect();
    try {
      const entry: Record<string, any> = {
        status,
        reason,
        bootedAt: new Date(),
        host: process.env.RENDER_INSTANCE_ID || "local",
        pid: process.pid,
      };
      if (message) entry.error = message;
      await client
        .db("mos")
        .collection("cron_status")
        .updateOne(
          { _id: "global" as any },
          {
            $set: { lastBoot: entry, updatedAt: new Date() },
            $push: {
              bootHistory: {
                $each: [entry],
                $position: 0,
                $slice: 10,
              } as any,
            },
          },
          { upsert: true },
        );
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err: any) {
    console.warn(
      "[Cron] Could not persist scheduler status to Mongo:",
      err?.message || err,
    );
  }
}

// Ensure the handful of compound indexes that hot interactive paths
// (extension VHI, dashboard) depend on. Mongo `createIndex` is idempotent,
// so this runs on every boot but does real work only the first time after
// the index list grows. Critical indexes added here so a fresh deploy
// doesn't ship a missing-index regression that surfaces as 10–60s VHI loads.
async function ensureCriticalIndexes() {
  try {
    const nodeRequire = eval("require") as NodeRequire;
    const { MongoClient } = nodeRequire("mongodb") as typeof import("mongodb");
    let uri = process.env.MONGODB_URI || "";
    if (!uri || uri.includes("localhost")) {
      const user = encodeURIComponent(process.env.MONGODB_USERNAME || "");
      const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || "");
      if (!user || !pass) return;
      uri = `mongodb+srv://${user}:${pass}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;
    }
    const client = new MongoClient(uri);
    await client.connect();
    try {
      const db = client.db("mos-maintenance-mvp");
      const ensures: Array<{ col: string; key: any; name: string }> = [
        // VHI history lookup — without this the extension scans every RO
        // for the shop on every plan request (134k+ for HEART 82).
        {
          col: "tekmetric_work_orders",
          key: { shopId: 1, vin: 1, completedDate: -1 },
          name: "shopId_1_vin_1_completedDate_-1",
        },
        // RO-by-id lookup used by the live-RO fallback + DVI overlay.
        {
          col: "tekmetric_work_orders",
          key: { shopId: 1, workOrderId: 1 },
          name: "shopId_1_workOrderId_1",
        },
      ];
      for (const { col, key, name } of ensures) {
        try {
          await db.collection(col).createIndex(key, { background: true, name });
        } catch (err: any) {
          // 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict — both
          // mean the index already exists with compatible spec. Anything
          // else gets logged but doesn't fail boot.
          if (err?.code !== 85 && err?.code !== 86) {
            console.warn(
              `[Indexes] ${col}.${name} ensure failed:`,
              err?.message || err,
            );
          }
        }
      }
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err: any) {
    console.warn(
      "[Indexes] ensureCriticalIndexes failed at boot:",
      err?.message || err,
    );
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Defense in depth for every production server entrypoint, including a
  // direct `next start` that bypasses Render's start-with-workers wrapper.
  // This runs before Next accepts requests and deliberately throws rather
  // than allowing partner VHI responses to fail later while signing links.
  if (process.env.NODE_ENV === "production") {
    const { validateProductionEnv } = require(
      "../scripts/validate-production-env.cjs"
    ) as {
      validateProductionEnv: (
        env?: Record<string, string | undefined>,
      ) => void;
    };
    validateProductionEnv();
  }

  // Task #1162: slow-query caller attribution — patch http.Server so every
  // inbound request (web API routes AND the cron scheduler's internal
  // /api/cron/* invocations) runs inside an AsyncLocalStorage context tagged
  // with its normalized route path. The slow-query tracker reads the tag at
  // capture time. No-op overhead when SLOW_QUERY_TRACKING_DISABLED=1.
  try {
    const { installSlowQueryCallerTagging } = await import(
      "@/lib/slow-query/caller-context"
    );
    installSlowQueryCallerTagging();
  } catch (err: any) {
    console.warn(
      "[SlowQuery] caller tagging install failed:",
      err?.message || String(err),
    );
  }

  // Run unconditionally so QA/prod web boots all guarantee the indexes
  // are present, regardless of whether the cron scheduler is enabled.
  await ensureCriticalIndexes();

  // Task #460: host-load sampler runs alongside the in-process cron so
  // chunk metrics can be correlated with CPU/RSS/event-loop/PG-pool
  // pressure when measuring the safe backfill cadence ceiling. Boots
  // independently of the scheduler — if cron is disabled this still
  // collects baseline load for the web process.
  //
  // mongodb is marked as a webpack external in next.config.js so the
  // instrumentation bundle doesn't try to resolve mongodb's Node-only
  // deps (`net`, `crypto`, etc.) at build time. The dynamic import
  // below is what triggers the chain at runtime.
  try {
    const { startHostLoadSampler } = await import(
      "@/lib/backfill-metrics/host-load-sampler"
    );
    startHostLoadSampler();
  } catch (err: any) {
    console.warn(
      "[HostLoadSampler] failed to start:",
      err?.message || String(err),
    );
  }

  if (process.env.ENABLE_INPROCESS_CRON !== "true") {
    console.log("[Cron] ENABLE_INPROCESS_CRON not set — scheduler disabled");
    // Persist intentional disable so the observability page shows
    // "disabled" rather than "no record" in environments where the flag
    // is deliberately off.
    await recordSchedulerStatus(
      "disabled",
      "ENABLE_INPROCESS_CRON not set",
    );
    return;
  }

  try {
    // Use eval("require") so webpack does NOT statically analyze these
    // requires. Without this, webpack emits noisy "Critical dependency: the
    // request of a dependency is an expression" + "Module not found: Can't
    // resolve 'path'" warnings on every Fast Refresh, which can flood the
    // dev console and trip false-positive "crash" detection.
    const nodeRequire = eval("require") as NodeRequire;
    const nodePath = nodeRequire("path") as typeof import("path");
    const schedulerPath = nodePath.join(
      process.cwd(),
      "lib/cron/scheduler.cjs"
    );
    const jobsPath = nodePath.join(process.cwd(), "lib/cron/jobs.cjs");
    const { startScheduler } = nodeRequire(schedulerPath);
    const { CRON_JOBS } = nodeRequire(jobsPath);
    startScheduler(CRON_JOBS);
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error("[Cron] Failed to start scheduler:", message);
    // Persist to Mongo so it surfaces on the observability page even when
    // Better Stack log retention has rolled past the boot moment.
    await recordSchedulerStatus("failed", "require_failed", message);
  }
}
