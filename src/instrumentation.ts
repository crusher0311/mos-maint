export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ENABLE_INPROCESS_CRON !== "true") {
    console.log("[Cron] ENABLE_INPROCESS_CRON not set — scheduler disabled");
    return;
  }

  try {
    const path = require("path");
    const schedulerPath = path.join(process.cwd(), "lib/cron/scheduler.cjs");
    const jobsPath = path.join(process.cwd(), "lib/cron/jobs.cjs");
    const { startScheduler } = require(schedulerPath);
    const { CRON_JOBS } = require(jobsPath);
    startScheduler(CRON_JOBS);
  } catch (err: any) {
    console.error("[Cron] Failed to start scheduler:", err?.message || err);
  }
}
