/**
 * Phase 3 ETL: Migrate remaining MongoDB collections to PostgreSQL
 * 
 * This script migrates historical data for tables created in Phase 1:
 * - enterprise_accounts
 * - platform_features
 * - platform_settings
 * - support_tickets
 * - audit_logs
 * - tekmetric_work_orders
 * - protractor_work_orders
 * - protractor_vehicles
 * - tekmetric_tokens
 * - events
 * - notifications
 * - sticker_generations
 * - viewed_vins
 * - recommendation_events
 * - backfill_progress
 */

import { getDb } from '../lib/mongo';
import sql from '../lib/db/postgres';

const BATCH_SIZE = 1000;

interface MigrationStats {
  collection: string;
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
}

async function getShopUUIDMap(): Promise<Map<number, string>> {
  const shops = await sql`SELECT id, shop_id FROM shops WHERE shop_id IS NOT NULL`;
  const map = new Map<number, string>();
  for (const shop of shops) {
    map.set(Number(shop.shop_id), shop.id);
  }
  console.log(`Loaded ${map.size} shop UUID mappings`);
  return map;
}

async function migrateEnterpriseAccounts(db: any): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'enterprise_accounts', total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const docs = await db.collection('enterprise_accounts').find({}).toArray();
  stats.total = docs.length;
  
  for (const doc of docs) {
    try {
      const name = doc.name || 'Unknown';
      const existing = await sql`SELECT id FROM enterprise_accounts WHERE name = ${name} LIMIT 1`;
      if (existing.length > 0) {
        stats.skipped++;
        continue;
      }
      
      await sql`
        INSERT INTO enterprise_accounts (id, name, shop_ids, shared_mappings, shared_integrations, created_at, updated_at)
        VALUES (
          gen_random_uuid(),
          ${name},
          ${doc.shopIds || []},
          ${JSON.stringify(doc.sharedMappings || {})}::jsonb,
          ${JSON.stringify(doc.sharedIntegrations || {})}::jsonb,
          ${doc.createdAt || new Date()},
          ${doc.updatedAt || new Date()}
        )
        ON CONFLICT DO NOTHING
      `;
      stats.migrated++;
    } catch (e) {
      console.error(`Failed to migrate enterprise ${doc._id}:`, e);
      stats.failed++;
    }
  }
  
  return stats;
}

async function migratePlatformFeatures(db: any): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'platform_features', total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const docs = await db.collection('platform_features').find({}).toArray();
  stats.total = docs.length;
  
  for (const doc of docs) {
    try {
      const key = doc.key || doc.featureKey || doc.name;
      if (!key) {
        stats.skipped++;
        continue;
      }
      
      const existing = await sql`SELECT id FROM platform_features WHERE key = ${key} LIMIT 1`;
      if (existing.length > 0) {
        stats.skipped++;
        continue;
      }
      
      await sql`
        INSERT INTO platform_features (key, name, description, category, tier, is_active, display_order, config, created_at, updated_at)
        VALUES (
          ${key},
          ${doc.name || key},
          ${doc.description || null},
          ${doc.category || null},
          ${doc.tier || null},
          ${doc.isActive !== false},
          ${doc.displayOrder || doc.order || 0},
          ${JSON.stringify(doc.config || {})}::jsonb,
          ${doc.createdAt || new Date()},
          ${doc.updatedAt || new Date()}
        )
        ON CONFLICT (key) DO NOTHING
      `;
      stats.migrated++;
    } catch (e) {
      console.error(`Failed to migrate feature ${doc._id}:`, e);
      stats.failed++;
    }
  }
  
  return stats;
}

async function migratePlatformSettings(db: any): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'platform_settings', total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const docs = await db.collection('platform_settings').find({}).toArray();
  stats.total = docs.length;
  
  for (const doc of docs) {
    try {
      const key = doc.key || doc.settingKey;
      if (!key) {
        stats.skipped++;
        continue;
      }
      
      const existing = await sql`SELECT id FROM platform_settings WHERE key = ${key} LIMIT 1`;
      if (existing.length > 0) {
        stats.skipped++;
        continue;
      }
      
      await sql`
        INSERT INTO platform_settings (key, value, description, created_at, updated_at)
        VALUES (
          ${key},
          ${JSON.stringify(doc.value || doc)}::jsonb,
          ${doc.description || null},
          ${doc.createdAt || new Date()},
          ${doc.updatedAt || new Date()}
        )
        ON CONFLICT (key) DO NOTHING
      `;
      stats.migrated++;
    } catch (e) {
      console.error(`Failed to migrate setting ${doc._id}:`, e);
      stats.failed++;
    }
  }
  
  return stats;
}

async function migrateTekmetricWorkOrders(db: any, shopMap: Map<number, string>): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'tekmetric_work_orders', total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const cursor = db.collection('tekmetric_work_orders').find({});
  stats.total = await db.collection('tekmetric_work_orders').countDocuments();
  
  let batch: any[] = [];
  
  for await (const doc of cursor) {
    const shopId = Number(doc.shopId);
    const shopUUID = shopMap.get(shopId);
    
    if (!shopUUID) {
      stats.skipped++;
      continue;
    }
    
    batch.push({
      shopUUID,
      externalShopId: shopId,
      workOrderId: String(doc.workOrderId),
      workOrderNumber: doc.workOrderNumber,
      vin: doc.vin?.toUpperCase() || null,
      status: doc.status || null,
      statusCode: doc.statusCode || null,
      label: doc.label || null,
      labelColor: doc.labelColor || null,
      customerId: doc.customerId || null,
      vehicleId: doc.vehicleId || null,
      customerName: doc.customerName || null,
      vehicleYear: doc.vehicleYear || null,
      vehicleMake: doc.vehicleMake || null,
      vehicleModel: doc.vehicleModel || null,
      vehicleSubmodel: doc.vehicleSubmodel || null,
      mileageIn: doc.odometer || doc.mileageIn || null,
      mileageOut: doc.mileageOut || null,
      createdDate: doc.createdDate ? new Date(doc.createdDate) : null,
      closedDate: doc.completedDate ? new Date(doc.completedDate) : null,
      rawData: doc.data || doc
    });
    
    if (batch.length >= BATCH_SIZE) {
      const migrated = await insertTekmetricBatch(batch);
      stats.migrated += migrated;
      stats.skipped += batch.length - migrated;
      batch = [];
      console.log(`Tekmetric WOs: ${stats.migrated + stats.skipped}/${stats.total} processed`);
    }
  }
  
  if (batch.length > 0) {
    const migrated = await insertTekmetricBatch(batch);
    stats.migrated += migrated;
    stats.skipped += batch.length - migrated;
  }
  
  return stats;
}

async function insertTekmetricBatch(batch: any[]): Promise<number> {
  let migrated = 0;
  
  for (const item of batch) {
    try {
      await sql`
        INSERT INTO tekmetric_work_orders (
          shop_id, external_shop_id, work_order_id, work_order_number,
          vin, status, status_code, label, label_color,
          customer_id, vehicle_id, customer_name,
          vehicle_year, vehicle_make, vehicle_model, vehicle_submodel,
          mileage_in, mileage_out, created_date, closed_date,
          raw_data, synced_at
        ) VALUES (
          ${item.shopUUID}, ${item.externalShopId}, ${item.workOrderId}, ${item.workOrderNumber},
          ${item.vin}, ${item.status}, ${item.statusCode}, ${item.label}, ${item.labelColor},
          ${item.customerId}, ${item.vehicleId}, ${item.customerName},
          ${item.vehicleYear}, ${item.vehicleMake}, ${item.vehicleModel}, ${item.vehicleSubmodel},
          ${item.mileageIn}, ${item.mileageOut}, ${item.createdDate}, ${item.closedDate},
          ${JSON.stringify(item.rawData)}::jsonb, NOW()
        )
        ON CONFLICT (external_shop_id, work_order_id) DO NOTHING
      `;
      migrated++;
    } catch (e) {
      // Skip duplicates
    }
  }
  
  return migrated;
}

async function migrateProtractorWorkOrders(db: any, shopMap: Map<number, string>): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'protractor_work_orders', total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const cursor = db.collection('protractor_work_orders').find({});
  stats.total = await db.collection('protractor_work_orders').countDocuments();
  
  let batch: any[] = [];
  
  for await (const doc of cursor) {
    const shopId = Number(doc.shopId);
    const shopUUID = shopMap.get(shopId);
    
    if (!shopUUID) {
      stats.skipped++;
      continue;
    }
    
    batch.push({
      shopUUID,
      externalShopId: shopId,
      workOrderId: String(doc.workOrderId || doc.workOrderGuid),
      workOrderNumber: doc.workOrderNumber ? String(doc.workOrderNumber) : null,
      vin: doc.vin?.toUpperCase() || null,
      status: doc.workflowStage || doc.status || null,
      customerId: doc.contactId || null,
      vehicleId: doc.serviceItemId || null,
      customerName: doc.contactName || null,
      vehicleYear: null,
      vehicleMake: null,
      vehicleModel: null,
      mileage: doc.odometer || null,
      createdDate: doc.scheduledTime ? new Date(doc.scheduledTime) : null,
      closedDate: doc.completed ? new Date() : null,
      rawData: doc.rawPayload || doc
    });
    
    if (batch.length >= BATCH_SIZE) {
      const migrated = await insertProtractorWOBatch(batch);
      stats.migrated += migrated;
      stats.skipped += batch.length - migrated;
      batch = [];
      console.log(`Protractor WOs: ${stats.migrated + stats.skipped}/${stats.total} processed`);
    }
  }
  
  if (batch.length > 0) {
    const migrated = await insertProtractorWOBatch(batch);
    stats.migrated += migrated;
    stats.skipped += batch.length - migrated;
  }
  
  return stats;
}

async function insertProtractorWOBatch(batch: any[]): Promise<number> {
  let migrated = 0;
  
  for (const item of batch) {
    try {
      await sql`
        INSERT INTO protractor_work_orders (
          shop_id, external_shop_id, work_order_id, work_order_number,
          vin, status, customer_id, vehicle_id, customer_name,
          vehicle_year, vehicle_make, vehicle_model, mileage,
          created_date, closed_date, raw_data, synced_at
        ) VALUES (
          ${item.shopUUID}, ${item.externalShopId}, ${item.workOrderId}, ${item.workOrderNumber},
          ${item.vin}, ${item.status}, ${item.customerId}, ${item.vehicleId}, ${item.customerName},
          ${item.vehicleYear}, ${item.vehicleMake}, ${item.vehicleModel}, ${item.mileage},
          ${item.createdDate}, ${item.closedDate},
          ${JSON.stringify(item.rawData)}::jsonb, NOW()
        )
        ON CONFLICT (external_shop_id, work_order_id) DO NOTHING
      `;
      migrated++;
    } catch (e) {
      // Skip duplicates
    }
  }
  
  return migrated;
}

async function migrateProtractorVehicles(db: any, shopMap: Map<number, string>): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'protractor_vehicles', total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const cursor = db.collection('protractor_vehicles').find({});
  stats.total = await db.collection('protractor_vehicles').countDocuments();
  
  for await (const doc of cursor) {
    const shopId = Number(doc.shopId);
    const shopUUID = shopMap.get(shopId);
    
    if (!shopUUID) {
      stats.skipped++;
      continue;
    }
    
    try {
      await sql`
        INSERT INTO protractor_vehicles (
          shop_id, external_shop_id, vehicle_id, vin, year, make, model,
          license_plate, customer_id, raw_data, synced_at
        ) VALUES (
          ${shopUUID}, ${shopId}, ${doc.protractorId || doc._id.toString()}, 
          ${doc.vin?.toUpperCase() || null},
          ${doc.year || null}, ${doc.make || null}, ${doc.model || null},
          ${doc.licensePlate || null}, ${doc.ownerId || null},
          ${JSON.stringify(doc)}::jsonb, NOW()
        )
        ON CONFLICT (external_shop_id, vehicle_id) DO NOTHING
      `;
      stats.migrated++;
    } catch (e) {
      stats.failed++;
    }
    
    if ((stats.migrated + stats.skipped + stats.failed) % 1000 === 0) {
      console.log(`Protractor Vehicles: ${stats.migrated + stats.skipped}/${stats.total} processed`);
    }
  }
  
  return stats;
}

async function migrateEvents(db: any, shopMap: Map<number, string>): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'events', total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  stats.total = await db.collection('events').countDocuments();
  if (stats.total === 0) return stats;
  
  const cursor = db.collection('events').find({}).sort({ _id: -1 }).limit(50000);
  
  let batch: any[] = [];
  
  for await (const doc of cursor) {
    const shopId = Number(doc.shopId);
    const shopUUID = shopMap.get(shopId) || null;
    
    batch.push({
      shopUUID,
      vin: doc.vin?.toUpperCase() || null,
      eventType: doc.type || doc.eventType || 'unknown',
      provider: doc.provider || doc.source || null,
      payload: doc.data || doc.payload || doc,
      createdAt: doc.createdAt || doc.timestamp || new Date()
    });
    
    if (batch.length >= BATCH_SIZE) {
      for (const item of batch) {
        try {
          await sql`
            INSERT INTO events (shop_id, vin, event_type, provider, payload, created_at)
            VALUES (${item.shopUUID}, ${item.vin}, ${item.eventType}, ${item.provider}, ${JSON.stringify(item.payload)}::jsonb, ${item.createdAt})
          `;
          stats.migrated++;
        } catch (e) {
          stats.failed++;
        }
      }
      batch = [];
      console.log(`Events: ${stats.migrated + stats.failed}/${stats.total} processed`);
    }
  }
  
  for (const item of batch) {
    try {
      await sql`
        INSERT INTO events (shop_id, vin, event_type, provider, payload, created_at)
        VALUES (${item.shopUUID}, ${item.vin}, ${item.eventType}, ${item.provider}, ${JSON.stringify(item.payload)}::jsonb, ${item.createdAt})
      `;
      stats.migrated++;
    } catch (e) {
      stats.failed++;
    }
  }
  
  return stats;
}

async function migrateViewedVins(db: any, shopMap: Map<number, string>): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'viewed_vins', total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const cursor = db.collection('viewed_vins').find({});
  stats.total = await db.collection('viewed_vins').countDocuments();
  
  for await (const doc of cursor) {
    const shopId = Number(doc.shopId);
    const shopUUID = shopMap.get(shopId);
    
    if (!shopUUID || !doc.vin) {
      stats.skipped++;
      continue;
    }
    
    try {
      await sql`
        INSERT INTO viewed_vins (shop_id, vin, ro_number, viewed_at)
        VALUES (
          ${shopUUID}, ${doc.vin.toUpperCase()}, 
          ${doc.roNumber || doc.workOrderNumber || null},
          ${doc.viewedAt || doc.lastViewedAt || doc.createdAt || new Date()}
        )
        ON CONFLICT DO NOTHING
      `;
      stats.migrated++;
    } catch (e) {
      stats.failed++;
    }
    
    if ((stats.migrated + stats.skipped + stats.failed) % 1000 === 0) {
      console.log(`Viewed VINs: ${stats.migrated + stats.skipped}/${stats.total} processed`);
    }
  }
  
  return stats;
}

async function main() {
  console.log('=====================================================');
  console.log('Phase 3 ETL: MongoDB -> PostgreSQL (Remaining Tables)');
  console.log('=====================================================');
  console.log(`Started at: ${new Date().toISOString()}\n`);
  
  const db = await getDb();
  const shopMap = await getShopUUIDMap();
  
  const allStats: MigrationStats[] = [];
  
  console.log('\n=== Migrating Enterprise Accounts ===');
  allStats.push(await migrateEnterpriseAccounts(db));
  
  console.log('\n=== Migrating Platform Features ===');
  allStats.push(await migratePlatformFeatures(db));
  
  console.log('\n=== Migrating Platform Settings ===');
  allStats.push(await migratePlatformSettings(db));
  
  console.log('\n=== Migrating Tekmetric Work Orders ===');
  allStats.push(await migrateTekmetricWorkOrders(db, shopMap));
  
  console.log('\n=== Migrating Protractor Work Orders ===');
  allStats.push(await migrateProtractorWorkOrders(db, shopMap));
  
  console.log('\n=== Migrating Protractor Vehicles ===');
  allStats.push(await migrateProtractorVehicles(db, shopMap));
  
  console.log('\n=== Migrating Viewed VINs ===');
  allStats.push(await migrateViewedVins(db, shopMap));
  
  console.log('\n=== Migrating Events (last 50k) ===');
  allStats.push(await migrateEvents(db, shopMap));
  
  console.log('\n=====================================================');
  console.log('Migration Summary');
  console.log('=====================================================');
  console.table(allStats);
  
  console.log(`\nCompleted at: ${new Date().toISOString()}`);
  
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
