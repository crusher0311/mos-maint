import { getDb } from "../lib/mongo";
import type { IndexSpecification, CreateIndexesOptions } from "mongodb";

interface IndexDef {
  collection: string;
  index: IndexSpecification;
  name: string;
  options?: CreateIndexesOptions;
}

async function addIndexes() {
  const db = await getDb();
  console.log("Adding MongoDB indexes for performance...\n");

  const indexes: IndexDef[] = [
    { collection: "vehicles", index: { vin: 1, updatedAt: -1 }, name: "vin_updatedAt" },
    { collection: "vehicles", index: { shopId: 1, createdAt: -1 }, name: "shopId_createdAt" },
    { collection: "repair_orders", index: { vin: 1, updatedAt: -1 }, name: "vin_updatedAt" },
    { collection: "repair_orders", index: { shopId: 1, createdAt: -1 }, name: "shopId_createdAt" },
    { collection: "events", index: { vin: 1, updatedAt: -1 }, name: "vin_updatedAt" },
    { collection: "events", index: { shopId: 1, provider: 1, createdAt: -1 }, name: "shopId_provider_createdAt" },
    { collection: "tekmetric_cache", index: { createdAt: 1 }, name: "ttl_2min", options: { expireAfterSeconds: 120, background: false } },
    { collection: "dataone_cache", index: { vin: 1 }, name: "vin" },
    { collection: "carfax_cache", index: { vin: 1 }, name: "vin" },
  ];

  for (const { collection, index, name, options } of indexes) {
    try {
      const col = db.collection(collection);
      await col.createIndex(index, { name, background: true, ...options });
      console.log(`Created index "${name}" on ${collection}`);
    } catch (err: unknown) {
      const error = err as { code?: number; codeName?: string; message?: string };
      if (error.code === 85 || error.codeName === "IndexOptionsConflict") {
        console.log(`Index "${name}" already exists on ${collection} (skipped)`);
      } else {
        console.error(`Failed to create index "${name}" on ${collection}:`, error.message);
      }
    }
  }

  console.log("\nDone adding indexes.");
  process.exit(0);
}

addIndexes().catch(console.error);
