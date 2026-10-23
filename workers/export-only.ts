import { exportOnlyLifecycle, validateExportWorkerEnvironment } from "./export-only-lifecycle";

/**
 * Dedicated entry point. Never import workers/worker or start-worker here.
 * Dynamic imports keep a disabled invocation free of database/Redis side effects.
 */
export async function runExportOnlyWorker() {
  if (!validateExportWorkerEnvironment(process.env)) {
    console.log("[Export worker] Disabled; no consumers started");
    return;
  }
  // Bound startup even if DNS/database/Redis never becomes ready.
  const startupDeadline = setTimeout(() => {
    console.error("[Export worker] Startup deadline exceeded");
    process.exit(1);
  }, 30_000);
  const { Worker } = await import("bullmq");
  const { default: Redis } = await import("ioredis");
  const { prerequisites } = await import("../lib/protractor-exports/store");
  const { processProtractorExport, exportHeartbeat } = await import("./processors/protractor-export");
  let redis: InstanceType<typeof Redis> | undefined;
  let shutdown: Promise<void> | undefined;
  const lifecycle = exportOnlyLifecycle({
    preflight: async () => {
      // Checks PG control storage and Mongo raw-source indexes, without DDL.
      await prerequisites();
    },
    createConsumer(queue, concurrency) {
      redis = new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: null, enableReadyCheck: true,
      });
      redis.on("error", () => console.warn("[Export worker] Redis unavailable"));
      const worker = new Worker(queue, processProtractorExport, {
        connection: redis as any, concurrency, stalledInterval: 30_000, maxStalledCount: 3,
      });
      // Never log job bodies, destinations, error messages or credentials.
      worker.on("error", () => console.warn("[Export worker] Consumer unavailable"));
      worker.on("failed", () => console.warn("[Export worker] Job failed"));
      return worker;
    },
    heartbeat: exportHeartbeat, // Also performs retention for paused destinations.
    disconnect: async () => { redis?.disconnect(); },
    schedule: callback => setInterval(callback, 30_000),
    unschedule: timer => clearInterval(timer as NodeJS.Timeout),
    warn: () => console.warn("[Export worker] Heartbeat unavailable"),
  });
  const stop = (exitCode: number) => {
    if (shutdown) return shutdown;
    clearTimeout(startupDeadline);
    // Never hang indefinitely on Redis or an unfinished job. Durable jobs retry.
    const deadline = setTimeout(() => {
      console.error("[Export worker] Drain deadline exceeded");
      process.exit(1);
    }, 25_000);
    shutdown = lifecycle.stop().then(() => {
      clearTimeout(deadline);
      process.exit(exitCode);
    }, () => {
      clearTimeout(deadline);
      console.error("[Export worker] Drain failed");
      process.exit(1);
    });
    return shutdown;
  };
  process.once("SIGTERM", () => { void stop(0); });
  process.once("SIGINT", () => { void stop(0); });
  try {
    await lifecycle.start();
    clearTimeout(startupDeadline);
    if (!shutdown) console.log("[Export worker] Export-only consumer ready");
  } catch {
    console.error("[Export worker] Startup failed");
    await stop(1);
  }
}

if (require.main === module) {
  void runExportOnlyWorker().catch(() => {
    console.error("[Export worker] Invalid configuration or startup failure");
    process.exit(1);
  });
}
