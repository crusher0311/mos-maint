/**
 * PostgreSQL Ingestion Service
 * 
 * Writes normalized data directly to PostgreSQL instead of MongoDB.
 * Drop-in replacement for NormalizedIngestionService.
 */

import sql from './db/postgres';
import { SourceSystem } from './normalized-schema';
import {
  getAdapter,
  generateContentHash,
  createProvenance,
  INormalizedAdapter,
} from './normalized-adapters-pg';

export interface IngestionResult {
  success: boolean;
  entityType: string;
  entityId?: string;
  action: 'created' | 'updated' | 'skipped' | 'error';
  message?: string;
  contentHash?: string;
}

export interface IngestionBatchResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  results: IngestionResult[];
}

export interface IngestionOptions {
  syncRunId?: string;
  forceUpdate?: boolean;
  createAuditLog?: boolean;
}

async function getShopUUID(externalShopId: number): Promise<string | null> {
  const result = await sql`
    SELECT id FROM shops WHERE external_id = ${externalShopId} LIMIT 1
  `;
  return result.length > 0 ? result[0].id : null;
}

export class PostgresIngestionService {
  private adapter: INormalizedAdapter;
  private shopId: number;
  private shopUUID: string | null = null;
  private enterpriseId?: string;
  private options: IngestionOptions;
  
  constructor(
    sourceSystem: SourceSystem,
    shopId: number,
    enterpriseId?: string,
    options: IngestionOptions = {}
  ) {
    const adapter = getAdapter(sourceSystem);
    if (!adapter) {
      throw new Error(`No adapter found for source system: ${sourceSystem}`);
    }
    
    this.adapter = adapter;
    this.shopId = shopId;
    this.enterpriseId = enterpriseId;
    this.options = {
      createAuditLog: true,
      ...options,
    };
  }
  
  private async getShopUUID(): Promise<string | null> {
    if (this.shopUUID) return this.shopUUID;
    this.shopUUID = await getShopUUID(this.shopId);
    return this.shopUUID;
  }
  
  async ingestVehicle(sourceData: any): Promise<IngestionResult> {
    try {
      const shopUUID = await this.getShopUUID();
      if (!shopUUID) {
        return {
          success: false,
          entityType: 'vehicle',
          action: 'error',
          message: `Shop not found for external ID: ${this.shopId}`,
        };
      }

      const mapped: any = this.adapter.mapVehicle(this.shopId, sourceData, this.enterpriseId);
      const sourceIds = this.adapter.getSourceIds(sourceData);
      
      if (!mapped.vin && sourceIds.length === 0) {
        return {
          success: false,
          entityType: 'vehicle',
          action: 'error',
          message: 'Vehicle has no VIN and no source IDs',
        };
      }
      
      const vin = mapped.vin?.toUpperCase() || null;
      const externalId = sourceIds[0]?.idValue || null;
      
      const existing = await sql`
        SELECT id, metadata FROM vehicles 
        WHERE shop_id = ${shopUUID} 
        AND (
          (vin IS NOT NULL AND vin = ${vin})
          OR (external_id IS NOT NULL AND external_id = ${externalId})
        )
        LIMIT 1
      `;
      
      const contentHash = generateContentHash(mapped);
      const provenance = createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId);
      
      if (existing.length > 0) {
        const existingHash = existing[0].metadata?.contentHash;
        if (!this.options.forceUpdate && existingHash === contentHash) {
          return {
            success: true,
            entityType: 'vehicle',
            entityId: existing[0].id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await sql`
          UPDATE vehicles SET
            vin = ${vin},
            year = ${mapped.year || null},
            make = ${mapped.make || null},
            model = ${mapped.model || null},
            submodel = ${mapped.submodel || mapped.subModel || null},
            engine = ${mapped.engineDescription || null},
            transmission = ${mapped.transmissionDescription || null},
            drivetrain = ${mapped.driveType || null},
            color = ${mapped.exteriorColor || null},
            license_plate = ${mapped.licensePlate || null},
            odometer = ${mapped.currentOdometer || null},
            metadata = ${JSON.stringify({ ...mapped, provenance, contentHash })}::jsonb,
            updated_at = NOW()
          WHERE id = ${existing[0].id}
        `;
        
        if (this.options.createAuditLog) {
          await this.createAuditEntry('vehicle', existing[0].id, 'update', mapped);
        }
        
        return {
          success: true,
          entityType: 'vehicle',
          entityId: existing[0].id,
          action: 'updated',
          contentHash,
        };
      }
      
      const result = await sql`
        INSERT INTO vehicles (
          shop_id, external_id, vin, year, make, model, submodel,
          engine, transmission, drivetrain, color, license_plate, odometer,
          metadata, created_at, updated_at
        ) VALUES (
          ${shopUUID}, ${externalId}, ${vin}, ${mapped.year || null},
          ${mapped.make || null}, ${mapped.model || null}, ${mapped.submodel || mapped.subModel || null},
          ${mapped.engineDescription || null}, ${mapped.transmissionDescription || null}, 
          ${mapped.driveType || null}, ${mapped.exteriorColor || null}, 
          ${mapped.licensePlate || null}, ${mapped.currentOdometer || null},
          ${JSON.stringify({ ...mapped, provenance, contentHash })}::jsonb, NOW(), NOW()
        )
        ON CONFLICT (shop_id, external_id) DO UPDATE SET
          vin = EXCLUDED.vin,
          year = EXCLUDED.year,
          make = EXCLUDED.make,
          model = EXCLUDED.model,
          updated_at = NOW()
        RETURNING id
      `;
      
      if (this.options.createAuditLog) {
        await this.createAuditEntry('vehicle', result[0].id, 'create', mapped);
      }
      
      return {
        success: true,
        entityType: 'vehicle',
        entityId: result[0].id,
        action: 'created',
        contentHash,
      };
    } catch (error) {
      console.error('[PostgresIngestion] Vehicle error:', error);
      return {
        success: false,
        entityType: 'vehicle',
        action: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  async ingestCustomer(sourceData: any): Promise<IngestionResult> {
    try {
      const shopUUID = await this.getShopUUID();
      if (!shopUUID) {
        return {
          success: false,
          entityType: 'customer',
          action: 'error',
          message: `Shop not found for external ID: ${this.shopId}`,
        };
      }

      const mapped: any = this.adapter.mapCustomer(this.shopId, sourceData, this.enterpriseId);
      const sourceIds = this.adapter.getSourceIds(sourceData);
      const externalId = sourceIds[0]?.idValue || null;
      
      if (!externalId) {
        return {
          success: false,
          entityType: 'customer',
          action: 'error',
          message: 'Customer has no external ID',
        };
      }
      
      const existing = await sql`
        SELECT id, metadata FROM customers 
        WHERE shop_id = ${shopUUID} AND external_id = ${externalId}
        LIMIT 1
      `;
      
      const contentHash = generateContentHash(mapped);
      const provenance = createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId);
      
      const primaryEmail = mapped.emails?.[0]?.address || mapped.email || null;
      const primaryPhone = mapped.phones?.[0]?.number || mapped.phone || null;
      const addressData = mapped.addresses?.[0] || mapped.address || null;
      
      if (existing.length > 0) {
        const existingHash = existing[0].metadata?.contentHash;
        if (!this.options.forceUpdate && existingHash === contentHash) {
          return {
            success: true,
            entityType: 'customer',
            entityId: existing[0].id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await sql`
          UPDATE customers SET
            first_name = ${mapped.firstName || null},
            last_name = ${mapped.lastName || null},
            email = ${primaryEmail},
            phone = ${primaryPhone},
            company_name = ${mapped.companyName || null},
            address = ${addressData ? JSON.stringify(addressData) : null}::jsonb,
            metadata = ${JSON.stringify({ ...mapped, provenance, contentHash })}::jsonb,
            updated_at = NOW()
          WHERE id = ${existing[0].id}
        `;
        
        if (this.options.createAuditLog) {
          await this.createAuditEntry('customer', existing[0].id, 'update', mapped);
        }
        
        return {
          success: true,
          entityType: 'customer',
          entityId: existing[0].id,
          action: 'updated',
          contentHash,
        };
      }
      
      const result = await sql`
        INSERT INTO customers (
          shop_id, external_id, first_name, last_name, email, phone,
          company_name, address, metadata, created_at, updated_at
        ) VALUES (
          ${shopUUID}, ${externalId}, ${mapped.firstName || null},
          ${mapped.lastName || null}, ${primaryEmail}, ${primaryPhone},
          ${mapped.companyName || null}, ${addressData ? JSON.stringify(addressData) : null}::jsonb,
          ${JSON.stringify({ ...mapped, provenance, contentHash })}::jsonb, NOW(), NOW()
        )
        ON CONFLICT (shop_id, external_id) DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          updated_at = NOW()
        RETURNING id
      `;
      
      if (this.options.createAuditLog) {
        await this.createAuditEntry('customer', result[0].id, 'create', mapped);
      }
      
      return {
        success: true,
        entityType: 'customer',
        entityId: result[0].id,
        action: 'created',
        contentHash,
      };
    } catch (error) {
      console.error('[PostgresIngestion] Customer error:', error);
      return {
        success: false,
        entityType: 'customer',
        action: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  async ingestWorkOrder(sourceData: any): Promise<IngestionResult> {
    try {
      const shopUUID = await this.getShopUUID();
      if (!shopUUID) {
        return {
          success: false,
          entityType: 'work_order',
          action: 'error',
          message: `Shop not found for external ID: ${this.shopId}`,
        };
      }

      const mapped: any = this.adapter.mapWorkOrder(this.shopId, sourceData, this.enterpriseId);
      const sourceIds = this.adapter.getSourceIds(sourceData);
      
      if (!sourceIds.length) {
        return {
          success: false,
          entityType: 'work_order',
          action: 'error',
          message: 'Work order has no source IDs',
        };
      }
      
      const externalId = sourceIds[0]?.idValue || null;
      
      const vehicleData = this.adapter.extractVehicleFromWorkOrder(sourceData);
      let vehicleId: string | undefined;
      if (vehicleData) {
        const vehicleResult = await this.ingestVehicle(sourceData);
        if (vehicleResult.success && vehicleResult.entityId) {
          vehicleId = vehicleResult.entityId;
        }
      }
      
      const customerData = this.adapter.extractCustomerFromWorkOrder(sourceData);
      let customerId: string | undefined;
      if (customerData) {
        const customerResult = await this.ingestCustomer(sourceData);
        if (customerResult.success && customerResult.entityId) {
          customerId = customerResult.entityId;
        }
      }
      
      const existing = await sql`
        SELECT id, metadata FROM work_orders 
        WHERE shop_id = ${shopUUID} AND external_id = ${externalId}
        LIMIT 1
      `;
      
      const contentHash = generateContentHash(mapped);
      const provenance = createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId);
      const serviceJobs = this.adapter.extractServiceJobsFromWorkOrder(sourceData);
      
      const vin = mapped.vehicle?.vin?.toUpperCase() || null;
      const openedAt = mapped.openedDate || mapped.createdDate || null;
      const closedAt = mapped.closedDate || null;
      
      if (existing.length > 0) {
        const existingHash = existing[0].metadata?.contentHash;
        if (!this.options.forceUpdate && existingHash === contentHash) {
          return {
            success: true,
            entityType: 'work_order',
            entityId: existing[0].id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await sql`
          UPDATE work_orders SET
            vehicle_id = COALESCE(${vehicleId || null}, vehicle_id),
            customer_id = COALESCE(${customerId || null}, customer_id),
            vin = ${vin},
            work_order_number = ${mapped.workOrderNumber || null},
            status = ${mapped.status || 'open'},
            opened_at = ${openedAt ? new Date(openedAt) : null},
            closed_at = ${closedAt ? new Date(closedAt) : null},
            odometer_in = ${mapped.odometerIn || null},
            odometer_out = ${mapped.odometerOut || null},
            labor_total = ${mapped.laborTotal || 0},
            parts_total = ${mapped.partsTotal || 0},
            grand_total = ${mapped.grandTotal || 0},
            service_jobs = ${JSON.stringify(serviceJobs)}::jsonb,
            metadata = ${JSON.stringify({ ...mapped, provenance, contentHash })}::jsonb,
            updated_at = NOW()
          WHERE id = ${existing[0].id}
        `;
        
        if (this.options.createAuditLog) {
          await this.createAuditEntry('work_order', existing[0].id, 'update', mapped);
        }
        
        return {
          success: true,
          entityType: 'work_order',
          entityId: existing[0].id,
          action: 'updated',
          contentHash,
        };
      }
      
      const result = await sql`
        INSERT INTO work_orders (
          shop_id, external_id, vehicle_id, customer_id, vin,
          work_order_number, status, opened_at, closed_at,
          odometer_in, odometer_out, labor_total, parts_total, grand_total,
          service_jobs, metadata, created_at, updated_at
        ) VALUES (
          ${shopUUID}, ${externalId}, ${vehicleId || null}, ${customerId || null}, ${vin},
          ${mapped.workOrderNumber || null}, ${mapped.status || 'open'},
          ${openedAt ? new Date(openedAt) : null},
          ${closedAt ? new Date(closedAt) : null},
          ${mapped.odometerIn || null}, ${mapped.odometerOut || null},
          ${mapped.laborTotal || 0}, ${mapped.partsTotal || 0}, ${mapped.grandTotal || 0},
          ${JSON.stringify(serviceJobs)}::jsonb,
          ${JSON.stringify({ ...mapped, provenance, contentHash })}::jsonb,
          NOW(), NOW()
        )
        ON CONFLICT (shop_id, external_id) DO UPDATE SET
          vin = EXCLUDED.vin,
          status = EXCLUDED.status,
          grand_total = EXCLUDED.grand_total,
          service_jobs = EXCLUDED.service_jobs,
          updated_at = NOW()
        RETURNING id
      `;
      
      if (this.options.createAuditLog) {
        await this.createAuditEntry('work_order', result[0].id, 'create', mapped);
      }
      
      return {
        success: true,
        entityType: 'work_order',
        entityId: result[0].id,
        action: 'created',
        contentHash,
      };
    } catch (error) {
      console.error('[PostgresIngestion] WorkOrder error:', error);
      return {
        success: false,
        entityType: 'work_order',
        action: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  async ingestBatch(items: { type: 'vehicle' | 'customer' | 'work_order'; data: any }[]): Promise<IngestionBatchResult> {
    const results: IngestionResult[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const item of items) {
      let result: IngestionResult;
      
      switch (item.type) {
        case 'vehicle':
          result = await this.ingestVehicle(item.data);
          break;
        case 'customer':
          result = await this.ingestCustomer(item.data);
          break;
        case 'work_order':
          result = await this.ingestWorkOrder(item.data);
          break;
        default:
          result = { success: false, entityType: 'unknown', action: 'error', message: 'Unknown type' };
      }
      
      results.push(result);
      
      switch (result.action) {
        case 'created': created++; break;
        case 'updated': updated++; break;
        case 'skipped': skipped++; break;
        case 'error': errors++; break;
      }
    }
    
    return { total: items.length, created, updated, skipped, errors, results };
  }
  
  private async createAuditEntry(entityType: string, entityId: string, action: string, data: any): Promise<void> {
    try {
      const shopUUID = await this.getShopUUID();
      await sql`
        INSERT INTO audit_logs (shop_id, action, resource_type, resource_id, details, created_at)
        VALUES (${shopUUID}, ${action}, ${entityType}, ${entityId}, ${JSON.stringify(data)}::jsonb, NOW())
      `;
    } catch (error) {
      console.error('[PostgresIngestion] Audit log error:', error);
    }
  }
}

export async function upsertTekmetricWorkOrderToPostgres(
  shopId: number,
  workOrderId: string,
  data: {
    workOrderNumber?: number;
    vin?: string;
    status?: string;
    statusCode?: string;
    label?: string;
    labelColor?: string;
    customerId?: number;
    vehicleId?: number;
    customerName?: string;
    vehicleYear?: number;
    vehicleMake?: string;
    vehicleModel?: string;
    vehicleSubmodel?: string;
    mileageIn?: number;
    mileageOut?: number;
    createdDate?: string;
    closedDate?: string;
    rawData?: any;
  }
): Promise<void> {
  const shopUUID = await getShopUUID(shopId);
  if (!shopUUID) {
    console.error(`[PostgresIngestion] Shop not found: ${shopId}`);
    return;
  }
  
  await sql`
    INSERT INTO tekmetric_work_orders (
      shop_id, external_shop_id, work_order_id, work_order_number,
      vin, status, status_code, label, label_color,
      customer_id, vehicle_id, customer_name,
      vehicle_year, vehicle_make, vehicle_model, vehicle_submodel,
      mileage_in, mileage_out, created_date, closed_date,
      raw_data, synced_at
    ) VALUES (
      ${shopUUID}, ${shopId}, ${workOrderId}, ${data.workOrderNumber || null},
      ${data.vin?.toUpperCase() || null}, ${data.status || null}, ${data.statusCode || null},
      ${data.label || null}, ${data.labelColor || null},
      ${data.customerId || null}, ${data.vehicleId || null}, ${data.customerName || null},
      ${data.vehicleYear || null}, ${data.vehicleMake || null},
      ${data.vehicleModel || null}, ${data.vehicleSubmodel || null},
      ${data.mileageIn || null}, ${data.mileageOut || null},
      ${data.createdDate ? new Date(data.createdDate) : null},
      ${data.closedDate ? new Date(data.closedDate) : null},
      ${data.rawData ? JSON.stringify(data.rawData) : '{}'}::jsonb, NOW()
    )
    ON CONFLICT (external_shop_id, work_order_id) DO UPDATE SET
      work_order_number = EXCLUDED.work_order_number,
      vin = EXCLUDED.vin,
      status = EXCLUDED.status,
      status_code = EXCLUDED.status_code,
      label = EXCLUDED.label,
      label_color = EXCLUDED.label_color,
      customer_name = EXCLUDED.customer_name,
      vehicle_year = EXCLUDED.vehicle_year,
      vehicle_make = EXCLUDED.vehicle_make,
      vehicle_model = EXCLUDED.vehicle_model,
      mileage_in = EXCLUDED.mileage_in,
      mileage_out = EXCLUDED.mileage_out,
      closed_date = EXCLUDED.closed_date,
      raw_data = EXCLUDED.raw_data,
      synced_at = NOW()
  `;
}

export async function upsertProtractorWorkOrderToPostgres(
  shopId: number,
  workOrderId: string,
  data: {
    workOrderNumber?: string;
    vin?: string;
    status?: string;
    customerId?: string;
    vehicleId?: string;
    customerName?: string;
    vehicleYear?: number;
    vehicleMake?: string;
    vehicleModel?: string;
    mileage?: number;
    createdDate?: string;
    closedDate?: string;
    rawData?: any;
  }
): Promise<void> {
  const shopUUID = await getShopUUID(shopId);
  if (!shopUUID) {
    console.error(`[PostgresIngestion] Shop not found: ${shopId}`);
    return;
  }
  
  await sql`
    INSERT INTO protractor_work_orders (
      shop_id, external_shop_id, work_order_id, work_order_number,
      vin, status, customer_id, vehicle_id, customer_name,
      vehicle_year, vehicle_make, vehicle_model, mileage,
      created_date, closed_date, raw_data, synced_at
    ) VALUES (
      ${shopUUID}, ${shopId}, ${workOrderId}, ${data.workOrderNumber || null},
      ${data.vin?.toUpperCase() || null}, ${data.status || null},
      ${data.customerId || null}, ${data.vehicleId || null}, ${data.customerName || null},
      ${data.vehicleYear || null}, ${data.vehicleMake || null}, ${data.vehicleModel || null},
      ${data.mileage || null},
      ${data.createdDate ? new Date(data.createdDate) : null},
      ${data.closedDate ? new Date(data.closedDate) : null},
      ${data.rawData ? JSON.stringify(data.rawData) : '{}'}::jsonb, NOW()
    )
    ON CONFLICT (external_shop_id, work_order_id) DO UPDATE SET
      work_order_number = EXCLUDED.work_order_number,
      vin = EXCLUDED.vin,
      status = EXCLUDED.status,
      customer_name = EXCLUDED.customer_name,
      vehicle_year = EXCLUDED.vehicle_year,
      vehicle_make = EXCLUDED.vehicle_make,
      vehicle_model = EXCLUDED.vehicle_model,
      mileage = EXCLUDED.mileage,
      closed_date = EXCLUDED.closed_date,
      raw_data = EXCLUDED.raw_data,
      synced_at = NOW()
  `;
}

export async function upsertProtractorVehicleToPostgres(
  shopId: number,
  vehicleId: string,
  data: {
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    licensePlate?: string;
    customerId?: string;
    rawData?: any;
  }
): Promise<void> {
  const shopUUID = await getShopUUID(shopId);
  if (!shopUUID) {
    console.error(`[PostgresIngestion] Shop not found: ${shopId}`);
    return;
  }
  
  await sql`
    INSERT INTO protractor_vehicles (
      shop_id, external_shop_id, vehicle_id, vin, year, make, model,
      license_plate, customer_id, raw_data, synced_at
    ) VALUES (
      ${shopUUID}, ${shopId}, ${vehicleId}, ${data.vin?.toUpperCase() || null},
      ${data.year || null}, ${data.make || null}, ${data.model || null},
      ${data.licensePlate || null}, ${data.customerId || null},
      ${data.rawData ? JSON.stringify(data.rawData) : '{}'}::jsonb, NOW()
    )
    ON CONFLICT (external_shop_id, vehicle_id) DO UPDATE SET
      vin = EXCLUDED.vin,
      year = EXCLUDED.year,
      make = EXCLUDED.make,
      model = EXCLUDED.model,
      license_plate = EXCLUDED.license_plate,
      raw_data = EXCLUDED.raw_data,
      synced_at = NOW()
  `;
}
