/**
 * Dedicated daytime-safe automatic-audit consumer.
 *
 * This intentionally is NOT registered in workers/worker.ts: the existing
 * backfill worker is suspended during weekday business hours. Operators deploy
 * this as a separate always-on background worker only after the runbook's
 * indexes and canary flags are in place.
 */
import type { Worker as BullWorker, Job } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { QUEUE_NAMES, STALLED_VISIBILITY_MS } from "@/lib/queue/queues";

const workers: BullWorker[] = [];

function concurrency(): number {
  const value = Number.parseInt(process.env.ESTIMATE_AUDIT_WORKER_CONCURRENCY || "1", 10);
  // One by default is deliberate: it is both the fleet cap and the simplest
  // safe per-shop limit during rollout. The processor retains a durable
  // per-shop lease if operators later raise this.
  return Number.isFinite(value) && value > 0 ? Math.min(value, 4) : 1;
}

export async function startAuditWorker(): Promise<void> {
  if (process.env.ESTIMATE_AUDIT_WORKER_ENABLED !== "true") {
    console.log("[AuditWorker] disabled; set ESTIMATE_AUDIT_WORKER_ENABLED=true after operator prerequisites");
    return;
  }
  const connection = getRedisConnection();
  if (!connection) {
    console.log("[AuditWorker] REDIS_URL not set; automatic audit consumer unavailable");
    return;
  }
  // Keep all server-only evaluator/database imports behind the explicit
  // enablement gate. A disabled worker must be safe to start for config checks.
  const { processEstimateAudit } = await import("./processors/estimate-audit");
  const { Worker } = require("bullmq") as typeof import("bullmq");
  const worker = new Worker(
    QUEUE_NAMES.ESTIMATE_AUDIT,
    (job: Job) => processEstimateAudit(job as any),
    {
      connection: connection as any,
      concurrency: concurrency(),
      stalledInterval: STALLED_VISIBILITY_MS / 2,
      maxStalledCount: 2,
    },
  );
  worker.on("failed", (job, error) => console.error(`[AuditWorker] job=${job?.id} attempt=${job?.attemptsMade} failed: ${error?.message || error}`));
  worker.on("error", (error) => console.error(`[AuditWorker] error: ${error?.message || error}`));
  workers.push(worker);
  console.log(`[AuditWorker] started queue=${QUEUE_NAMES.ESTIMATE_AUDIT} concurrency=${concurrency()}`);

  const shutdown = async (signal: string) => {
    console.log(`[AuditWorker] received ${signal}; draining`);
    await Promise.allSettled(workers.map((item) => item.close()));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (require.main === module) {
  startAuditWorker().catch((error) => {
    console.error("[AuditWorker] fatal startup error:", error);
    process.exit(1);
  });
}