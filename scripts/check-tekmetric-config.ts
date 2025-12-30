import { getDb } from "../lib/mongo";

async function main() {
  const db = await getDb();
  
  console.log("\n=== Shops with Tekmetric configured ===");
  const tekmetricShops = await db.collection('shops').find({
    "tekmetric.shopId": { $exists: true }
  }).toArray();
  
  for (const shop of tekmetricShops) {
    console.log(`Shop ${shop.shopId}: ${shop.name || 'unnamed'} -> Tekmetric ID: ${shop.tekmetric?.shopId}`);
  }
  
  console.log("\n=== Shop 28 details ===");
  const shop28 = await db.collection('shops').findOne({
    shopId: { $in: [28, "28"] }
  });
  
  if (shop28) {
    console.log("Shop 28:", JSON.stringify({
      shopId: shop28.shopId,
      name: shop28.name,
      tekmetric: shop28.tekmetric,
      protractor: shop28.protractor ? 'configured' : 'not configured'
    }, null, 2));
  } else {
    console.log("Shop 28 not found");
  }
  
  console.log("\n=== User bcrusha@carexpertsok.com ===");
  const userDoc = await db.collection('users').findOne({
    email: 'bcrusha@carexpertsok.com'
  });
  
  if (userDoc) {
    console.log("User:", JSON.stringify({
      email: userDoc.email,
      shopId: userDoc.shopId,
      role: userDoc.role
    }, null, 2));
  } else {
    console.log("User not found");
  }
  
  process.exit(0);
}

main().catch(console.error);
