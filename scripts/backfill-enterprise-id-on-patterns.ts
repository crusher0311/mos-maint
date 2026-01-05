import { MongoClient } from 'mongodb';

function getMongoUri(): string {
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  if (username && password) {
    const encodedPassword = encodeURIComponent(password);
    return `mongodb+srv://${username}:${encodedPassword}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  }
  throw new Error("Missing MongoDB credentials");
}

async function main() {
  console.log('=== BACKFILLING ENTERPRISE ID ON REPAIR PATTERNS ===\n');
  
  const client = new MongoClient(getMongoUri());
  await client.connect();
  const db = client.db('mos-maintenance-mvp');
  
  // Get all shops with enterpriseId
  const shopsWithEnterprise = await db.collection('shops')
    .find({ enterpriseId: { $exists: true, $ne: null } })
    .toArray();
  
  console.log(`Found ${shopsWithEnterprise.length} shops with enterpriseId\n`);
  
  // Create shopId -> enterpriseId mapping
  const shopEnterpriseMap = new Map<number, string>();
  for (const shop of shopsWithEnterprise) {
    const shopId = Number(shop.shopId);
    shopEnterpriseMap.set(shopId, shop.enterpriseId);
    console.log(`  Shop ${shopId}: enterpriseId = ${shop.enterpriseId}`);
  }
  
  console.log('\nUpdating patterns...\n');
  
  let totalUpdated = 0;
  let totalSkipped = 0;
  
  // Update patterns for each shop
  for (const [shopId, enterpriseId] of shopEnterpriseMap) {
    const result = await db.collection('shop_repair_patterns').updateMany(
      { 
        shopId,
        $or: [
          { enterpriseId: { $exists: false } },
          { enterpriseId: null }
        ]
      },
      { $set: { enterpriseId } }
    );
    
    if (result.modifiedCount > 0) {
      console.log(`  Shop ${shopId}: Updated ${result.modifiedCount} patterns with enterpriseId ${enterpriseId}`);
      totalUpdated += result.modifiedCount;
    } else {
      totalSkipped++;
    }
  }
  
  console.log(`\n=== MIGRATION COMPLETE ===`);
  console.log(`Total patterns updated: ${totalUpdated}`);
  console.log(`Shops with no patterns to update: ${totalSkipped}`);
  
  // Verify the fix
  console.log('\n=== VERIFICATION ===\n');
  
  const withEnterprise = await db.collection('shop_repair_patterns').countDocuments({ enterpriseId: { $exists: true, $ne: null } });
  const withoutEnterprise = await db.collection('shop_repair_patterns').countDocuments({ $or: [{ enterpriseId: { $exists: false } }, { enterpriseId: null }] });
  
  console.log(`Patterns WITH enterpriseId: ${withEnterprise.toLocaleString()}`);
  console.log(`Patterns WITHOUT enterpriseId: ${withoutEnterprise.toLocaleString()}`);
  
  // Sample check
  const sample = await db.collection('shop_repair_patterns').findOne({ shopId: 29 });
  if (sample) {
    console.log(`\nSample (Shop 29): enterpriseId = ${sample.enterpriseId}`);
  }
  
  await client.close();
}

main().catch(console.error);
