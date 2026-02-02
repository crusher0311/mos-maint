import { getDb } from "../lib/mongo";
import sql from "../lib/db/postgres";

async function syncShopConfigs() {
  console.log("Syncing shop configurations from MongoDB to PostgreSQL...\n");
  
  const db = await getDb();
  
  // Step 1: Migrate enterprises and create a mapping
  console.log("Step 1: Migrating enterprises...");
  const mongoEnterprises = await db.collection("enterprise_accounts").find({}).toArray();
  const enterpriseIdMap = new Map<string, string>(); // MongoDB ObjectID -> PostgreSQL UUID
  
  for (const ent of mongoEnterprises) {
    const mongoId = ent._id.toString();
    const existingEnt = await sql`SELECT id FROM enterprises WHERE name = ${ent.name} LIMIT 1`;
    
    if (existingEnt.length > 0) {
      enterpriseIdMap.set(mongoId, existingEnt[0].id);
      console.log(`  Enterprise ${ent.name}: using existing UUID ${existingEnt[0].id}`);
    } else {
      const slug = ent.slug || ent.name?.toLowerCase().replace(/[^a-z0-9]/g, '-') || mongoId;
      const inserted = await sql`
        INSERT INTO enterprises (name, slug, settings, is_active, created_at, updated_at)
        VALUES (${ent.name}, ${slug}, ${JSON.stringify(ent.settings || {})}::jsonb, ${ent.isActive !== false}, ${ent.createdAt || new Date()}, NOW())
        RETURNING id
      `;
      enterpriseIdMap.set(mongoId, inserted[0].id);
      console.log(`  Enterprise ${ent.name}: created with UUID ${inserted[0].id}`);
    }
  }
  console.log(`Migrated ${mongoEnterprises.length} enterprises\n`);
  
  // Step 2: Sync shop configs
  console.log("Step 2: Syncing shop configurations...");
  const mongoShops = await db.collection("shops").find({}).toArray();
  console.log(`Found ${mongoShops.length} shops in MongoDB`);
  
  let updated = 0;
  let skipped = 0;
  
  for (const shop of mongoShops) {
    const shopId = shop.shopId?.toString();
    if (!shopId) {
      console.log(`Skipping shop without shopId: ${shop._id}`);
      skipped++;
      continue;
    }
    
    const tekmetricConfig = shop.tekmetric || null;
    const protractorConfig = shop.protractor || null;
    const autoflowConfig = shop.autoflow || null;
    const carfaxConfig = shop.carfax || null;
    const autovitalsConfig = shop.autovitals || null;
    const mongoEnterpriseId = shop.enterpriseId?.toString() || null;
    const pgEnterpriseId = mongoEnterpriseId ? enterpriseIdMap.get(mongoEnterpriseId) || null : null;
    const locationIdentifier = shop.locationIdentifier || shop.location_identifier || null;
    const settings = shop.settings || null;
    const billing = shop.billing || null;
    const stickerConfig = shop.stickerConfig || shop.sticker_config || null;
    const branding = shop.branding || null;
    const preferences = shop.preferences || null;
    const maintenance = shop.maintenance || null;
    
    console.log(`Updating shop ${shopId} (${shop.name}):`);
    console.log(`  - Enterprise: ${pgEnterpriseId || 'none'} (from ${mongoEnterpriseId || 'none'})`);
    console.log(`  - Location: ${locationIdentifier || 'none'}`);
    console.log(`  - Tekmetric: ${tekmetricConfig?.shopId ? 'configured' : 'none'}`);
    console.log(`  - Protractor: ${protractorConfig?.configured ? 'configured' : 'none'}`);
    console.log(`  - AutoFlow: ${autoflowConfig?.configured ? 'configured' : 'none'}`);
    console.log(`  - Branding: ${branding ? 'yes' : 'none'}`);
    console.log(`  - Settings: ${settings ? 'yes' : 'none'}`);
    
    try {
      await sql`
        UPDATE shops SET
          tekmetric = ${tekmetricConfig ? sql.json(tekmetricConfig) : sql`tekmetric`},
          protractor = ${protractorConfig ? sql.json(protractorConfig) : sql`protractor`},
          autoflow = ${autoflowConfig ? sql.json(autoflowConfig) : sql`autoflow`},
          carfax = ${carfaxConfig ? sql.json(carfaxConfig) : sql`carfax`},
          autovitals = ${autovitalsConfig ? sql.json(autovitalsConfig) : sql`autovitals`},
          enterprise_id = ${pgEnterpriseId ? sql`${pgEnterpriseId}::uuid` : sql`enterprise_id`},
          location_identifier = ${locationIdentifier || sql`location_identifier`},
          settings = ${settings ? sql.json(settings) : sql`settings`},
          billing = ${billing ? sql.json(billing) : sql`billing`},
          sticker_config = ${stickerConfig ? sql.json(stickerConfig) : sql`sticker_config`},
          branding = ${branding ? sql.json(branding) : sql`branding`},
          preferences = ${preferences ? sql.json(preferences) : sql`preferences`},
          maintenance = ${maintenance ? sql.json(maintenance) : sql`maintenance`},
          updated_at = NOW()
        WHERE shop_id = ${shopId}
      `;
      updated++;
    } catch (err) {
      console.error(`Error updating shop ${shopId}:`, err);
    }
  }
  
  console.log(`\nSync complete: ${updated} updated, ${skipped} skipped`);
  process.exit(0);
}

syncShopConfigs().catch(err => {
  console.error("Sync failed:", err);
  process.exit(1);
});
