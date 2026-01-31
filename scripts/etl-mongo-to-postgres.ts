/**
 * ETL Script: MongoDB Normalized Collections -> PostgreSQL Tables
 * 
 * Migrates historical data from MongoDB normalized_* collections
 * to the PostgreSQL normalized schema.
 */

import { getDb } from "../lib/mongo";
import sql from "../lib/db/postgres";
import { NORMALIZED_COLLECTIONS } from "../lib/normalized-schema";

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
          ${shop.ownerId || null},
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
          ${shop.enterpriseId || null},
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
  
  const customers = await db.collection(NORMALIZED_COLLECTIONS.customers).find({}).toArray();
  collectionStats.total = customers.length;
  
  for (const customer of customers) {
    const shopUuid = shopUuidMap.get(customer.shopId);
    if (!shopUuid) {
      collectionStats.skipped++;
      continue;
    }
    
    try {
      const primaryContact = customer.contacts?.find((c: any) => c.isPrimary) || customer.contacts?.[0];
      
      await sql`
        INSERT INTO customers (
          id, shop_id, external_id, first_name, last_name, email, phone,
          address, notes, source_system, source_id, is_deleted, metadata,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(),
          ${shopUuid}::uuid,
          ${customer._id},
          ${customer.firstName || primaryContact?.firstName || ""},
          ${customer.lastName || primaryContact?.lastName || ""},
          ${primaryContact?.email || null},
          ${primaryContact?.phone || null},
          ${JSON.stringify(customer.billingAddress || customer.mailingAddress || null)}::jsonb,
          ${customer.notes || null},
          ${customer.provenance?.sourceSystem || "unknown"},
          ${customer.provenance?.sourceIds?.[0]?.idValue || null},
          ${customer.softDelete?.isDeleted || false},
          ${JSON.stringify({
            companyName: customer.companyName,
            customerType: customer.customerType,
            contacts: customer.contacts,
            totalVisits: customer.totalVisits,
            totalSpent: customer.totalSpent,
            averageTicket: customer.averageTicket,
            lastVisitDate: customer.lastVisitDate,
            tags: customer.tags,
            customFields: customer.customFields,
          })}::jsonb,
          ${customer.createdAt ? new Date(customer.createdAt) : new Date()},
          ${customer.updatedAt ? new Date(customer.updatedAt) : new Date()}
        )
        ON CONFLICT (shop_id, external_id) DO NOTHING
      `;
      collectionStats.migrated++;
    } catch (error: any) {
      if (!error.message?.includes("duplicate")) {
        console.error(`Failed to migrate customer ${customer._id}:`, error.message);
      }
      collectionStats.failed++;
    }
  }
  
  console.log(`Customers: ${collectionStats.migrated} migrated, ${collectionStats.skipped} skipped, ${collectionStats.failed} failed`);
  stats.push(collectionStats);
}

async function migrateVehicles(db: any, shopUuidMap: Map<number, string>) {
  console.log("\n=== Migrating Vehicles ===");
  const collectionStats: MigrationStats = { collection: "vehicles", total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const vehicles = await db.collection(NORMALIZED_COLLECTIONS.vehicles).find({}).toArray();
  collectionStats.total = vehicles.length;
  
  const customerMap = new Map<string, string>();
  const pgCustomers = await sql`SELECT id, external_id FROM customers WHERE external_id IS NOT NULL`;
  for (const c of pgCustomers) {
    customerMap.set(c.external_id as string, c.id as string);
  }
  
  for (const vehicle of vehicles) {
    const shopUuid = shopUuidMap.get(vehicle.shopId);
    if (!shopUuid) {
      collectionStats.skipped++;
      continue;
    }
    
    try {
      const customerUuid = vehicle.customerId ? customerMap.get(vehicle.customerId) : null;
      
      await sql`
        INSERT INTO vehicles (
          id, shop_id, customer_id, vin, year, make, model, trim, body_style,
          engine, transmission, fuel_type, drive_type, exterior_color,
          license_plate, license_plate_state, current_mileage, last_service_date,
          source_system, source_id, is_deleted, is_closed, raw_data, metadata,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(),
          ${shopUuid}::uuid,
          ${customerUuid || null}::uuid,
          ${vehicle.vin || null},
          ${vehicle.year || null},
          ${vehicle.make || null},
          ${vehicle.model || null},
          ${vehicle.trim || null},
          ${vehicle.bodyStyle || null},
          ${vehicle.engineDescription || null},
          ${vehicle.transmission || null},
          ${vehicle.fuelType || null},
          ${vehicle.drivetrain || null},
          ${vehicle.exteriorColor || null},
          ${vehicle.licensePlate || null},
          ${vehicle.licensePlateState || null},
          ${vehicle.currentOdometer || null},
          ${vehicle.lastServiceDate ? new Date(vehicle.lastServiceDate) : null},
          ${vehicle.provenance?.sourceSystem || "unknown"},
          ${vehicle.provenance?.sourceIds?.[0]?.idValue || vehicle._id},
          ${vehicle.softDelete?.isDeleted || false},
          ${false},
          ${JSON.stringify(vehicle.vinDecodeData || null)}::jsonb,
          ${JSON.stringify({
            tags: vehicle.tags,
            customFields: vehicle.customFields,
            odometerHistory: vehicle.odometerHistory,
            ownershipType: vehicle.ownershipType,
            isFleet: vehicle.isFleet,
            fleetId: vehicle.fleetId,
          })}::jsonb,
          ${vehicle.createdAt ? new Date(vehicle.createdAt) : new Date()},
          ${vehicle.updatedAt ? new Date(vehicle.updatedAt) : new Date()}
        )
        ON CONFLICT DO NOTHING
      `;
      collectionStats.migrated++;
    } catch (error: any) {
      if (!error.message?.includes("duplicate")) {
        console.error(`Failed to migrate vehicle ${vehicle.vin || vehicle._id}:`, error.message);
      }
      collectionStats.failed++;
    }
  }
  
  console.log(`Vehicles: ${collectionStats.migrated} migrated, ${collectionStats.skipped} skipped, ${collectionStats.failed} failed`);
  stats.push(collectionStats);
}

async function migrateWorkOrders(db: any, shopUuidMap: Map<number, string>) {
  console.log("\n=== Migrating Work Orders ===");
  const collectionStats: MigrationStats = { collection: "work_orders", total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const workOrders = await db.collection(NORMALIZED_COLLECTIONS.workOrders).find({}).toArray();
  collectionStats.total = workOrders.length;
  
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
  
  for (const wo of workOrders) {
    const shopUuid = shopUuidMap.get(wo.shopId);
    if (!shopUuid) {
      collectionStats.skipped++;
      continue;
    }
    
    try {
      const vehicleUuid = wo.vehicleId ? vehicleMap.get(wo.vehicleId) : null;
      const customerUuid = wo.customerId ? customerMap.get(wo.customerId) : null;
      
      await sql`
        INSERT INTO work_orders (
          id, shop_id, vehicle_id, customer_id, order_number, status,
          odometer_in, odometer_out, opened_date, closed_date,
          labor_total, parts_total, total, source_system, source_id,
          content_hash, is_deleted, raw_payload, metadata,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(),
          ${shopUuid}::uuid,
          ${vehicleUuid || null}::uuid,
          ${customerUuid || null}::uuid,
          ${wo.workOrderNumber || ""},
          ${wo.status || "closed"},
          ${wo.odometerIn || null},
          ${wo.odometerOut || null},
          ${wo.checkInDate ? new Date(wo.checkInDate) : wo.createdAt ? new Date(wo.createdAt) : new Date()},
          ${wo.closedDate ? new Date(wo.closedDate) : null},
          ${wo.laborTotal || 0},
          ${wo.partsTotal || 0},
          ${wo.grandTotal || 0},
          ${wo.provenance?.sourceSystem || "unknown"},
          ${wo.provenance?.sourceIds?.[0]?.idValue || wo._id},
          ${wo.provenance?.contentHash || null},
          ${wo.softDelete?.isDeleted || false},
          ${JSON.stringify({
            workOrderType: wo.workOrderType,
            customerConcern: wo.customerConcern,
            technicianNotes: wo.technicianNotes,
            serviceAdvisorName: wo.serviceAdvisorName,
            technicians: wo.technicians,
          })}::jsonb,
          ${JSON.stringify({
            tags: wo.tags,
            customFields: wo.customFields,
            statusHistory: wo.statusHistory,
            isWarranty: wo.isWarranty,
            isInternal: wo.isInternal,
            isComeback: wo.isComeback,
          })}::jsonb,
          ${wo.createdAt ? new Date(wo.createdAt) : new Date()},
          ${wo.updatedAt ? new Date(wo.updatedAt) : new Date()}
        )
        ON CONFLICT DO NOTHING
      `;
      collectionStats.migrated++;
    } catch (error: any) {
      if (!error.message?.includes("duplicate")) {
        console.error(`Failed to migrate work order ${wo.workOrderNumber}:`, error.message);
      }
      collectionStats.failed++;
    }
  }
  
  console.log(`Work Orders: ${collectionStats.migrated} migrated, ${collectionStats.skipped} skipped, ${collectionStats.failed} failed`);
  stats.push(collectionStats);
}

async function migrateServiceJobs(db: any, shopUuidMap: Map<number, string>) {
  console.log("\n=== Migrating Service Jobs ===");
  const collectionStats: MigrationStats = { collection: "service_jobs", total: 0, migrated: 0, skipped: 0, failed: 0 };
  
  const serviceJobs = await db.collection(NORMALIZED_COLLECTIONS.serviceJobs).find({}).toArray();
  collectionStats.total = serviceJobs.length;
  
  const workOrderMap = new Map<string, string>();
  const pgWorkOrders = await sql`SELECT id, source_id FROM work_orders WHERE source_id IS NOT NULL`;
  for (const wo of pgWorkOrders) {
    workOrderMap.set(wo.source_id as string, wo.id as string);
  }
  
  for (const job of serviceJobs) {
    const shopUuid = shopUuidMap.get(job.shopId);
    if (!shopUuid) {
      collectionStats.skipped++;
      continue;
    }
    
    try {
      const workOrderUuid = job.workOrderId ? workOrderMap.get(job.workOrderId) : null;
      
      await sql`
        INSERT INTO service_jobs (
          id, work_order_id, shop_id, title, description,
          labor_amount, parts_amount, total_amount, labor_hours,
          status, is_declined, declined_reason, source_system, source_id,
          content_hash, is_deleted, metadata, created_at
        ) VALUES (
          gen_random_uuid(),
          ${workOrderUuid || null}::uuid,
          ${shopUuid}::uuid,
          ${job.title || job.description?.substring(0, 100) || "Service"},
          ${job.description || null},
          ${job.laborTotal || 0},
          ${job.partsTotal || 0},
          ${job.total || 0},
          ${job.laborHours || 0},
          ${job.status || "completed"},
          ${job.status === "declined"},
          ${job.declineReason || null},
          ${job.provenance?.sourceSystem || "unknown"},
          ${job.provenance?.sourceIds?.[0]?.idValue || job._id},
          ${job.provenance?.contentHash || null},
          ${job.softDelete?.isDeleted || false},
          ${JSON.stringify({
            jobType: job.jobType,
            cannedJobId: job.cannedJobId,
            technicianId: job.technicianId,
            lineItems: job.lineItems,
            tags: job.tags,
          })}::jsonb,
          ${job.createdAt ? new Date(job.createdAt) : new Date()}
        )
        ON CONFLICT DO NOTHING
      `;
      collectionStats.migrated++;
    } catch (error: any) {
      if (!error.message?.includes("duplicate")) {
        console.error(`Failed to migrate service job ${job._id}:`, error.message);
      }
      collectionStats.failed++;
    }
  }
  
  console.log(`Service Jobs: ${collectionStats.migrated} migrated, ${collectionStats.skipped} skipped, ${collectionStats.failed} failed`);
  stats.push(collectionStats);
}

async function main() {
  console.log("=====================================================");
  console.log("ETL: MongoDB Normalized Collections -> PostgreSQL");
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
    await migrateServiceJobs(db, shopUuidMap);
    
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
