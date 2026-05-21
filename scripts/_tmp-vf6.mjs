import { config } from "dotenv";
config({ path: ".env.local" });
const { fetchActiveWorkOrders, resolveProtractorConfig, fetchWorkOrderById } = await import("../lib/integrations/protractor/index.ts");

const SHOP_ID = 116;
const cfg = await resolveProtractorConfig(SHOP_ID);
console.log("config.configured:", cfg.configured, "baseUrl:", cfg.baseUrl, "locationId:", cfg.locationId);

console.log("\n=== fetchActiveWorkOrders(116, {readInProgress:true}) ===");
const res = await fetchActiveWorkOrders(SHOP_ID, { readInProgress: true });
console.log("ok:", res.ok, "error:", res.error || "—", "count:", res.workOrders?.length || 0);

if (res.workOrders?.length) {
  // Sort by WorkOrderNumber desc
  const sorted = [...res.workOrders].sort((a, b) => (b.WorkOrderNumber || 0) - (a.WorkOrderNumber || 0));
  console.log("\ntop 10 by WorkOrderNumber:");
  for (const w of sorted.slice(0, 10)) {
    console.log(" ", w.WorkOrderNumber, "|", w.WorkflowStage, "|", w.ServiceItem?.VIN || "no-vin", "|", w.Customer?.Name || w.ServiceItem?.Customer?.Name || "?");
  }
  
  console.log("\nlooking for 142270 / 142310 / 142345:");
  for (const tgt of [142270, 142310, 142345, 142236]) {
    const hit = res.workOrders.find(w => w.WorkOrderNumber === tgt);
    console.log(" ", tgt, ":", hit ? `FOUND - stage=${hit.WorkflowStage} vin=${hit.ServiceItem?.VIN || "?"} id=${hit.ID}` : "NOT in active list");
  }

  const stageCounts = {};
  for (const w of res.workOrders) {
    const s = w.WorkflowStage || "Unknown";
    stageCounts[s] = (stageCounts[s] || 0) + 1;
  }
  console.log("\nstage distribution:", stageCounts);
  
  const nums = res.workOrders.map(w => w.WorkOrderNumber).filter(n => typeof n === "number");
  console.log("WO# range:", Math.min(...nums), "to", Math.max(...nums));
}
