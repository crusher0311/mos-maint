import { getDb } from "../lib/mongo";
import sql from "../lib/db/postgres";

async function syncUsers() {
  console.log("Syncing users from MongoDB to PostgreSQL...\n");
  
  const db = await getDb();
  
  const mongoUsers = await db.collection("users").find({}).toArray();
  console.log(`Found ${mongoUsers.length} user records in MongoDB\n`);
  
  const shopIdToUuid = new Map<string, string>();
  const shops = await sql`SELECT id, shop_id FROM shops WHERE shop_id IS NOT NULL`;
  for (const shop of shops) {
    shopIdToUuid.set(shop.shop_id, shop.id);
  }
  console.log(`Loaded ${shops.length} shop mappings\n`);
  
  let usersCreated = 0;
  let usersUpdated = 0;
  let shopUsersCreated = 0;
  let skipped = 0;
  
  for (const mongoUser of mongoUsers) {
    const email = mongoUser.email?.toLowerCase();
    if (!email) {
      console.log(`Skipping user without email: ${mongoUser._id}`);
      skipped++;
      continue;
    }
    
    const shopId = mongoUser.shopId?.toString();
    const shopUuid = shopId ? shopIdToUuid.get(shopId) : null;
    
    if (!shopUuid) {
      console.log(`Skipping user ${email}: no shop UUID for shopId ${shopId}`);
      skipped++;
      continue;
    }
    
    const role = mongoUser.role || 'user';
    const name = mongoUser.name || mongoUser.firstName || email.split('@')[0];
    const passwordHash = mongoUser.passwordHash || mongoUser.password || null;
    
    const existingUser = await sql`SELECT id, shop_id FROM users WHERE email = ${email} LIMIT 1`;
    
    let userId: string;
    
    if (existingUser.length > 0) {
      userId = existingUser[0].id;
      console.log(`User ${email} exists with ID ${userId}`);
      usersUpdated++;
    } else {
      const inserted = await sql`
        INSERT INTO users (email, name, password_hash, role, shop_id, is_active, created_at, updated_at)
        VALUES (${email}, ${name}, ${passwordHash}, ${role}, ${shopUuid}, true, ${mongoUser.createdAt || new Date()}, NOW())
        RETURNING id
      `;
      userId = inserted[0].id;
      console.log(`Created user ${email} with ID ${userId}`);
      usersCreated++;
    }
    
    const existingShopUser = await sql`
      SELECT id FROM shop_users 
      WHERE user_id = ${userId}::uuid AND shop_id = ${shopUuid}::uuid
      LIMIT 1
    `;
    
    if (existingShopUser.length === 0) {
      await sql`
        INSERT INTO shop_users (shop_id, user_id, role, created_at)
        VALUES (${shopUuid}::uuid, ${userId}::uuid, ${role}, NOW())
      `;
      console.log(`  -> Added shop_user link: ${email} -> shop ${shopId} (${role})`);
      shopUsersCreated++;
    } else {
      console.log(`  -> Shop_user link already exists: ${email} -> shop ${shopId}`);
    }
  }
  
  console.log(`\nSync complete:`);
  console.log(`  Users created: ${usersCreated}`);
  console.log(`  Users updated: ${usersUpdated}`);
  console.log(`  Shop-user links created: ${shopUsersCreated}`);
  console.log(`  Skipped: ${skipped}`);
  
  process.exit(0);
}

syncUsers().catch(err => {
  console.error("Sync failed:", err);
  process.exit(1);
});
