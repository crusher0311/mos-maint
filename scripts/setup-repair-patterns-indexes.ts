import { getDb } from "../lib/mongo";
import { setupRepairPatternsIndexes } from "../lib/repair-patterns";

async function main() {
  console.log("Setting up repair patterns indexes...");
  
  try {
    await setupRepairPatternsIndexes();
    console.log("Repair patterns indexes created successfully");
    
    const db = await getDb();
    const indexes = await db.collection("shop_repair_patterns").indexes();
    console.log("Current indexes:", indexes.map(i => i.name));
    
    process.exit(0);
  } catch (error) {
    console.error("Failed to create indexes:", error);
    process.exit(1);
  }
}

main();
