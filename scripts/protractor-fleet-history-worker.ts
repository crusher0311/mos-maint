import { runFleetHistoryTick } from "../lib/integrations/protractor/fleet-history";
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
async function main() {
  if (process.env.PROTRACTOR_FLEET_HISTORY_WORKER_ENABLED !== "true") {
    console.log("Fleet history worker disabled"); return;
  }
  if (!process.env.RENDER || process.env.REPL_ID || process.env.REPLIT_DEV_DOMAIN)
    throw new Error("Fleet history execution requires the dedicated production worker");
  while (!stopping) {
    try { console.log(JSON.stringify({ event: "protractor_fleet_history_tick", ...await runFleetHistoryTick() })); }
    catch { console.error(JSON.stringify({ event: "protractor_fleet_history_tick_failed" })); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 60000));
  }
}
main().catch(() => { console.error("Fleet history worker stopped"); process.exitCode = 1; });
