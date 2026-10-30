/** Dedicated process. No provider work runs in a Next.js request handler. */
import { getDb } from "../lib/data/db";
import { findEnterpriseById } from "../lib/data/repositories/enterprise";
import { listShopsByShopIds } from "../lib/data/repositories/shops";
import { tickTirePilot, type PilotLocation } from "../lib/tire-dot-pilot-worker";
import { fetchTirePilotPage } from "../lib/tire-dot-pilot-transport";
import { processNextTireRun } from "../lib/tire-dot-report-service";

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
  do {
    try {
      const db = await getDb();
      const result = await tickTirePilot(db, { now: () => new Date(), locations,
        page: (location, page, beforeRequest) => fetchTirePilotPage(db, location, page, beforeRequest) });
      if (result.status !== "idle") console.log("[HEART Tire Pilot]", result.status);
      // Completed evidence can be reported in business hours, without HTTP to
      // Tekmetric. A second worker only claims persisted report pages.
      await processNextTireRun(true);
    } catch { console.error("[HEART Tire Pilot] Worker unavailable; retrying after bounded pause"); }
    if (process.argv.includes("--once") || stop) break;
    await new Promise(resolve => setTimeout(resolve, 10_000));
  } while (!stop);
}
main().then(() => process.exit(0)).catch(() => process.exit(1));
