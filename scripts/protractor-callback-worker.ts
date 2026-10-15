import { assertCallbackWorkerConfiguration } from "../lib/integrations/protractor/callback-worker-policy";
import { runCallbackWorkerLoop } from "../lib/integrations/protractor/callback-worker-loop";

async function main() {
  // Validate before importing database/provider modules. This process is callback-only.
  assertCallbackWorkerConfiguration(process.env);
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  const { processProtractorCallbackDrain } = await import("../lib/integrations/protractor/callback-drain");
  await runCallbackWorkerLoop({
    stopping: () => stopping,
    drain: () => processProtractorCallbackDrain(undefined, {
      executionTarget: "worker",
      shouldStop: () => stopping,
    }),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    report: (result) => console.info(JSON.stringify({
      event: "protractor_callback_worker_batch",
      outcome: result ? "completed" : "failed",
      ...(result ?? {}),
    })),
  });
  // All admitted work has settled. Close pools/timers owned by this dedicated process.
  process.exit(0);
}
main().catch(() => {
  console.error("Protractor callback worker startup failed");
  process.exit(1);
});
