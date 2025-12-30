import { getDb } from "../lib/mongo";

async function main() {
  const db = await getDb();
  
  console.log("\n=== Tekmetric Work Orders (shop 28) ===");
  const workOrders = await db.collection('tekmetric_work_orders').find({
    shopId: { $in: [28, "28"] }
  }).limit(10).toArray();
  
  for (const wo of workOrders) {
    console.log(`RO# ${wo.workOrderNumber}: status="${wo.status}", label="${wo.label || 'EMPTY'}", labelColor="${wo.labelColor || 'EMPTY'}"`);
  }
  
  console.log("\n=== Sample raw data from first work order ===");
  if (workOrders[0]?.data) {
    const d = workOrders[0].data;
    console.log("repairOrderStatus:", JSON.stringify(d.repairOrderStatus));
    console.log("repairOrderLabel:", JSON.stringify(d.repairOrderLabel));
    console.log("repairOrderCustomLabel:", JSON.stringify(d.repairOrderCustomLabel));
    console.log("color:", d.color);
  }
  
  process.exit(0);
}

main().catch(console.error);
