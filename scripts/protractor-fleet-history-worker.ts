import { randomUUID } from "node:crypto";
import { runFleetHistoryTick, reportFleetHistoryWorker } from "../lib/integrations/protractor/fleet-history";
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
async function main() {
  const importsEnabled = process.env.PROTRACTOR_FLEET_HISTORY_WORKER_ENABLED === "true";
  if (!importsEnabled && process.env.PROTRACTOR_FLEET_HISTORY_READINESS_ONLY !== "true") {
    console.log("Fleet history worker disabled"); return;
  }
  if (!process.env.RENDER || process.env.REPL_ID || process.env.REPLIT_DEV_DOMAIN)
    throw new Error("Fleet history execution requires the dedicated production worker");
  const owner = randomUUID();
  const revision = process.env.RENDER_GIT_COMMIT || null;
  let status: "idle" | "running" | "blocked" | "failed" | "stopped" = "idle";
  let heartbeat: Promise<void> | null = null;
  await reportFleetHistoryWorker(owner, importsEnabled, status, revision);
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = reportFleetHistoryWorker(owner, importsEnabled, status, revision)
      .catch(() => { stopping = true; process.exitCode = 1; })
      .finally(() => { heartbeat = null; });
  }, 20000);
  try {
    while (!stopping) {
      try {
        if (importsEnabled) {
          status = "running";
          await reportFleetHistoryWorker(owner, importsEnabled, status, revision);
          const result = await runFleetHistoryTick();
          status = result.processed ? "idle" : "blocked";
          console.log(JSON.stringify({ event: "protractor_fleet_history_tick", ...result }));
        }
        await reportFleetHistoryWorker(owner, importsEnabled, status, revision);
      } catch {
        status = "failed";
        console.error(JSON.stringify({ event: "protractor_fleet_history_tick_failed" }));
      }
      // Respond to shutdown promptly between passes, without clearing engine leases.
      for (let i = 0; i < 60 && !stopping; i++) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    clearInterval(timer);
    if (heartbeat) await heartbeat;
    await reportFleetHistoryWorker(owner, importsEnabled, "stopped", revision);
  }
}
main().catch(() => { console.error("Fleet history worker stopped"); process.exitCode = 1; });
