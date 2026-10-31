/** Dedicated process. No provider work runs in a Next.js request handler. */
import { getDb } from "../lib/data/db";
import { findEnterpriseById } from "../lib/data/repositories/enterprise";
import { listShopsByShopIds } from "../lib/data/repositories/shops";
import { tickTirePilot, type PilotLocation } from "../lib/tire-dot-pilot-worker";
import { fetchTirePilotPage } from "../lib/tire-dot-pilot-transport";
import { processNextTireRun } from "../lib/tire-dot-report-service";
import { createTirePilotManualBudget } from "../lib/tire-dot-manual-budget";

let stop = false;
process.on("SIGTERM", () => { stop = true; });
process.on("SIGINT", () => { stop = true; });
async function locations(enterpriseId: string): Promise<PilotLocation[]> {
  const enterprise = await findEnterpriseById(enterpriseId);
  if (!enterprise || enterprise.name !== "HEART Certified Auto Care") throw Error("scope_invalid");
  const ids = enterprise.shopIds.map(Number);
  const shops = await listShopsByShopIds(ids);
  if (shops.length !== ids.length) throw Error("scope_incomplete");
  return shops.map((s: any) => {
    const provider = s.integrationProvider || s.smsProvider || s.smsType;
    const providerShopId = Number(s.tekmetric?.shopId || s.tekmetricShopId);
    if ((provider && String(provider).toLowerCase() !== "tekmetric") ||
        !Number.isSafeInteger(providerShopId) || providerShopId <= 0 ||
        ["canceled", "cancelled"].includes(String(s.status).toLowerCase())) throw Error("scope_invalid");
    return { shopId: Number(s.shopId), providerShopId, timezone: s.timezone || "America/Chicago" };
  });
}
async function main() {
  const startedAt = Date.now();
  const manualBudget = createTirePilotManualBudget(process.argv, () => new Date());
  if (manualBudget && process.env.RENDER !== "true") throw Error("Manual pilot requires the production Render runtime");
  const mode = manualBudget ? "manual" : "scheduled";
  console.log("[HEART Tire Pilot] Started", { mode, at: new Date(startedAt).toISOString() });
  let lastOutcome = "", lastLoggedAt = 0;
  do {
    if (manualBudget && !manualBudget.available()) break;
    try {
      const db = await getDb();
      const result = await tickTirePilot(db, { now: () => new Date(), locations, manualBudget,
        page: (location, page, beforeRequest) => fetchTirePilotPage(db, location, page, beforeRequest) });
      const reason = "reason" in result ? result.reason : undefined;
      const outcome = `${result.status}:${reason || ""}`;
      if (outcome !== lastOutcome || Date.now() - lastLoggedAt >= 60_000) {
        console.log("[HEART Tire Pilot] Progress", { mode, at: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt, status: result.status, reason,
          ...(manualBudget ? { requests: manualBudget.requests } : {}) });
        lastOutcome = outcome; lastLoggedAt = Date.now();
      }
      if (manualBudget && !["idle", "refreshing"].includes(result.status)) break;
      // Completed evidence can be reported in business hours, without HTTP to
      // Tekmetric. A second worker only claims persisted report pages.
      if (!manualBudget) await processNextTireRun(true);
    } catch {
      console.error("[HEART Tire Pilot] Worker unavailable; retrying after bounded pause");
      if (manualBudget) break;
    }
    if (process.argv.includes("--once") || stop) break;
    await new Promise(resolve => setTimeout(resolve, 10_000));
  } while (!stop);
  if (manualBudget) console.log("[HEART Tire Pilot] Bounded manual run stopped", {
    requests: manualBudget.requests, elapsedMs: Date.now() - startedAt,
    reason: stop ? "signal" : !manualBudget.available() ? "budget_exhausted" : "terminal_outcome",
  });
}
main().then(() => process.exit(0)).catch(() => process.exit(1));
