/**
 * Opt-in dedicated stored-report processor. Enable only after the coordinated
 * rollout in docs/reporting-queue-worker-rollout.md. No provider collection.
 */
import { processNextReportRun } from "../lib/report-run-service";
import { processTireRunBatch } from "../lib/tire-dot-report-service";
import { runReportQueueWorker } from "../lib/report-queue-worker";

let stop = false;
process.on("SIGTERM", () => { stop = true; });
process.on("SIGINT", () => { stop = true; });

async function main() {
  if (process.env.REPORTING_QUEUE_WORKER_ENABLED !== "true") {
    throw new Error("Dedicated report queue worker is not enabled");
  }
  await runReportQueueWorker({
    general: processNextReportRun,
    tires: () => processTireRunBatch({ shouldStop: () => stop }),
    shouldStop: () => stop,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    // Do not log requester identities, report data, or database error values.
    onError: queue => console.error("[report-queue] Processor unavailable", { queue }),
  });
}
main().then(() => process.exit(0)).catch(() => {
  console.error("[report-queue] Worker stopped; verify configuration");
  process.exit(1);
});
