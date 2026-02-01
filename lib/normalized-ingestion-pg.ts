/**
 * MOS Normalized Data Ingestion Service - PostgreSQL Version
 * 
 * Handles ingestion to PostgreSQL normalized tables.
 * Provides change detection, deduplication, and audit logging.
 */

import sql from './db/postgres';
import {
  SourceSystem,
  NormalizedVehicle,
  NormalizedCustomer,
  NormalizedWorkOrder,
  NormalizedServiceJob,
  NormalizedPayment,
  NormalizedInspection,
  NormalizedRecommendation,
} from './normalized-schema';
import {
  getAdapter,
  generateContentHash,
  generateEntityIdPg,
  createProvenance,
  createSoftDelete,
  INormalizedAdapter,
} from './normalized-adapters-pg';
import { updateRepairPattern } from './repair-patterns';

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
  dualWriteToJobIndex?: boolean;
  dualWriteToRepairPatterns?: boolean;
}

export class NormalizedIngestionServicePg {
  private adapter: INormalizedAdapter;
  private shopId: number;
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
      dualWriteToJobIndex: true,
      ...options,
    };
  }
  
  private sanitizeRawPayload(data: any): any {
    try {
      return JSON.parse(JSON.stringify(data));
    } catch {
      return { error: 'Failed to serialize raw payload', timestamp: new Date().toISOString() };
    }
  }
  
  async ingestVehicle(sourceData: any): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapVehicle(this.shopId, sourceData, this.enterpriseId);
      const sourceIds = this.adapter.getSourceIds(sourceData);
      
      if (!mapped.vin && sourceIds.length === 0) {
        return {
          success: false,
          entityType: 'vehicle',
          action: 'error',
          message: 'Vehicle has no VIN and no source IDs',
        };
      }
      
      let existing: any = null;
      if (mapped.vin) {
        const result = await sql`
          SELECT id, provenance, version FROM normalized_vehicles
          WHERE shop_id = ${this.shopId} AND vin = ${mapped.vin}
          LIMIT 1
        `;
        existing = result[0];
      } else if (sourceIds.length > 0) {
        const result = await sql`
          SELECT id, provenance, version FROM normalized_vehicles
          WHERE shop_id = ${this.shopId}
          AND provenance->'sourceIds' @> ${JSON.stringify([sourceIds[0]])}::jsonb
          LIMIT 1
        `;
        existing = result[0];
      }
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        const existingProvenance = existing.provenance;
        if (!this.options.forceUpdate && existingProvenance?.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'vehicle',
            entityId: existing.id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        const updatedProvenance = {
          ...existingProvenance,
          lastSeenAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
          syncRunId: this.options.syncRunId,
          contentHash,
          sourceIds: this.mergeSourceIds(existingProvenance?.sourceIds || [], sourceIds),
        };
        
        await sql`
          UPDATE normalized_vehicles SET
            year = ${mapped.year || null},
            make = ${mapped.make || null},
            model = ${mapped.model || null},
            trim_level = ${mapped.trim || null},
            engine_description = ${mapped.engineDescription || null},
            transmission_type = ${mapped.transmission || null},
            drive_type = ${mapped.drivetrain || null},
            color = ${mapped.exteriorColor || null},
            odometer = ${(mapped as any).odometer || null},
            odometer_unit = ${mapped.odometerUnit || 'miles'},
            provenance = ${JSON.stringify(updatedProvenance)},
            updated_at = NOW(),
            version = ${existing.version + 1}
          WHERE id = ${existing.id}
        `;
        
        if (this.options.createAuditLog) {
          await this.createAuditEntry('vehicle', existing.id, 'update', mapped);
        }
        
        return {
          success: true,
          entityType: 'vehicle',
          entityId: existing.id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityIdPg();
      const provenance = createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId);
      const softDelete = createSoftDelete();
      
      await sql`
        INSERT INTO normalized_vehicles (
          id, shop_id, enterprise_id, vin, year, make, model, trim_level,
          engine_description, transmission_type, drive_type, color,
          odometer, odometer_unit, provenance, soft_delete
        ) VALUES (
          ${newId}, ${this.shopId}, ${this.enterpriseId || null}, ${mapped.vin || null},
          ${mapped.year || null}, ${mapped.make || null}, ${mapped.model || null},
          ${mapped.trim || null}, ${mapped.engineDescription || null},
          ${mapped.transmission || null}, ${mapped.drivetrain || null},
          ${mapped.exteriorColor || null}, ${(mapped as any).odometer || null},
          ${mapped.odometerUnit || 'miles'}, ${JSON.stringify(provenance)},
          ${JSON.stringify(softDelete)}
        )
      `;
      
      if (this.options.createAuditLog) {
        await this.createAuditEntry('vehicle', newId, 'create', mapped);
      }
      
      return {
        success: true,
        entityType: 'vehicle',
        entityId: newId,
        action: 'created',
        contentHash,
      };
    } catch (error) {
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
      const mapped = this.adapter.mapCustomer(this.shopId, sourceData, this.enterpriseId);
      const sourceIds = this.adapter.getSourceIds(sourceData);
      
      let existing: any = null;
      if (sourceIds.length > 0) {
        const result = await sql`
          SELECT id, provenance, version FROM normalized_customers
          WHERE shop_id = ${this.shopId}
          AND provenance->'sourceIds' @> ${JSON.stringify([sourceIds[0]])}::jsonb
          LIMIT 1
        `;
        existing = result[0];
      }
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        const existingProvenance = existing.provenance;
        if (!this.options.forceUpdate && existingProvenance?.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'customer',
            entityId: existing.id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        const updatedProvenance = {
          ...existingProvenance,
          lastSeenAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
          syncRunId: this.options.syncRunId,
          contentHash,
          sourceIds: this.mergeSourceIds(existingProvenance?.sourceIds || [], sourceIds),
        };
        
        const m = mapped as any;
        await sql`
          UPDATE normalized_customers SET
            first_name = ${mapped.firstName || null},
            last_name = ${mapped.lastName || null},
            company_name = ${mapped.companyName || null},
            email = ${m.email || null},
            phone = ${m.phone || null},
            address = ${m.address ? JSON.stringify(m.address) : null},
            provenance = ${JSON.stringify(updatedProvenance)},
            updated_at = NOW(),
            version = ${existing.version + 1}
          WHERE id = ${existing.id}
        `;
        
        if (this.options.createAuditLog) {
          await this.createAuditEntry('customer', existing.id, 'update', mapped);
        }
        
        return {
          success: true,
          entityType: 'customer',
          entityId: existing.id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityIdPg();
      const provenance = createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId);
      const softDelete = createSoftDelete();
      
      const m = mapped as any;
      await sql`
        INSERT INTO normalized_customers (
          id, shop_id, enterprise_id, first_name, last_name, company_name,
          email, phone, address, provenance, soft_delete
        ) VALUES (
          ${newId}, ${this.shopId}, ${this.enterpriseId || null},
          ${mapped.firstName || null}, ${mapped.lastName || null},
          ${mapped.companyName || null}, ${m.email || null},
          ${m.phone || null}, ${m.address ? JSON.stringify(m.address) : null},
          ${JSON.stringify(provenance)}, ${JSON.stringify(softDelete)}
        )
      `;
      
      if (this.options.createAuditLog) {
        await this.createAuditEntry('customer', newId, 'create', mapped);
      }
      
      return {
        success: true,
        entityType: 'customer',
        entityId: newId,
        action: 'created',
        contentHash,
      };
    } catch (error) {
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
      const mapped = this.adapter.mapWorkOrder(this.shopId, sourceData, this.enterpriseId);
      const sourceIds = this.adapter.getSourceIds(sourceData);
      
      if (!sourceIds.length) {
        return {
          success: false,
          entityType: 'work_order',
          action: 'error',
          message: 'Work order has no source IDs',
        };
      }
      
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
      
      let existing: any = null;
      if (sourceIds.length > 0) {
        const result = await sql`
          SELECT id, provenance, version, vehicle_id, customer_id FROM normalized_work_orders
          WHERE shop_id = ${this.shopId}
          AND provenance->'sourceIds' @> ${JSON.stringify([sourceIds[0]])}::jsonb
          LIMIT 1
        `;
        existing = result[0];
      }
      
      const contentHash = generateContentHash(mapped);
      const serviceJobs = this.adapter.extractServiceJobsFromWorkOrder(sourceData);
      
      if (existing) {
        const existingProvenance = existing.provenance;
        if (!this.options.forceUpdate && existingProvenance?.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'work_order',
            entityId: existing.id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        const updatedProvenance = {
          ...existingProvenance,
          lastSeenAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
          syncRunId: this.options.syncRunId,
          contentHash,
          sourceIds: this.mergeSourceIds(existingProvenance?.sourceIds || [], sourceIds),
        };
        
        await sql`
          UPDATE normalized_work_orders SET
            vehicle_id = COALESCE(${vehicleId || null}, vehicle_id),
            customer_id = COALESCE(${customerId || null}, customer_id),
            work_order_number = ${mapped.workOrderNumber || null},
            work_order_type = ${mapped.workOrderType || 'repair'},
            status = ${mapped.status || 'closed'},
            odometer_in = ${mapped.odometerIn || null},
            odometer_out = ${mapped.odometerOut || null},
            service_jobs = ${JSON.stringify(serviceJobs)},
            subtotal = ${mapped.subtotal || 0},
            tax_total = ${mapped.taxTotal || 0},
            discount_total = ${mapped.discountTotal || 0},
            grand_total = ${mapped.grandTotal || 0},
            labor_total = ${mapped.laborTotal || 0},
            parts_total = ${mapped.partsTotal || 0},
            sublet_total = ${mapped.subletTotal || 0},
            fees_total = ${mapped.feesTotal || 0},
            labor_hours_total = ${mapped.laborHoursTotal || 0},
            labor_hours_billed = ${mapped.laborHoursBilled || 0},
            opened_at = ${mapped.checkInDate || null},
            closed_at = ${mapped.closedDate || null},
            notes = ${mapped.internalNotes || null},
            raw_payload = ${JSON.stringify(this.sanitizeRawPayload(sourceData.rawPayload || sourceData))},
            provenance = ${JSON.stringify(updatedProvenance)},
            updated_at = NOW(),
            version = ${existing.version + 1}
          WHERE id = ${existing.id}
        `;
        
        if (this.options.dualWriteToJobIndex && serviceJobs.length > 0) {
          await this.writeToJobIndex(sourceData, serviceJobs);
        }
        
        if (this.options.dualWriteToRepairPatterns && serviceJobs.length > 0) {
          await this.writeToRepairPatterns(sourceData, serviceJobs);
        }
        
        if (this.options.createAuditLog) {
          await this.createAuditEntry('work_order', existing.id, 'update', mapped);
        }
        
        return {
          success: true,
          entityType: 'work_order',
          entityId: existing.id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityIdPg();
      const provenance = createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId);
      const softDelete = createSoftDelete();
      
      await sql`
        INSERT INTO normalized_work_orders (
          id, shop_id, enterprise_id, vehicle_id, customer_id,
          work_order_number, work_order_type, status, odometer_in, odometer_out,
          service_jobs, subtotal, tax_total, discount_total, grand_total,
          labor_total, parts_total, sublet_total, fees_total,
          labor_hours_total, labor_hours_billed, opened_at, closed_at, notes,
          raw_payload, provenance, soft_delete
        ) VALUES (
          ${newId}, ${this.shopId}, ${this.enterpriseId || null},
          ${vehicleId || ''}, ${customerId || null},
          ${mapped.workOrderNumber || String(sourceIds[0]?.idValue)},
          ${mapped.workOrderType || 'repair'}, ${mapped.status || 'closed'},
          ${mapped.odometerIn || null}, ${mapped.odometerOut || null},
          ${JSON.stringify(serviceJobs)}, ${mapped.subtotal || 0},
          ${mapped.taxTotal || 0}, ${mapped.discountTotal || 0},
          ${mapped.grandTotal || 0}, ${mapped.laborTotal || 0},
          ${mapped.partsTotal || 0}, ${mapped.subletTotal || 0},
          ${mapped.feesTotal || 0}, ${mapped.laborHoursTotal || 0},
          ${mapped.laborHoursBilled || 0}, ${mapped.checkInDate || null},
          ${mapped.closedDate || null}, ${mapped.internalNotes || null},
          ${JSON.stringify(this.sanitizeRawPayload(sourceData.rawPayload || sourceData))},
          ${JSON.stringify(provenance)}, ${JSON.stringify(softDelete)}
        )
      `;
      
      if (this.options.dualWriteToJobIndex && serviceJobs.length > 0) {
        await this.writeToJobIndex(sourceData, serviceJobs);
      }
      
      if (this.options.dualWriteToRepairPatterns && serviceJobs.length > 0) {
        await this.writeToRepairPatterns(sourceData, serviceJobs);
      }
      
      if (this.options.createAuditLog) {
        await this.createAuditEntry('work_order', newId, 'create', mapped);
      }
      
      return {
        success: true,
        entityType: 'work_order',
        entityId: newId,
        action: 'created',
        contentHash,
      };
    } catch (error) {
      return {
        success: false,
        entityType: 'work_order',
        action: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  async ingestPayment(workOrderId: string, sourceData: any): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapPayment(this.shopId, workOrderId, sourceData);
      
      const sourceId = sourceData.ID || sourceData.id || sourceData.paymentId;
      if (!sourceId) {
        return {
          success: false,
          entityType: 'payment',
          action: 'error',
          message: 'Payment has no ID',
        };
      }
      
      const result = await sql`
        SELECT id, provenance, version FROM normalized_payments
        WHERE work_order_id = ${workOrderId}
        AND provenance->'sourceIds' @> ${JSON.stringify([{ idValue: String(sourceId) }])}::jsonb
        LIMIT 1
      `;
      const existing = result[0];
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        const existingProvenance = existing.provenance;
        if (!this.options.forceUpdate && existingProvenance?.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'payment',
            entityId: existing.id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await sql`
          UPDATE normalized_payments SET
            status = ${mapped.status || 'paid'},
            method = ${mapped.method || 'other'},
            amount = ${mapped.amount || 0},
            updated_at = NOW(),
            version = ${existing.version + 1}
          WHERE id = ${existing.id}
        `;
        
        return {
          success: true,
          entityType: 'payment',
          entityId: existing.id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityIdPg();
      const sourceIds = [{
        system: this.adapter.sourceSystem,
        idType: 'payment_id',
        idValue: String(sourceId),
        isPrimary: true,
      }];
      const provenance = createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId);
      const softDelete = createSoftDelete();
      
      await sql`
        INSERT INTO normalized_payments (
          id, shop_id, enterprise_id, work_order_id, status, method, amount,
          provenance, soft_delete
        ) VALUES (
          ${newId}, ${this.shopId}, ${this.enterpriseId || null}, ${workOrderId},
          ${mapped.status || 'paid'}, ${mapped.method || 'other'}, ${mapped.amount || 0},
          ${JSON.stringify(provenance)}, ${JSON.stringify(softDelete)}
        )
      `;
      
      return {
        success: true,
        entityType: 'payment',
        entityId: newId,
        action: 'created',
        contentHash,
      };
    } catch (error) {
      return {
        success: false,
        entityType: 'payment',
        action: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  async ingestInspection(workOrderId: string, vehicleId: string, sourceData: any): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapInspection(this.shopId, workOrderId, vehicleId, sourceData);
      
      const sourceId = sourceData.ID || sourceData.id || sourceData.inspectionId;
      if (!sourceId) {
        return {
          success: false,
          entityType: 'inspection',
          action: 'error',
          message: 'Inspection has no ID',
        };
      }
      
      const result = await sql`
        SELECT id, provenance, version FROM normalized_inspections
        WHERE work_order_id = ${workOrderId}
        AND provenance->'sourceIds' @> ${JSON.stringify([{ idValue: String(sourceId) }])}::jsonb
        LIMIT 1
      `;
      const existing = result[0];
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        const existingProvenance = existing.provenance;
        if (!this.options.forceUpdate && existingProvenance?.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'inspection',
            entityId: existing.id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await sql`
          UPDATE normalized_inspections SET
            inspection_type = ${mapped.inspectionType || 'multi_point'},
            status = ${mapped.status || 'completed'},
            updated_at = NOW(),
            version = ${existing.version + 1}
          WHERE id = ${existing.id}
        `;
        
        return {
          success: true,
          entityType: 'inspection',
          entityId: existing.id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityIdPg();
      const sourceIds = [{
        system: this.adapter.sourceSystem,
        idType: 'inspection_id',
        idValue: String(sourceId),
        isPrimary: true,
      }];
      const provenance = createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId);
      const softDelete = createSoftDelete();
      
      await sql`
        INSERT INTO normalized_inspections (
          id, shop_id, enterprise_id, work_order_id, vehicle_id,
          inspection_type, status, provenance, soft_delete
        ) VALUES (
          ${newId}, ${this.shopId}, ${this.enterpriseId || null}, ${workOrderId},
          ${vehicleId || null}, ${mapped.inspectionType || 'multi_point'},
          ${mapped.status || 'completed'}, ${JSON.stringify(provenance)},
          ${JSON.stringify(softDelete)}
        )
      `;
      
      return {
        success: true,
        entityType: 'inspection',
        entityId: newId,
        action: 'created',
        contentHash,
      };
    } catch (error) {
      return {
        success: false,
        entityType: 'inspection',
        action: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  async ingestRecommendation(vehicleId: string, sourceData: any, originWorkOrderId?: string): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapRecommendation(this.shopId, vehicleId, sourceData);
      
      const sourceId = sourceData.ID || sourceData.id || sourceData.recommendationId || 
                       `${originWorkOrderId}-${mapped.title}`;
      
      const result = await sql`
        SELECT id, provenance, version FROM normalized_recommendations
        WHERE vehicle_id = ${vehicleId}
        AND provenance->'sourceIds' @> ${JSON.stringify([{ idValue: String(sourceId) }])}::jsonb
        LIMIT 1
      `;
      const existing = result[0];
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        const existingProvenance = existing.provenance;
        if (!this.options.forceUpdate && existingProvenance?.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'recommendation',
            entityId: existing.id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await sql`
          UPDATE normalized_recommendations SET
            status = ${mapped.status || 'declined'},
            title = ${mapped.title || 'Unknown Recommendation'},
            description = ${mapped.description || null},
            urgency = ${mapped.urgency || 'next_visit'},
            priority = ${mapped.priority || 3},
            updated_at = NOW(),
            version = ${existing.version + 1}
          WHERE id = ${existing.id}
        `;
        
        return {
          success: true,
          entityType: 'recommendation',
          entityId: existing.id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityIdPg();
      const sourceIds = [{
        system: this.adapter.sourceSystem,
        idType: 'recommendation_id',
        idValue: String(sourceId),
        isPrimary: true,
      }];
      const provenance = createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId);
      const softDelete = createSoftDelete();
      
      await sql`
        INSERT INTO normalized_recommendations (
          id, shop_id, enterprise_id, vehicle_id, origin_work_order_id,
          status, title, description, urgency, priority, provenance, soft_delete
        ) VALUES (
          ${newId}, ${this.shopId}, ${this.enterpriseId || null}, ${vehicleId},
          ${originWorkOrderId || null}, ${mapped.status || 'declined'},
          ${mapped.title || 'Unknown Recommendation'}, ${mapped.description || null},
          ${mapped.urgency || 'next_visit'}, ${mapped.priority || 3},
          ${JSON.stringify(provenance)}, ${JSON.stringify(softDelete)}
        )
      `;
      
      return {
        success: true,
        entityType: 'recommendation',
        entityId: newId,
        action: 'created',
        contentHash,
      };
    } catch (error) {
      return {
        success: false,
        entityType: 'recommendation',
        action: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  async ingestWorkOrderWithAllEntities(sourceData: any): Promise<{
    workOrder: IngestionResult;
    payments: IngestionResult[];
    inspections: IngestionResult[];
    recommendations: IngestionResult[];
  }> {
    const workOrderResult = await this.ingestWorkOrder(sourceData);
    
    const payments: IngestionResult[] = [];
    const inspections: IngestionResult[] = [];
    const recommendations: IngestionResult[] = [];
    
    if (workOrderResult.success && workOrderResult.entityId) {
      const workOrderId = workOrderResult.entityId;
      
      const vehicleData = this.adapter.extractVehicleFromWorkOrder(sourceData);
      let vehicleId = '';
      if (vehicleData?.vin) {
        const vehicleResult = await sql`
          SELECT id FROM normalized_vehicles
          WHERE shop_id = ${this.shopId} AND vin = ${vehicleData.vin}
          LIMIT 1
        `;
        vehicleId = vehicleResult[0]?.id || '';
      }
      
      const paymentData = this.adapter.extractPaymentsFromWorkOrder(sourceData);
      for (const payment of paymentData) {
        const result = await this.ingestPayment(workOrderId, payment);
        payments.push(result);
      }
      
      const inspectionData = this.adapter.extractInspectionsFromWorkOrder(sourceData);
      for (const inspection of inspectionData) {
        const result = await this.ingestInspection(workOrderId, vehicleId, inspection);
        inspections.push(result);
      }
      
      const recommendationData = this.adapter.extractRecommendationsFromWorkOrder(sourceData);
      for (const rec of recommendationData) {
        const result = await this.ingestRecommendation(vehicleId, rec, workOrderId);
        recommendations.push(result);
      }
    }
    
    return {
      workOrder: workOrderResult,
      payments,
      inspections,
      recommendations,
    };
  }
  
  async ingestWorkOrderBatch(workOrders: any[]): Promise<IngestionBatchResult> {
    const results: IngestionResult[] = [];
    let created = 0, updated = 0, skipped = 0, errors = 0;
    
    for (const wo of workOrders) {
      const result = await this.ingestWorkOrder(wo);
      results.push(result);
      
      switch (result.action) {
        case 'created': created++; break;
        case 'updated': updated++; break;
        case 'skipped': skipped++; break;
        case 'error': errors++; break;
      }
    }
    
    return {
      total: workOrders.length,
      created,
      updated,
      skipped,
      errors,
      results,
    };
  }
  
  async ingestWorkOrderBatchWithAllEntities(workOrders: any[]): Promise<{
    workOrders: IngestionBatchResult;
    payments: { created: number; updated: number; skipped: number; errors: number };
    inspections: { created: number; updated: number; skipped: number; errors: number };
    recommendations: { created: number; updated: number; skipped: number; errors: number };
  }> {
    const workOrderResults: IngestionResult[] = [];
    let woCreated = 0, woUpdated = 0, woSkipped = 0, woErrors = 0;
    let payCreated = 0, payUpdated = 0, paySkipped = 0, payErrors = 0;
    let inspCreated = 0, inspUpdated = 0, inspSkipped = 0, inspErrors = 0;
    let recCreated = 0, recUpdated = 0, recSkipped = 0, recErrors = 0;
    
    for (const wo of workOrders) {
      const result = await this.ingestWorkOrderWithAllEntities(wo);
      workOrderResults.push(result.workOrder);
      
      switch (result.workOrder.action) {
        case 'created': woCreated++; break;
        case 'updated': woUpdated++; break;
        case 'skipped': woSkipped++; break;
        case 'error': woErrors++; break;
      }
      
      for (const pay of result.payments) {
        switch (pay.action) {
          case 'created': payCreated++; break;
          case 'updated': payUpdated++; break;
          case 'skipped': paySkipped++; break;
          case 'error': payErrors++; break;
        }
      }
      
      for (const insp of result.inspections) {
        switch (insp.action) {
          case 'created': inspCreated++; break;
          case 'updated': inspUpdated++; break;
          case 'skipped': inspSkipped++; break;
          case 'error': inspErrors++; break;
        }
      }
      
      for (const rec of result.recommendations) {
        switch (rec.action) {
          case 'created': recCreated++; break;
          case 'updated': recUpdated++; break;
          case 'skipped': recSkipped++; break;
          case 'error': recErrors++; break;
        }
      }
    }
    
    return {
      workOrders: {
        total: workOrders.length,
        created: woCreated,
        updated: woUpdated,
        skipped: woSkipped,
        errors: woErrors,
        results: workOrderResults,
      },
      payments: {
        created: payCreated,
        updated: payUpdated,
        skipped: paySkipped,
        errors: payErrors,
      },
      inspections: {
        created: inspCreated,
        updated: inspUpdated,
        skipped: inspSkipped,
        errors: inspErrors,
      },
      recommendations: {
        created: recCreated,
        updated: recUpdated,
        skipped: recSkipped,
        errors: recErrors,
      },
    };
  }
  
  private async writeToJobIndex(sourceData: any, serviceJobs: Partial<NormalizedServiceJob>[]): Promise<void> {
    const vehicle = this.adapter.extractVehicleFromWorkOrder(sourceData);
    const sourceIds = this.adapter.getSourceIds(sourceData);
    const workOrderId = sourceIds.find(s => s.isPrimary)?.idValue || sourceData.ID || sourceData.id;
    
    for (const job of serviceJobs) {
      if (!job.title) continue;
      
      const contentHash = generateContentHash({
        title: job.title,
        hours: job.laborHoursBilled,
        total: job.total,
      });
      
      const existing = await sql`
        SELECT id, content_hash FROM job_index
        WHERE shop_id = ${this.shopId}
        AND source_system = ${this.adapter.sourceSystem}
        AND work_order_id = ${String(workOrderId)}
        AND title = ${job.title}
        LIMIT 1
      `;
      
      if (existing[0] && existing[0].content_hash === contentHash) {
        continue;
      }
      
      const closedDate = sourceData.ClosedDate || sourceData.InvoiceDate || sourceData.postedDate || sourceData.completedDate;
      
      if (existing[0]) {
        await sql`
          UPDATE job_index SET
            work_order_number = ${sourceData.InvoiceNumber || sourceData.repairOrderNumber || null},
            description = ${job.description || null},
            hours = ${job.laborHoursBilled ?? job.laborHoursActual ?? null},
            total = ${job.total ?? null},
            labor_total = ${job.laborTotal ?? null},
            parts_total = ${job.partsTotal ?? null},
            vin = ${vehicle?.vin || null},
            year = ${vehicle?.year || null},
            make = ${vehicle?.make || null},
            model = ${vehicle?.model || null},
            engine = ${vehicle?.engineDescription || null},
            closed_date = ${closedDate || null},
            content_hash = ${contentHash},
            logic_version = 3,
            updated_at = NOW()
          WHERE id = ${existing[0].id}
        `;
      } else {
        await sql`
          INSERT INTO job_index (
            shop_id, enterprise_id, source_system, work_order_id, work_order_number,
            title, description, hours, total, labor_total, parts_total,
            vin, year, make, model, engine, closed_date, content_hash, logic_version
          ) VALUES (
            ${this.shopId}, ${this.enterpriseId || null}, ${this.adapter.sourceSystem},
            ${String(workOrderId)}, ${sourceData.InvoiceNumber || sourceData.repairOrderNumber || null},
            ${job.title}, ${job.description || null},
            ${job.laborHoursBilled ?? job.laborHoursActual ?? null},
            ${job.total ?? null}, ${job.laborTotal ?? null}, ${job.partsTotal ?? null},
            ${vehicle?.vin || null}, ${vehicle?.year || null}, ${vehicle?.make || null},
            ${vehicle?.model || null}, ${vehicle?.engineDescription || null},
            ${closedDate || null}, ${contentHash}, 3
          )
        `;
      }
    }
  }
  
  private async writeToRepairPatterns(sourceData: any, serviceJobs: Partial<NormalizedServiceJob>[]): Promise<void> {
    const vehicle = this.adapter.extractVehicleFromWorkOrder(sourceData);
    
    if (!vehicle?.year || !vehicle?.make || !vehicle?.model) {
      return;
    }
    
    const mileage = sourceData.MileageIn || sourceData.MileageOut || 
                    sourceData.mileageIn || sourceData.mileageOut ||
                    sourceData.odometerIn || sourceData.odometerOut;
    
    if (!mileage || mileage < 1000) {
      return;
    }
    
    const closedDate = sourceData.ClosedDate || sourceData.InvoiceDate || 
                       sourceData.postedDate || sourceData.completedDate;
    const performedDate = closedDate ? new Date(closedDate) : new Date();
    
    for (const job of serviceJobs) {
      if (!job.title || job.title.length < 3) continue;
      
      const lowerTitle = job.title.toLowerCase();
      if (lowerTitle.includes('diagnostic') || lowerTitle.includes('inspection only')) {
        continue;
      }
      
      try {
        await updateRepairPattern({
          shopId: this.shopId,
          enterpriseId: this.enterpriseId,
          year: vehicle.year,
          make: vehicle.make,
          model: vehicle.model,
          mileage,
          jobTitle: job.title,
          laborAmount: job.laborTotal || 0,
          partsAmount: job.partsTotal || 0,
          totalAmount: job.total || 0,
          laborHours: job.laborHoursBilled || job.laborHoursActual || 0,
          vin: vehicle.vin,
          performedDate,
        });
      } catch (err) {
        console.error('Failed to update repair pattern:', err);
      }
    }
  }
  
  private mergeSourceIds(existing: any[], incoming: any[]): any[] {
    const merged = [...existing];
    
    for (const inc of incoming) {
      const exists = merged.some(
        e => e.system === inc.system && e.idType === inc.idType && e.idValue === inc.idValue
      );
      if (!exists) {
        merged.push(inc);
      }
    }
    
    return merged;
  }
  
  private async createAuditEntry(
    entityType: string,
    entityId: string,
    changeType: 'create' | 'update' | 'delete',
    changes: any
  ): Promise<void> {
    const newId = generateEntityIdPg();
    
    const actor = {
      type: 'integration',
      sourceSystem: this.adapter.sourceSystem,
    };
    
    const changesArray = changeType === 'create' 
      ? [{ field: '*', oldValue: null, newValue: changes }]
      : Object.entries(changes).map(([field, newValue]) => ({
          field,
          oldValue: undefined,
          newValue,
        }));
    
    const metadata = {
      shopId: this.shopId,
      syncRunId: this.options.syncRunId,
    };
    
    await sql`
      INSERT INTO normalized_audit_log (id, entity_type, entity_id, change_type, actor, changes, metadata)
      VALUES (${newId}, ${entityType}, ${entityId}, ${changeType}, ${JSON.stringify(actor)}, ${JSON.stringify(changesArray)}, ${JSON.stringify(metadata)})
    `;
  }
}

export function createIngestionServicePg(
  sourceSystem: SourceSystem,
  shopId: number,
  enterpriseId?: string,
  options?: IngestionOptions
): NormalizedIngestionServicePg {
  return new NormalizedIngestionServicePg(sourceSystem, shopId, enterpriseId, options);
}
