import { getDb, getMongoClient } from "../lib/mongo";

async function main() {
  const db = await getDb();
  
  const smsShopId = "14245";
  
  const users = await db.collection("users").find({
    email: { $regex: /brandon@heartautocare/i }
  }).project({ _id: 0, email: 1, shopId: 1, shopIds: 1, role: 1 }).toArray();
  
  console.log("\n=== Users matching brandon@heartautocare ===");
  for (const u of users) {
    console.log(`  email: ${u.email}, shopId: ${u.shopId}, shopIds: ${JSON.stringify(u.shopIds)}, role: ${u.role}`);
  }
  
  const tekShopIdNum = parseInt(smsShopId);
  const shopsWithTekId = await db.collection("shops").find({
    $or: [
      { "tekmetric.shopId": tekShopIdNum },
      { "tekmetric.shopId": smsShopId },
      { tekmetricShopId: tekShopIdNum },
      { tekmetricShopId: smsShopId },
    ]
  }).project({ _id: 0, shopId: 1, name: 1, "tekmetric.shopId": 1, tekmetricShopId: 1 }).toArray();
  
  console.log(`\n=== Shops with Tekmetric ID ${smsShopId} ===`);
  for (const s of shopsWithTekId) {
    console.log(`  MOS shopId: ${s.shopId}, name: ${s.name}, tekmetric.shopId: ${s.tekmetric?.shopId}, tekmetricShopId: ${s.tekmetricShopId}`);
  }
  
  if (users.length > 0) {
    const userShopIds = users.flatMap(u => {
      const ids = [u.shopId];
      if (u.shopIds) ids.push(...u.shopIds);
      return ids;
    }).map(Number);
    
    console.log(`\n=== User's shop IDs: [${userShopIds.join(', ')}] ===`);
    
    const userShops = await db.collection("shops").find({
      shopId: { $in: userShopIds }
    }).project({ _id: 0, shopId: 1, name: 1, "tekmetric.shopId": 1, tekmetricShopId: 1, integrationProvider: 1 }).toArray();
    
    console.log("\n=== User's shops and their Tekmetric config ===");
    for (const s of userShops) {
      console.log(`  MOS shopId: ${s.shopId}, name: ${s.name}, tekmetric.shopId: ${s.tekmetric?.shopId}, tekmetricShopId: ${s.tekmetricShopId}, provider: ${s.integrationProvider}`);
    }
  }

  const bcrusha = await db.collection("users").find({
    email: { $regex: /bcrusha@carexpertsok/i }
  }).project({ _id: 0, email: 1, shopId: 1, shopIds: 1, role: 1 }).toArray();
  
  console.log("\n=== Users matching bcrusha@carexpertsok ===");
  for (const u of bcrusha) {
    console.log(`  email: ${u.email}, shopId: ${u.shopId}, shopIds: ${JSON.stringify(u.shopIds)}, role: ${u.role}`);
  }

  const client = await getMongoClient();
  await client.close();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
