// scripts/migrate-shopid-to-numbers.ts
/**
 * Migration script to standardize all shopId fields to numbers
 * Run this after setting up your environment variables
 */

import type { IndexDescription } from "mongodb";
import { getDb } from "../lib/mongo";

async function migrateCollection(collectionName: string) {
  console.log(`🔄 Migrating ${collectionName}...`);
  
  const db = await getDb();
  const collection = db.collection(collectionName);
  
  // Find documents with string shopId
  const stringShopIds = await collection.find({
    shopId: { $type: "string" }
  }).toArray();
  
  console.log(`  Found ${stringShopIds.length} documents with string shopId`);
  
  let updated = 0;
  for (const doc of stringShopIds) {
    const numericShopId = parseInt(doc.shopId as string, 10);
    
    if (isNaN(numericShopId)) {
      console.warn(`  ⚠️  Skipping invalid shopId: ${doc.shopId} in document ${doc._id}`);
      continue;
    }
    
    await collection.updateOne(
      { _id: doc._id },
      { $set: { shopId: numericShopId } }
    );
    updated++;
  }
  
  console.log(`  ✅ Updated ${updated} documents in ${collectionName}`);
}

async function createIndexes() {
  console.log("🔄 Creating database indexes...");
  
  const db = await getDb();
  
  // Core collections indexes
  const collections: Array<{ name: string; indexes: IndexDescription[] }> = [
    {
      name: "users",
      indexes: [
        { key: { email: 1 }, name: "email_1", unique: true },
        { key: { shopId: 1, email: 1 }, name: "shopId_email_1" },
      ]
    },
    {
      name: "sessions", 
      indexes: [
        { key: { token: 1 }, name: "token_1", unique: true },
        { key: { expiresAt: 1 }, name: "expiresAt_1", expireAfterSeconds: 0 },
        { key: { userId: 1 }, name: "userId_1" },
      ]
    },
    {
      name: "shops",
      indexes: [
        { key: { shopId: 1 }, name: "shopId_1", unique: true },
        { key: { name: 1 }, name: "name_1" },
      ]
    },
    {
      name: "customers",
      indexes: [
        { key: { shopId: 1 }, name: "shopId_1" },
        { key: { shopId: 1, "vehicle.vin": 1 }, name: "shopId_vin_1" },
        { key: { shopId: 1, status: 1 }, name: "shopId_status_1" },
        { key: { shopId: 1, updatedAt: -1 }, name: "shopId_updated_1" },
      ]
    },
    {
      name: "vehicles",
      indexes: [
        { key: { vin: 1 }, name: "vin_1", unique: true },
        { key: { shopId: 1 }, name: "shopId_1" },
        { key: { shopId: 1, vin: 1 }, name: "shopId_vin_1" },
        { key: { customerId: 1 }, name: "customerId_1" },
      ]
    },
    {
      name: "repair_orders",
      indexes: [
        { key: { shopId: 1 }, name: "shopId_1" },
        { key: { shopId: 1, roNumber: 1 }, name: "shopId_roNumber_1" },
        { key: { shopId: 1, vin: 1 }, name: "shopId_vin_1" },
        { key: { vehicleId: 1 }, name: "vehicleId_1" },
        { key: { customerId: 1 }, name: "customerId_1" },
      ]
    },
    {
      name: "events",
      indexes: [
        { key: { shopId: 1 }, name: "shopId_1" },
        { key: { shopId: 1, receivedAt: -1 }, name: "shopId_received_1" },
        { key: { "payload.vin": 1 }, name: "payload_vin_1" },
      ]
    }
  ];
  
  for (const { name, indexes } of collections) {
    console.log(`  Creating indexes for ${name}...`);
    try {
      await db.collection(name).createIndexes(indexes);
      console.log(`  ✅ Created indexes for ${name}`);
    } catch (error) {
      console.log(`  ⚠️  Some indexes may already exist for ${name}: ${error}`);
    }
  }
}

async function main() {
  console.log("🚀 Starting database migration...");
  
  try {
    // Collections that might have shopId fields
    const collectionsToMigrate = [
      "users",
      "shops", 
      "customers",
      "vehicles",
      "repair_orders",
      "events",
      "sessions"
    ];
    
    for (const collection of collectionsToMigrate) {
      await migrateCollection(collection);
    }
    
    await createIndexes();
    
    console.log("✅ Migration completed successfully!");
    
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

// Run migration if called directly
if (require.main === module) {
  main().then(() => process.exit(0));
}

export { main as migrateDatabaseSchema };