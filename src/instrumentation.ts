export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ENABLE_INPROCESS_CRON !== "true") {
    console.log("[Cron] ENABLE_INPROCESS_CRON not set — scheduler disabled");
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
    console.error("[Cron] Failed to start scheduler:", err?.message || err);
  }
}
