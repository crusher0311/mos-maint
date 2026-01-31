/**
 * ETL Script: MongoDB Normalized Collections -> PostgreSQL Tables
 * Uses batch inserts for performance (1000 records at a time)
 */

import { getDb } from "../lib/mongo";
import sql from "../lib/db/postgres";
import { NORMALIZED_COLLECTIONS } from "../lib/normalized-schema";

const BATCH_SIZE = 1000;

interface MigrationStats {
  collection: string;
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
}

const stats: MigrationStats[] = [];

async function getShopUuidMap(): Promise<Map<number, string>> {
  const shops = await sql`SELECT id, shop_id FROM shops`;
  const map = new Map<number, string>();
  for (const shop of shops) {
    map.set(Number(shop.shop_id), shop.id as string);
  }
  return map;
}

async function migrateShops(db: any) {
  console.log("\n=== Migrating Shops ===");
  const collectionStats: MigrationStats = { collection: "shops", total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const mongoShops = await db.collection("shops").find({}).toArray();
  collectionStats.total = mongoShops.length;
  
  const existingShopIds = await sql`SELECT shop_id FROM shops`;
  const existingIds = new Set(existingShopIds.map((s: any) => s.shop_id));
  
  for (const shop of mongoShops) {
    const shopId = String(shop.shopId || shop._id);
    
    if (existingIds.has(shopId)) {
      collectionStats.skipped++;
      continue;
    }
    
    try {
      await sql`
        INSERT INTO shops (
          id, shop_id, name, slug, owner_id, settings, billing, is_active,
          enterprise_id, tekmetric, protractor, autoflow, carfax, autovitals,
          sticker_config, branding, location_identifier, webhook_token,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(),
          ${shopId},
          ${shop.name || ""},
          ${shop.slug || shopId},
          ${null},
          ${JSON.stringify(shop.settings || {})}::jsonb,
          ${JSON.stringify({
            plan: shop.billingPlan || "trial",
            status: shop.subscriptionStatus || "trial",
            stripeCustomerId: shop.stripeCustomerId,
            stripeSubscriptionId: shop.stripeSubscriptionId,
            vinLimit: shop.vinLimit || 50,
            vinViewCount: shop.vinViewCount || 0,
            trialEndsAt: shop.trialEndsAt,
            gracePeriodEndsAt: shop.gracePeriodEndsAt,
          })}::jsonb,
          ${shop.isActive !== false},
          ${null},
          ${JSON.stringify(shop.tekmetricConfig || shop.tekmetric || null)}::jsonb,
          ${JSON.stringify(shop.protractorConfig || shop.protractor || null)}::jsonb,
          ${JSON.stringify(shop.autoflowConfig || shop.autoflow || null)}::jsonb,
          ${JSON.stringify(shop.carfaxConfig || shop.carfax || null)}::jsonb,
          ${JSON.stringify(shop.autovitalsConfig || shop.autovitals || null)}::jsonb,
          ${JSON.stringify(shop.stickerConfig || shop.sticker_config || null)}::jsonb,
          ${JSON.stringify(shop.branding || null)}::jsonb,
          ${shop.locationIdentifier || null},
          ${shop.webhookToken || null},
          ${shop.createdAt ? new Date(shop.createdAt) : new Date()},
          ${shop.updatedAt ? new Date(shop.updatedAt) : new Date()}
        )
      `;
      collectionStats.migrated++;
    } catch (error: any) {
      console.error(`Failed to migrate shop ${shop.name}:`, error.message);
      collectionStats.failed++;
    }
  }
  
  console.log(`Shops: ${collectionStats.migrated} migrated, ${collectionStats.skipped} skipped, ${collectionStats.failed} failed`);
  stats.push(collectionStats);
}

async function migrateCustomers(db: any, shopUuidMap: Map<number, string>) {
  console.log("\n=== Migrating Customers ===");
  const collectionStats: MigrationStats = { collection: "customers", total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const totalCount = await db.collection(NORMALIZED_COLLECTIONS.customers).countDocuments();
  collectionStats.total = totalCount;
  console.log(`Total customers to process: ${totalCount}`);
  
  const existingExternalIds = await sql`SELECT external_id FROM customers WHERE external_id IS NOT NULL`;
  const existingIds = new Set(existingExternalIds.map((c: any) => c.external_id));
  console.log(`Existing customers in PostgreSQL: ${existingIds.size}`);
  
  let processed = 0;
  const cursor = db.collection(NORMALIZED_COLLECTIONS.customers).find({}).batchSize(BATCH_SIZE);
  let batch: any[] = [];
  
  while (await cursor.hasNext()) {
    const customer = await cursor.next();
    processed++;
    
    const shopUuid = shopUuidMap.get(customer.shopId);
    if (!shopUuid) {
      collectionStats.skipped++;
      continue;
    }
    
    if (existingIds.has(customer._id)) {
      collectionStats.skipped++;
      continue;
    }
    
    const primaryContact = customer.contacts?.find((c: any) => c.isPrimary) || customer.contacts?.[0];
    
    batch.push({
      shop_id: shopUuid,
      external_id: customer._id,
      first_name: customer.firstName || primaryContact?.firstName || "",
      last_name: customer.lastName || primaryContact?.lastName || "",
      email: primaryContact?.email || null,
      phone: primaryContact?.phone || null,
      address: customer.billingAddress || customer.mailingAddress || null,
      notes: customer.notes || null,
      source_system: customer.provenance?.sourceSystem || "unknown",
      source_id: customer.provenance?.sourceIds?.[0]?.idValue || null,
      is_deleted: customer.softDelete?.isDeleted || false,
      metadata: {
        companyName: customer.companyName,
        customerType: customer.customerType,
        contacts: customer.contacts,
        totalVisits: customer.totalVisits,
        totalSpent: customer.totalSpent,
        tags: customer.tags,
      },
      created_at: customer.createdAt ? new Date(customer.createdAt) : new Date(),
      updated_at: customer.updatedAt ? new Date(customer.updatedAt) : new Date(),
    });
    
    if (batch.length >= BATCH_SIZE) {
      try {
        await insertCustomerBatch(batch);
        collectionStats.migrated += batch.length;
      } catch (error: any) {
        console.error(`Batch insert failed:`, error.message);
        collectionStats.failed += batch.length;
      }
      batch = [];
      console.log(`Customers: ${processed}/${totalCount} processed (${collectionStats.migrated} migrated)`);
    }
  }
  
  if (batch.length > 0) {
    try {
      await insertCustomerBatch(batch);
      collectionStats.migrated += batch.length;
    } catch (error: any) {
      console.error(`Final batch insert failed:`, error.message);
      collectionStats.failed += batch.length;
    }
  }
  
  console.log(`Customers: ${collectionStats.migrated} migrated, ${collectionStats.skipped} skipped, ${collectionStats.failed} failed`);
  stats.push(collectionStats);
}

async function insertCustomerBatch(batch: any[]) {
  const values = batch.map(c => `(
    gen_random_uuid(),
    '${c.shop_id}'::uuid,
    '${c.external_id.replace(/'/g, "''")}',
    '${(c.first_name || "").replace(/'/g, "''")}',
    '${(c.last_name || "").replace(/'/g, "''")}',
    ${c.email ? `'${c.email.replace(/'/g, "''")}'` : 'NULL'},
    ${c.phone ? `'${c.phone.replace(/'/g, "''")}'` : 'NULL'},
    ${c.address ? `'${JSON.stringify(c.address).replace(/'/g, "''")}'::jsonb` : 'NULL'},
    ${c.notes ? `'${c.notes.replace(/'/g, "''")}'` : 'NULL'},
    '${c.source_system}',
    ${c.source_id ? `'${c.source_id.replace(/'/g, "''")}'` : 'NULL'},
    ${c.is_deleted},
    '${JSON.stringify(c.metadata).replace(/'/g, "''")}'::jsonb,
    '${c.created_at.toISOString()}',
    '${c.updated_at.toISOString()}'
  )`).join(',\n');
  
  await sql.unsafe(`
    INSERT INTO customers (id, shop_id, external_id, first_name, last_name, email, phone, address, notes, source_system, source_id, is_deleted, metadata, created_at, updated_at)
    VALUES ${values}
    ON CONFLICT (shop_id, external_id) DO NOTHING
  `);
}

async function migrateVehicles(db: any, shopUuidMap: Map<number, string>) {
  console.log("\n=== Migrating Vehicles ===");
  const collectionStats: MigrationStats = { collection: "vehicles", total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const totalCount = await db.collection(NORMALIZED_COLLECTIONS.vehicles).countDocuments();
  collectionStats.total = totalCount;
  console.log(`Total vehicles to process: ${totalCount}`);
  
  const existingVins = await sql`SELECT vin, shop_id FROM vehicles WHERE vin IS NOT NULL`;
  const existingVinSet = new Set(existingVins.map((v: any) => `${v.shop_id}:${v.vin}`));
  console.log(`Existing vehicles in PostgreSQL: ${existingVinSet.size}`);
  
  const customerMap = new Map<string, string>();
  const pgCustomers = await sql`SELECT id, external_id FROM customers WHERE external_id IS NOT NULL`;
  for (const c of pgCustomers) {
    customerMap.set(c.external_id as string, c.id as string);
  }
  
  let processed = 0;
  const cursor = db.collection(NORMALIZED_COLLECTIONS.vehicles).find({}).batchSize(BATCH_SIZE);
  let batch: any[] = [];
  
  while (await cursor.hasNext()) {
    const vehicle = await cursor.next();
    processed++;
    
    const shopUuid = shopUuidMap.get(vehicle.shopId);
    if (!shopUuid) {
      collectionStats.skipped++;
      continue;
    }
    
    if (vehicle.vin && existingVinSet.has(`${shopUuid}:${vehicle.vin}`)) {
      collectionStats.skipped++;
      continue;
    }
    
    const customerUuid = vehicle.customerId ? customerMap.get(vehicle.customerId) : null;
    
    batch.push({
      shop_id: shopUuid,
      customer_id: customerUuid,
      vin: vehicle.vin || null,
      year: vehicle.year || null,
      make: vehicle.make || null,
      model: vehicle.model || null,
      trim: vehicle.trim || null,
      body_style: vehicle.bodyStyle || null,
      engine: vehicle.engineDescription || null,
      transmission: vehicle.transmission || null,
      fuel_type: vehicle.fuelType || null,
      drive_type: vehicle.drivetrain || null,
      exterior_color: vehicle.exteriorColor || null,
      license_plate: vehicle.licensePlate || null,
      license_plate_state: vehicle.licensePlateState || null,
      current_mileage: vehicle.currentOdometer || null,
      last_service_date: vehicle.lastServiceDate ? new Date(vehicle.lastServiceDate) : null,
      source_system: vehicle.provenance?.sourceSystem || "unknown",
      source_id: vehicle.provenance?.sourceIds?.[0]?.idValue || vehicle._id,
      is_deleted: vehicle.softDelete?.isDeleted || false,
      raw_data: vehicle.vinDecodeData || null,
      metadata: { tags: vehicle.tags, isFleet: vehicle.isFleet, fleetId: vehicle.fleetId },
      created_at: vehicle.createdAt ? new Date(vehicle.createdAt) : new Date(),
      updated_at: vehicle.updatedAt ? new Date(vehicle.updatedAt) : new Date(),
    });
    
    if (batch.length >= BATCH_SIZE) {
      try {
        await insertVehicleBatch(batch);
        collectionStats.migrated += batch.length;
      } catch (error: any) {
        console.error(`Batch insert failed:`, error.message);
        collectionStats.failed += batch.length;
      }
      batch = [];
      console.log(`Vehicles: ${processed}/${totalCount} processed (${collectionStats.migrated} migrated)`);
    }
  }
  
  if (batch.length > 0) {
    try {
      await insertVehicleBatch(batch);
      collectionStats.migrated += batch.length;
    } catch (error: any) {
      console.error(`Final batch insert failed:`, error.message);
      collectionStats.failed += batch.length;
    }
  }
  
  console.log(`Vehicles: ${collectionStats.migrated} migrated, ${collectionStats.skipped} skipped, ${collectionStats.failed} failed`);
  stats.push(collectionStats);
}

async function insertVehicleBatch(batch: any[]) {
  const values = batch.map(v => `(
    gen_random_uuid(),
    '${v.shop_id}'::uuid,
    ${v.customer_id ? `'${v.customer_id}'::uuid` : 'NULL'},
    ${v.vin ? `'${v.vin.replace(/'/g, "''")}'` : 'NULL'},
    ${v.year || 'NULL'},
    ${v.make ? `'${v.make.replace(/'/g, "''")}'` : 'NULL'},
    ${v.model ? `'${v.model.replace(/'/g, "''")}'` : 'NULL'},
    ${v.trim ? `'${v.trim.replace(/'/g, "''")}'` : 'NULL'},
    ${v.body_style ? `'${v.body_style.replace(/'/g, "''")}'` : 'NULL'},
    ${v.engine ? `'${v.engine.replace(/'/g, "''")}'` : 'NULL'},
    ${v.transmission ? `'${v.transmission.replace(/'/g, "''")}'` : 'NULL'},
    ${v.fuel_type ? `'${v.fuel_type.replace(/'/g, "''")}'` : 'NULL'},
    ${v.drive_type ? `'${v.drive_type.replace(/'/g, "''")}'` : 'NULL'},
    ${v.exterior_color ? `'${v.exterior_color.replace(/'/g, "''")}'` : 'NULL'},
    ${v.license_plate ? `'${v.license_plate.replace(/'/g, "''")}'` : 'NULL'},
    ${v.license_plate_state ? `'${v.license_plate_state.replace(/'/g, "''")}'` : 'NULL'},
    ${v.current_mileage || 'NULL'},
    ${v.last_service_date ? `'${v.last_service_date.toISOString()}'` : 'NULL'},
    '${v.source_system}',
    ${v.source_id ? `'${v.source_id.replace(/'/g, "''")}'` : 'NULL'},
    ${v.is_deleted},
    false,
    ${v.raw_data ? `'${JSON.stringify(v.raw_data).replace(/'/g, "''")}'::jsonb` : 'NULL'},
    '${JSON.stringify(v.metadata).replace(/'/g, "''")}'::jsonb,
    '${v.created_at.toISOString()}',
    '${v.updated_at.toISOString()}'
  )`).join(',\n');
  
  await sql.unsafe(`
    INSERT INTO vehicles (id, shop_id, customer_id, vin, year, make, model, trim, body_style, engine, transmission, fuel_type, drive_type, exterior_color, license_plate, license_plate_state, current_mileage, last_service_date, source_system, source_id, is_deleted, is_closed, raw_data, metadata, created_at, updated_at)
    VALUES ${values}
    ON CONFLICT DO NOTHING
  `);
}

async function migrateWorkOrders(db: any, shopUuidMap: Map<number, string>) {
  console.log("\n=== Migrating Work Orders ===");
  const collectionStats: MigrationStats = { collection: "work_orders", total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const totalCount = await db.collection(NORMALIZED_COLLECTIONS.workOrders).countDocuments();
  collectionStats.total = totalCount;
  console.log(`Total work orders to process: ${totalCount}`);
  
  const vehicleMap = new Map<string, string>();
  const pgVehicles = await sql`SELECT id, source_id FROM vehicles WHERE source_id IS NOT NULL`;
  for (const v of pgVehicles) {
    vehicleMap.set(v.source_id as string, v.id as string);
  }
  
  const customerMap = new Map<string, string>();
  const pgCustomers = await sql`SELECT id, external_id FROM customers WHERE external_id IS NOT NULL`;
  for (const c of pgCustomers) {
    customerMap.set(c.external_id as string, c.id as string);
  }
  
  let processed = 0;
  const cursor = db.collection(NORMALIZED_COLLECTIONS.workOrders).find({}).batchSize(BATCH_SIZE);
  let batch: any[] = [];
  
  while (await cursor.hasNext()) {
    const wo = await cursor.next();
    processed++;
    
    const shopUuid = shopUuidMap.get(wo.shopId);
    if (!shopUuid) {
      collectionStats.skipped++;
      continue;
    }
    
    const vehicleUuid = wo.vehicleId ? vehicleMap.get(wo.vehicleId) : null;
    const customerUuid = wo.customerId ? customerMap.get(wo.customerId) : null;
    
    batch.push({
      shop_id: shopUuid,
      vehicle_id: vehicleUuid,
      customer_id: customerUuid,
      order_number: wo.workOrderNumber || "",
      status: wo.status || "closed",
      odometer_in: wo.odometerIn || null,
      odometer_out: wo.odometerOut || null,
      opened_date: wo.checkInDate ? new Date(wo.checkInDate) : wo.createdAt ? new Date(wo.createdAt) : new Date(),
      closed_date: wo.closedDate ? new Date(wo.closedDate) : null,
      labor_total: wo.laborTotal || 0,
      parts_total: wo.partsTotal || 0,
      total: wo.grandTotal || 0,
      source_system: wo.provenance?.sourceSystem || "unknown",
      source_id: wo.provenance?.sourceIds?.[0]?.idValue || wo._id,
      content_hash: wo.provenance?.contentHash || null,
      is_deleted: wo.softDelete?.isDeleted || false,
      raw_payload: { workOrderType: wo.workOrderType, customerConcern: wo.customerConcern },
      metadata: { tags: wo.tags, isWarranty: wo.isWarranty, isInternal: wo.isInternal },
      created_at: wo.createdAt ? new Date(wo.createdAt) : new Date(),
      updated_at: wo.updatedAt ? new Date(wo.updatedAt) : new Date(),
    });
    
    if (batch.length >= BATCH_SIZE) {
      try {
        await insertWorkOrderBatch(batch);
        collectionStats.migrated += batch.length;
      } catch (error: any) {
        console.error(`Batch insert failed:`, error.message);
        collectionStats.failed += batch.length;
      }
      batch = [];
      console.log(`Work Orders: ${processed}/${totalCount} processed (${collectionStats.migrated} migrated)`);
    }
  }
  
  if (batch.length > 0) {
    try {
      await insertWorkOrderBatch(batch);
      collectionStats.migrated += batch.length;
    } catch (error: any) {
      console.error(`Final batch insert failed:`, error.message);
      collectionStats.failed += batch.length;
    }
  }
  
  console.log(`Work Orders: ${collectionStats.migrated} migrated, ${collectionStats.skipped} skipped, ${collectionStats.failed} failed`);
  stats.push(collectionStats);
}

async function insertWorkOrderBatch(batch: any[]) {
  const values = batch.map(wo => `(
    gen_random_uuid(),
    '${wo.shop_id}'::uuid,
    ${wo.vehicle_id ? `'${wo.vehicle_id}'::uuid` : 'NULL'},
    ${wo.customer_id ? `'${wo.customer_id}'::uuid` : 'NULL'},
    '${(wo.order_number || "").replace(/'/g, "''")}',
    '${wo.status}',
    ${wo.odometer_in || 'NULL'},
    ${wo.odometer_out || 'NULL'},
    '${wo.opened_date.toISOString()}',
    ${wo.closed_date ? `'${wo.closed_date.toISOString()}'` : 'NULL'},
    ${wo.labor_total},
    ${wo.parts_total},
    ${wo.total},
    '${wo.source_system}',
    '${(wo.source_id || "").replace(/'/g, "''")}',
    ${wo.content_hash ? `'${wo.content_hash}'` : 'NULL'},
    ${wo.is_deleted},
    '${JSON.stringify(wo.raw_payload).replace(/'/g, "''")}'::jsonb,
    '${JSON.stringify(wo.metadata).replace(/'/g, "''")}'::jsonb,
    '${wo.created_at.toISOString()}',
    '${wo.updated_at.toISOString()}'
  )`).join(',\n');
  
  await sql.unsafe(`
    INSERT INTO work_orders (id, shop_id, vehicle_id, customer_id, order_number, status, odometer_in, odometer_out, opened_date, closed_date, labor_total, parts_total, total, source_system, source_id, content_hash, is_deleted, raw_payload, metadata, created_at, updated_at)
    VALUES ${values}
    ON CONFLICT DO NOTHING
  `);
}

async function main() {
  console.log("=====================================================");
  console.log("ETL: MongoDB -> PostgreSQL (Batch Mode)");
  console.log("=====================================================");
  console.log("Started at:", new Date().toISOString());
  
  try {
    const db = await getDb();
    
    await migrateShops(db);
    
    const shopUuidMap = await getShopUuidMap();
    console.log(`\nLoaded ${shopUuidMap.size} shop UUID mappings`);
    
    await migrateCustomers(db, shopUuidMap);
    await migrateVehicles(db, shopUuidMap);
    await migrateWorkOrders(db, shopUuidMap);
    
    console.log("\n=====================================================");
    console.log("Migration Summary");
    console.log("=====================================================");
    console.table(stats);
    console.log("\nCompleted at:", new Date().toISOString());
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
  
  process.exit(0);
}

main();
