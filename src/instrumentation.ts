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

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
