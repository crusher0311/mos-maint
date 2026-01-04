/**
 * MOS Normalized Data Ingestion Service
 * 
 * Handles dual-write to both legacy job_index and new normalized collections.
 * Provides change detection, deduplication, and audit logging.
 */

import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import {
  SourceSystem,
  NormalizedVehicle,
  NormalizedCustomer,
  NormalizedWorkOrder,
  NormalizedServiceJob,
  NormalizedLineItem,
  NormalizedPayment,
  NormalizedInspection,
  NormalizedRecommendation,
  Provenance,
  SoftDelete,
  AuditEntry,
  NORMALIZED_COLLECTIONS,
} from './normalized-schema';
import {
  getAdapter,
  generateContentHash,
  generateEntityId,
  createProvenance,
  createSoftDelete,
  INormalizedAdapter,
} from './normalized-adapters';
import { updateRepairPattern } from './repair-patterns';

// =============================================================================
// TYPES
// =============================================================================

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

// =============================================================================
// NORMALIZED INGESTION SERVICE
// =============================================================================

export class NormalizedIngestionService {
  private db: Db;
  private adapter: INormalizedAdapter;
  private shopId: number;
  private enterpriseId?: number;
  private options: IngestionOptions;
  
  constructor(
    db: Db,
    sourceSystem: SourceSystem,
    shopId: number,
    enterpriseId?: number,
    options: IngestionOptions = {}
  ) {
    const adapter = getAdapter(sourceSystem);
    if (!adapter) {
      throw new Error(`No adapter found for source system: ${sourceSystem}`);
    }
    
    this.db = db;
    this.adapter = adapter;
    this.shopId = shopId;
    this.enterpriseId = enterpriseId;
    this.options = {
      createAuditLog: true,
      dualWriteToJobIndex: true,
      ...options,
    };
  }
  
  // ---------------------------------------------------------------------------
  // HELPER: Sanitize raw payload for MongoDB storage
  // ---------------------------------------------------------------------------
  
  private sanitizeRawPayload(data: any): any {
    try {
      return JSON.parse(JSON.stringify(data));
    } catch {
      return { error: 'Failed to serialize raw payload', timestamp: new Date().toISOString() };
    }
  }
  
  // ---------------------------------------------------------------------------
  // VEHICLE INGESTION
  // ---------------------------------------------------------------------------
  
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
      
      const collection = this.db.collection<NormalizedVehicle>(NORMALIZED_COLLECTIONS.vehicles);
      
      const existingQuery: any = { shopId: this.shopId };
      if (mapped.vin) {
        existingQuery.vin = mapped.vin;
      } else {
        existingQuery['provenance.sourceIds'] = { $elemMatch: sourceIds[0] };
      }
      
      const existing = await collection.findOne(existingQuery);
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'vehicle',
            entityId: existing._id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        const updatedProvenance: Provenance = {
          ...existing.provenance,
          lastSeenAt: new Date(),
          lastSyncedAt: new Date(),
          syncRunId: this.options.syncRunId,
          contentHash,
          sourceIds: this.mergeSourceIds(existing.provenance.sourceIds, sourceIds),
        };
        
        await collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              provenance: updatedProvenance,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        );
        
        if (this.options.createAuditLog) {
          await this.createAuditEntry('vehicle', existing._id, 'update', mapped);
        }
        
        return {
          success: true,
          entityType: 'vehicle',
          entityId: existing._id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityId();
      const now = new Date();
      
      const newVehicle: NormalizedVehicle = {
        _id: newId,
        ...mapped,
        shopId: this.shopId,
        enterpriseId: this.enterpriseId,
        provenance: createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId),
        softDelete: createSoftDelete(),
        createdAt: now,
        updatedAt: now,
        version: 1,
        vinDecoded: false,
        odometerUnit: mapped.odometerUnit || 'miles',
        odometerHistory: [],
        isFleet: false,
        tags: [],
        customFields: {},
        customerIds: [],
        totalServicesCount: 0,
        totalServicesAmount: 0,
      } as NormalizedVehicle;
      
      await collection.insertOne(newVehicle);
      
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
  
  // ---------------------------------------------------------------------------
  // CUSTOMER INGESTION
  // ---------------------------------------------------------------------------
  
  async ingestCustomer(sourceData: any): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapCustomer(this.shopId, sourceData, this.enterpriseId);
      const sourceIds = this.adapter.getSourceIds(sourceData);
      
      const collection = this.db.collection<NormalizedCustomer>(NORMALIZED_COLLECTIONS.customers);
      
      const existingQuery: any = {
        shopId: this.shopId,
        'provenance.sourceIds': { $elemMatch: sourceIds[0] },
      };
      
      const existing = await collection.findOne(existingQuery);
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'customer',
            entityId: existing._id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        const updatedProvenance: Provenance = {
          ...existing.provenance,
          lastSeenAt: new Date(),
          lastSyncedAt: new Date(),
          syncRunId: this.options.syncRunId,
          contentHash,
          sourceIds: this.mergeSourceIds(existing.provenance.sourceIds, sourceIds),
        };
        
        await collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              provenance: updatedProvenance,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        );
        
        if (this.options.createAuditLog) {
          await this.createAuditEntry('customer', existing._id, 'update', mapped);
        }
        
        return {
          success: true,
          entityType: 'customer',
          entityId: existing._id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityId();
      const now = new Date();
      
      const newCustomer: NormalizedCustomer = {
        _id: newId,
        ...mapped,
        shopId: this.shopId,
        enterpriseId: this.enterpriseId,
        provenance: createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId),
        softDelete: createSoftDelete(),
        createdAt: now,
        updatedAt: now,
        version: 1,
        customerType: mapped.customerType || 'individual',
        contacts: [],
        taxExempt: false,
        arBalance: 0,
        marketingConsent: false,
        smsConsent: false,
        emailConsent: false,
        tags: [],
        customFields: {},
        vehicleIds: [],
        totalVisits: 0,
        totalSpent: 0,
        averageTicket: 0,
      } as NormalizedCustomer;
      
      await collection.insertOne(newCustomer);
      
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
  
  // ---------------------------------------------------------------------------
  // WORK ORDER INGESTION (includes embedded service jobs)
  // ---------------------------------------------------------------------------
  
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
      
      const collection = this.db.collection<NormalizedWorkOrder>(NORMALIZED_COLLECTIONS.workOrders);
      
      const existingQuery: any = {
        shopId: this.shopId,
        'provenance.sourceIds': { $elemMatch: sourceIds[0] },
      };
      
      const existing = await collection.findOne(existingQuery);
      
      const contentHash = generateContentHash(mapped);
      
      const serviceJobs = this.adapter.extractServiceJobsFromWorkOrder(sourceData);
      
      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'work_order',
            entityId: existing._id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        const updatedProvenance: Provenance = {
          ...existing.provenance,
          lastSeenAt: new Date(),
          lastSyncedAt: new Date(),
          syncRunId: this.options.syncRunId,
          contentHash,
          sourceIds: this.mergeSourceIds(existing.provenance.sourceIds, sourceIds),
        };
        
        await collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              vehicleId: vehicleId || existing.vehicleId,
              customerId: customerId || existing.customerId,
              serviceJobs: serviceJobs as NormalizedServiceJob[],
              provenance: updatedProvenance,
              updatedAt: new Date(),
              version: existing.version + 1,
              rawPayload: this.sanitizeRawPayload(sourceData.rawPayload || sourceData),
            },
          }
        );
        
        if (this.options.dualWriteToJobIndex && serviceJobs.length > 0) {
          await this.writeToJobIndex(sourceData, serviceJobs);
        }
        
        if (this.options.dualWriteToRepairPatterns && serviceJobs.length > 0) {
          await this.writeToRepairPatterns(sourceData, serviceJobs);
        }
        
        if (this.options.createAuditLog) {
          await this.createAuditEntry('work_order', existing._id, 'update', mapped);
        }
        
        return {
          success: true,
          entityType: 'work_order',
          entityId: existing._id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityId();
      const now = new Date();
      
      const newWorkOrder: NormalizedWorkOrder = {
        _id: newId,
        ...mapped,
        shopId: this.shopId,
        enterpriseId: this.enterpriseId,
        vehicleId: vehicleId || '',
        customerId,
        provenance: createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId),
        softDelete: createSoftDelete(),
        createdAt: now,
        updatedAt: now,
        version: 1,
        workOrderNumber: mapped.workOrderNumber || String(sourceIds[0]?.idValue),
        workOrderType: mapped.workOrderType || 'repair',
        status: mapped.status || 'closed',
        statusHistory: [],
        vehicle: mapped.vehicle || { vehicleId: '' },
        odometerUnit: 'miles',
        technicians: [],
        serviceJobs: serviceJobs as NormalizedServiceJob[],
        inspections: [],
        recommendations: [],
        subtotal: mapped.subtotal || 0,
        taxTotal: mapped.taxTotal || 0,
        discountTotal: mapped.discountTotal || 0,
        grandTotal: mapped.grandTotal || 0,
        laborTotal: mapped.laborTotal || 0,
        partsTotal: mapped.partsTotal || 0,
        subletTotal: mapped.subletTotal || 0,
        feesTotal: mapped.feesTotal || 0,
        laborHoursTotal: mapped.laborHoursTotal || 0,
        laborHoursBilled: mapped.laborHoursBilled || 0,
        payments: [],
        balanceDue: mapped.balanceDue || 0,
        isWarranty: false,
        isInternal: false,
        isComeback: false,
        tags: [],
        customFields: {},
        rawPayload: this.sanitizeRawPayload(sourceData.rawPayload || sourceData),
      } as NormalizedWorkOrder;
      
      await collection.insertOne(newWorkOrder);
      
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
  
  // ---------------------------------------------------------------------------
  // SERVICE JOB INGESTION (standalone)
  // ---------------------------------------------------------------------------
  
  async ingestServiceJob(workOrderId: string, sourceData: any): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapServiceJob(this.shopId, workOrderId, sourceData);
      
      const collection = this.db.collection<NormalizedServiceJob>(NORMALIZED_COLLECTIONS.serviceJobs);
      
      const sourceId = sourceData.ID || sourceData.id;
      if (!sourceId) {
        return {
          success: false,
          entityType: 'service_job',
          action: 'error',
          message: 'Service job has no ID',
        };
      }
      
      const existingQuery = {
        workOrderId,
        'provenance.sourceIds.idValue': String(sourceId),
      };
      
      const existing = await collection.findOne(existingQuery);
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'service_job',
            entityId: existing._id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        );
        
        return {
          success: true,
          entityType: 'service_job',
          entityId: existing._id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityId();
      const now = new Date();
      const sourceIds = [{
        system: this.adapter.sourceSystem,
        idType: 'service_job_id',
        idValue: String(sourceId),
        isPrimary: true,
      }];
      
      const newServiceJob: NormalizedServiceJob = {
        _id: newId,
        ...mapped,
        shopId: this.shopId,
        enterpriseId: this.enterpriseId,
        workOrderId,
        provenance: createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId),
        softDelete: createSoftDelete(),
        createdAt: now,
        updatedAt: now,
        version: 1,
        sequence: mapped.sequence || 0,
        jobType: mapped.jobType || 'custom',
        status: mapped.status || 'completed',
        statusHistory: [],
        title: mapped.title || 'Unknown Service',
        laborOperationCodes: [],
        lineItems: [],
        laborTotal: mapped.laborTotal || 0,
        partsTotal: mapped.partsTotal || 0,
        subletTotal: mapped.subletTotal || 0,
        feesTotal: mapped.feesTotal || 0,
        discountTotal: mapped.discountTotal || 0,
        total: mapped.total || 0,
        isWarranty: false,
        isSublet: false,
        componentsCodes: [],
        tags: [],
        customFields: {},
      } as NormalizedServiceJob;
      
      await collection.insertOne(newServiceJob);
      
      return {
        success: true,
        entityType: 'service_job',
        entityId: newId,
        action: 'created',
        contentHash,
      };
    } catch (error) {
      return {
        success: false,
        entityType: 'service_job',
        action: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
  
  // ---------------------------------------------------------------------------
  // PAYMENT INGESTION
  // ---------------------------------------------------------------------------
  
  async ingestPayment(workOrderId: string, sourceData: any): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapPayment(this.shopId, workOrderId, sourceData);
      
      const collection = this.db.collection<NormalizedPayment>(NORMALIZED_COLLECTIONS.payments);
      
      const sourceId = sourceData.ID || sourceData.id || sourceData.paymentId;
      if (!sourceId) {
        return {
          success: false,
          entityType: 'payment',
          action: 'error',
          message: 'Payment has no ID',
        };
      }
      
      const existingQuery = {
        workOrderId,
        'provenance.sourceIds.idValue': String(sourceId),
      };
      
      const existing = await collection.findOne(existingQuery);
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'payment',
            entityId: existing._id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        );
        
        return {
          success: true,
          entityType: 'payment',
          entityId: existing._id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityId();
      const now = new Date();
      const sourceIds = [{
        system: this.adapter.sourceSystem,
        idType: 'payment_id',
        idValue: String(sourceId),
        isPrimary: true,
      }];
      
      const newPayment: NormalizedPayment = {
        _id: newId,
        ...mapped,
        shopId: this.shopId,
        enterpriseId: this.enterpriseId,
        workOrderId,
        provenance: createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId),
        softDelete: createSoftDelete(),
        createdAt: now,
        updatedAt: now,
        version: 1,
        status: mapped.status || 'paid',
        method: mapped.method || 'other',
        amount: mapped.amount || 0,
        customFields: {},
      } as NormalizedPayment;
      
      await collection.insertOne(newPayment);
      
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
  
  // ---------------------------------------------------------------------------
  // INSPECTION INGESTION
  // ---------------------------------------------------------------------------
  
  async ingestInspection(workOrderId: string, vehicleId: string, sourceData: any): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapInspection(this.shopId, workOrderId, vehicleId, sourceData);
      
      const collection = this.db.collection<NormalizedInspection>(NORMALIZED_COLLECTIONS.inspections);
      
      const sourceId = sourceData.ID || sourceData.id || sourceData.inspectionId;
      if (!sourceId) {
        return {
          success: false,
          entityType: 'inspection',
          action: 'error',
          message: 'Inspection has no ID',
        };
      }
      
      const existingQuery = {
        workOrderId,
        'provenance.sourceIds.idValue': String(sourceId),
      };
      
      const existing = await collection.findOne(existingQuery);
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'inspection',
            entityId: existing._id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        );
        
        return {
          success: true,
          entityType: 'inspection',
          entityId: existing._id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityId();
      const now = new Date();
      const sourceIds = [{
        system: this.adapter.sourceSystem,
        idType: 'inspection_id',
        idValue: String(sourceId),
        isPrimary: true,
      }];
      
      const newInspection: NormalizedInspection = {
        _id: newId,
        ...mapped,
        shopId: this.shopId,
        enterpriseId: this.enterpriseId,
        workOrderId,
        vehicleId,
        provenance: createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId),
        softDelete: createSoftDelete(),
        createdAt: now,
        updatedAt: now,
        version: 1,
        inspectionType: mapped.inspectionType || 'multi_point',
        status: mapped.status || 'completed',
        sections: [],
        mediaItems: [],
        recommendations: [],
        customFields: {},
      } as NormalizedInspection;
      
      await collection.insertOne(newInspection);
      
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
  
  // ---------------------------------------------------------------------------
  // RECOMMENDATION INGESTION
  // ---------------------------------------------------------------------------
  
  async ingestRecommendation(vehicleId: string, sourceData: any, originWorkOrderId?: string): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapRecommendation(this.shopId, vehicleId, sourceData);
      
      const collection = this.db.collection<NormalizedRecommendation>(NORMALIZED_COLLECTIONS.recommendations);
      
      const sourceId = sourceData.ID || sourceData.id || sourceData.recommendationId || 
                       `${originWorkOrderId}-${mapped.title}`;
      
      const existingQuery = {
        vehicleId,
        'provenance.sourceIds.idValue': String(sourceId),
      };
      
      const existing = await collection.findOne(existingQuery);
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'recommendation',
            entityId: existing._id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        await collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        );
        
        return {
          success: true,
          entityType: 'recommendation',
          entityId: existing._id,
          action: 'updated',
          contentHash,
        };
      }
      
      const newId = generateEntityId();
      const now = new Date();
      const sourceIds = [{
        system: this.adapter.sourceSystem,
        idType: 'recommendation_id',
        idValue: String(sourceId),
        isPrimary: true,
      }];
      
      const newRecommendation: NormalizedRecommendation = {
        _id: newId,
        ...mapped,
        shopId: this.shopId,
        enterpriseId: this.enterpriseId,
        vehicleId,
        originWorkOrderId,
        provenance: createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId),
        softDelete: createSoftDelete(),
        createdAt: now,
        updatedAt: now,
        version: 1,
        status: mapped.status || 'declined',
        statusHistory: [],
        title: mapped.title || 'Unknown Recommendation',
        urgency: mapped.urgency || 'next_visit',
        priority: mapped.priority || 3,
        followUpSent: false,
        mediaIds: [],
        customFields: {},
      } as NormalizedRecommendation;
      
      await collection.insertOne(newRecommendation);
      
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
  
  // ---------------------------------------------------------------------------
  // INGEST ALL ENTITIES FROM WORK ORDER
  // ---------------------------------------------------------------------------
  
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
      const vehicleQuery: any = { shopId: this.shopId };
      if (vehicleData?.vin) {
        vehicleQuery.vin = vehicleData.vin;
      }
      const vehicleDoc = await this.db.collection(NORMALIZED_COLLECTIONS.vehicles).findOne(vehicleQuery);
      const vehicleId = vehicleDoc?._id ? String(vehicleDoc._id) : '';
      
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
  
  // ---------------------------------------------------------------------------
  // BATCH INGESTION
  // ---------------------------------------------------------------------------
  
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
  
  // ---------------------------------------------------------------------------
  // DUAL WRITE TO JOB INDEX (for backward compatibility)
  // ---------------------------------------------------------------------------
  
  private async writeToJobIndex(sourceData: any, serviceJobs: Partial<NormalizedServiceJob>[]): Promise<void> {
    const jobIndexCollection = this.db.collection('job_index');
    
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
      
      const existing = await jobIndexCollection.findOne({
        shopId: this.shopId,
        sourceSystem: this.adapter.sourceSystem,
        workOrderId: String(workOrderId),
        title: job.title,
      });
      
      if (existing && existing.contentHash === contentHash) {
        continue;
      }
      
      const jobIndexEntry = {
        shopId: this.shopId,
        enterpriseId: this.enterpriseId,
        sourceSystem: this.adapter.sourceSystem,
        workOrderId: String(workOrderId),
        workOrderNumber: sourceData.InvoiceNumber || sourceData.repairOrderNumber,
        title: job.title,
        description: job.description,
        hours: job.laborHoursBilled ?? job.laborHoursActual ?? null,
        total: job.total ?? null,
        laborTotal: job.laborTotal ?? null,
        partsTotal: job.partsTotal ?? null,
        vin: vehicle?.vin,
        year: vehicle?.year,
        make: vehicle?.make,
        model: vehicle?.model,
        engine: vehicle?.engineDescription,
        closedDate: sourceData.ClosedDate || sourceData.InvoiceDate || sourceData.postedDate || sourceData.completedDate,
        contentHash,
        logicVersion: 3,
        indexedAt: new Date(),
        updatedAt: new Date(),
      };
      
      if (existing) {
        await jobIndexCollection.updateOne(
          { _id: existing._id },
          { $set: jobIndexEntry }
        );
      } else {
        await jobIndexCollection.insertOne({
          ...jobIndexEntry,
          createdAt: new Date(),
        });
      }
    }
  }
  
  // ---------------------------------------------------------------------------
  // DUAL WRITE TO REPAIR PATTERNS (for shop pattern learning)
  // ---------------------------------------------------------------------------
  
  private async writeToRepairPatterns(sourceData: any, serviceJobs: Partial<NormalizedServiceJob>[]): Promise<void> {
    const vehicle = this.adapter.extractVehicleFromWorkOrder(sourceData);
    
    // Skip if missing required vehicle info
    if (!vehicle?.year || !vehicle?.make || !vehicle?.model) {
      return;
    }
    
    // Get mileage from work order
    const mileage = sourceData.MileageIn || sourceData.MileageOut || 
                    sourceData.mileageIn || sourceData.mileageOut ||
                    sourceData.odometerIn || sourceData.odometerOut;
    
    if (!mileage || mileage < 1000) {
      return; // Skip if no valid mileage
    }
    
    const closedDate = sourceData.ClosedDate || sourceData.InvoiceDate || 
                       sourceData.postedDate || sourceData.completedDate;
    const performedDate = closedDate ? new Date(closedDate) : new Date();
    
    for (const job of serviceJobs) {
      if (!job.title || job.title.length < 3) continue;
      
      // Skip diagnostic or inspection-only jobs
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
        // Log but don't fail the main ingestion
        console.error('Failed to update repair pattern:', err);
      }
    }
  }
  
  // ---------------------------------------------------------------------------
  // HELPER METHODS
  // ---------------------------------------------------------------------------
  
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
    const auditCollection = this.db.collection<AuditEntry>(NORMALIZED_COLLECTIONS.audit);
    
    const entry: AuditEntry = {
      _id: generateEntityId(),
      entityType,
      entityId,
      changeType,
      actor: {
        type: 'integration',
        sourceSystem: this.adapter.sourceSystem,
      },
      timestamp: new Date(),
      changes: changeType === 'create' 
        ? [{ field: '*', oldValue: null, newValue: changes }]
        : Object.entries(changes).map(([field, newValue]) => ({
            field,
            oldValue: undefined,
            newValue,
          })),
      metadata: {
        shopId: this.shopId,
        syncRunId: this.options.syncRunId,
      },
    };
    
    await auditCollection.insertOne(entry);
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export function createIngestionService(
  db: Db,
  sourceSystem: SourceSystem,
  shopId: number,
  enterpriseId?: number,
  options?: IngestionOptions
): NormalizedIngestionService {
  return new NormalizedIngestionService(db, sourceSystem, shopId, enterpriseId, options);
}
