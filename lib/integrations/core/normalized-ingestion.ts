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
} from '@/lib/normalized-schema';
import {
  getAdapter,
  generateContentHash,
  generateEntityId,
  createProvenance,
  createSoftDelete,
  INormalizedAdapter,
} from './normalized-adapter';
import { updateRepairPattern } from '@/lib/repair-patterns';
import pLimit from 'p-limit';
import { SupabaseDualWriter } from '@/lib/supabase-dual-writer';
import { shouldShadowWriteMongo } from './normalized-write-mode';
import { bumpMongoWrites, bumpPgWrites } from '@/lib/backfill-metrics/write-counters';
import { enrichVinWithAces, enrichVinsWithAcesAllVins, extractShopWarePcdb, extractTekmetricPcdb, type AcesEnrichment } from '@/lib/job-index-aces';

// Bounded concurrency for per-entity child writes during work-order
// ingestion (task #946). High enough to collapse the serial round-trip
// chain on dense work orders, low enough not to saturate the shared
// PG/Mongo pools while a fleet of backfill chunks runs concurrently.
const INGESTION_WRITE_CONCURRENCY = Math.max(
  1,
  Number(process.env.NORMALIZED_INGEST_WRITE_CONCURRENCY) || 5,
);

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
  dualWriteToSupabase?: boolean;
  /**
   * Code path that triggered this ingestion (e.g. "poll", "webhook", "backfill").
   * When set, each work_order doc gets two stamps:
   *   - `firstIngestedVia` / `firstIngestedAt`: written ONCE the first time we
   *     see the work order; never overwritten on subsequent ingestions.
   *   - `lastIngestedVia` / `lastIngestedAt`: overwritten on every ingestion.
   * Powers the soak metric for the trust-the-webhooks migration — see
   * TEKMETRIC_5K_SCALING_PLAN.md (Step 2 Phase B).
   */
  ingestionVia?: string;
}

// =============================================================================
// NORMALIZED INGESTION SERVICE
// =============================================================================

export class NormalizedIngestionService {
  private db: Db;
  private adapter: INormalizedAdapter;
  private shopId: number;
  private enterpriseId?: string;
  private options: IngestionOptions;
  private supabaseDualWriter: SupabaseDualWriter | null = null;
  /**
   * Per-batch ACES cache. Populated once at the top of
   * `ingestWorkOrderBatchWithAllEntities` with a SINGLE bulk DataOne lookup
   * for every VIN in the batch, then read by `writeToJobIndex` so the
   * per-work-order dual-write no longer fires one DataOne round-trip each
   * (~400 sequential lookups per dense backfill chunk → 1). `null` outside a
   * batch — in that case `writeToJobIndex` falls back to the per-VIN lookup,
   * preserving behaviour for single-WO callers (webhooks, dashboard replay,
   * the standalone rebuild script). Values come from the SAME
   * `acesFromDecoded` path as the per-VIN call, so job_index content (and its
   * contentHash, which doesn't include ACES anyway) is identical — no churn.
   *
   * NOTE: this is per-instance mutable state. A service instance must not run
   * two batches concurrently. Safe today because `createIngestionService`
   * returns a FRESH instance per chunk and a shop's chunks are serialized by
   * an in-flight lock; don't share one instance across concurrent batches.
   */
  private _acesBatchCache: Map<string, AcesEnrichment> | null = null;
  
  constructor(
    db: Db,
    sourceSystem: SourceSystem,
    shopId: number,
    enterpriseId?: string,
    options: IngestionOptions = {},
    /**
     * Task #382 — Optional explicit adapter override for tooling that
     * already holds a typed adapter instance (e.g. the historical rebuild
     * script in scripts/backfill-job-index-aces.ts feeds the Shop-Ware
     * adapter directly so it can call writeToJobIndex without re-running
     * the full normalize pipeline). Bypasses the registry lookup but still
     * validates the adapter is non-null. Production sync code paths must
     * leave this undefined and rely on the registry.
     */
    adapterOverride?: INormalizedAdapter,
  ) {
    const adapter = adapterOverride ?? getAdapter(sourceSystem);
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
      dualWriteToSupabase: true,
      ...options,
    };

    if (this.options.dualWriteToSupabase) {
      try {
        // task #344 (W3a): the previous `require('./db/drizzle')` resolved
        // to `lib/integrations/core/db/drizzle`, which does not exist —
        // every construction silently fell into the catch and left
        // `supabaseDualWriter` null. Before the polarity flip that just
        // meant PG mirroring quietly never happened; after the flip it
        // would fail every ingest call. Use the correct path that the
        // rest of the codebase imports from.
        const { getDb: getPgDb } = require('../../db/drizzle');
        this.supabaseDualWriter = new SupabaseDualWriter(getPgDb());
      } catch (err) {
        console.error('[PgCanonical] Failed to initialize Postgres writer:', err instanceof Error ? err.message : err);
      }
    }
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
      
      // task #552 (W3a cutover): PG-canonical change-detection. Mongo is only
      // consulted as a fallback while shadow writes are still on, so the same
      // code is correct before AND after WRITE_MONGO_NORMALIZED=0.
      const existing =
        (this.supabaseDualWriter
          ? await this.supabaseDualWriter.findVehicleByNaturalKey(this.shopId, mapped.vin, sourceIds[0])
          : null) ??
        (shouldShadowWriteMongo() ? await collection.findOne(existingQuery) : null);
      
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
        
        // task #344 (W3a): PG canonical first; Mongo shadow after.
        await this.dualWriteToSupabase('vehicle', existing._id, 'update', () =>
          this.supabaseDualWriter!.upsertVehicle({ ...mapped, _id: existing._id, shopId: this.shopId, enterpriseId: this.enterpriseId, provenance: updatedProvenance, softDelete: existing.softDelete, version: existing.version + 1, createdAt: existing.createdAt, updatedAt: new Date() })
        );
        await this.shadowWriteMongo('vehicle', () => collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              provenance: updatedProvenance,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        ));
        
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
      
      // task #344 (W3a): PG canonical first; Mongo shadow after.
      await this.dualWriteToSupabase('vehicle', newId, 'create', () =>
        this.supabaseDualWriter!.upsertVehicle(newVehicle)
      );
      await this.shadowWriteMongo('vehicle', () => collection.insertOne(newVehicle));
      
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
      
      // task #552 (W3a cutover): PG-canonical change-detection, Mongo fallback
      // only while shadow writes are on.
      const existing =
        (this.supabaseDualWriter
          ? await this.supabaseDualWriter.findCustomerByNaturalKey(this.shopId, sourceIds[0])
          : null) ??
        (shouldShadowWriteMongo() ? await collection.findOne(existingQuery) : null);
      
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
        
        // task #344 (W3a): PG canonical first; Mongo shadow after.
        await this.dualWriteToSupabase('customer', existing._id, 'update', () =>
          this.supabaseDualWriter!.upsertCustomer({ ...mapped, _id: existing._id, shopId: this.shopId, enterpriseId: this.enterpriseId, provenance: updatedProvenance, softDelete: existing.softDelete, version: existing.version + 1, createdAt: existing.createdAt, updatedAt: new Date() })
        );
        await this.shadowWriteMongo('customer', () => collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              provenance: updatedProvenance,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        ));
        
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
      
      // task #344 (W3a): PG canonical first; Mongo shadow after.
      await this.dualWriteToSupabase('customer', newId, 'create', () =>
        this.supabaseDualWriter!.upsertCustomer(newCustomer)
      );
      await this.shadowWriteMongo('customer', () => collection.insertOne(newCustomer));
      
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
      
      // task #552 (W3a cutover): PG-canonical change-detection, Mongo fallback
      // only while shadow writes are on.
      // Resolve by the real unique key (shop_id, work_order_number); this must
      // mirror the value persisted in newWorkOrder/upsertWorkOrder below so a
      // re-run matches the existing row instead of colliding on insert (23505).
      const woNumberKey =
        mapped.workOrderNumber != null && String(mapped.workOrderNumber) !== ""
          ? String(mapped.workOrderNumber)
          : (sourceIds[0]?.idValue != null ? String(sourceIds[0].idValue) : null);
      const existing =
        (this.supabaseDualWriter
          ? await this.supabaseDualWriter.findWorkOrderByNaturalKey(this.shopId, sourceIds[0], woNumberKey)
          : null) ??
        (shouldShadowWriteMongo() ? await collection.findOne(existingQuery) : null);
      
      const contentHash = generateContentHash(mapped);
      
      const serviceJobs = this.adapter.extractServiceJobsFromWorkOrder(sourceData);
      
      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          // task #414: PG canonical may be missing this row if the Mongo doc
          // pre-dates the W3a polarity flip (task #344) — every successful
          // skip used to short-circuit before any PG write, leaving child
          // service_jobs / line_items / payments with no parent WO row to
          // FK against. Idempotently upsert PG on the skip path so the FK
          // invariant holds. PG upsert is `onConflictDoUpdate` so the cost
          // is one cheap UPSERT per skipped RO; correctness > microperf.
          // task #552: when `existing` came from PG (`__fromPg`), the parent
          // row already exists, so this backfill is redundant — and `existing`
          // is only a partial projection, so spreading it would clobber the
          // real row. Only backfill when the hit came from the Mongo fallback.
          if (!existing.__fromPg) {
            await this.dualWriteToSupabase('work_order', existing._id, 'skip-fk-backfill', () =>
              this.supabaseDualWriter!.upsertWorkOrder({
                ...existing,
                shopId: this.shopId,
                enterpriseId: this.enterpriseId,
                vehicleId: vehicleId || existing.vehicleId,
                customerId: customerId || existing.customerId,
              })
            );
          }
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
        
        // task #344 (W3a): PG canonical first; Mongo shadow after.
        // job_index / repair_patterns / audit are SEPARATE Mongo
        // collections with their own future migrations — they continue
        // to write regardless of the WRITE_MONGO_NORMALIZED flag.
        await this.dualWriteToSupabase('work_order', existing._id, 'update', () =>
          this.supabaseDualWriter!.upsertWorkOrder({ ...mapped, _id: existing._id, shopId: this.shopId, enterpriseId: this.enterpriseId, vehicleId: vehicleId || existing.vehicleId, customerId: customerId || existing.customerId, provenance: updatedProvenance, softDelete: existing.softDelete, version: existing.version + 1, createdAt: existing.createdAt, updatedAt: new Date() })
        );
        await this.shadowWriteMongo('work_order', async () => {
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
          await this._stampIngestionVia(existing._id);
        });

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
        // Persist the SAME value used as the change-detection unique key
        // (woNumberKey) so a later re-run resolves this row by
        // (shop_id, work_order_number) instead of colliding on insert.
        workOrderNumber: woNumberKey ?? String(sourceIds[0]?.idValue),
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
      
      // task #344 (W3a): PG canonical first; Mongo shadow after.
      await this.dualWriteToSupabase('work_order', newId, 'create', () =>
        this.supabaseDualWriter!.upsertWorkOrder(newWorkOrder)
      );
      await this.shadowWriteMongo('work_order', async () => {
        await collection.insertOne(newWorkOrder);
        await this._stampIngestionVia(newId);
      });

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
      
      // task #552 (W3a cutover): PG-canonical change-detection, Mongo fallback
      // only while shadow writes are on.
      const existing =
        (this.supabaseDualWriter
          ? await this.supabaseDualWriter.findServiceJobByNaturalKey(workOrderId, sourceId)
          : null) ??
        (shouldShadowWriteMongo() ? await collection.findOne(existingQuery) : null);
      
      const contentHash = generateContentHash(mapped);
      
      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          // task #414: PG canonical may be missing this row if the Mongo doc
          // pre-dates the W3a polarity flip (task #344). Without this
          // backfill upsert, child line_items would FK-violate against a
          // missing parent service_job. See ingestWorkOrder skip path for
          // the full rationale. task #552: skip when the hit came from PG
          // (`__fromPg`) — the row already exists and `existing` is partial.
          if (!existing.__fromPg) {
            await this.dualWriteToSupabase('service_job', existing._id, 'skip-fk-backfill', () =>
              this.supabaseDualWriter!.upsertServiceJob({
                ...existing,
                shopId: this.shopId,
                enterpriseId: this.enterpriseId,
                workOrderId,
              })
            );
          }
          return {
            success: true,
            entityType: 'service_job',
            entityId: existing._id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }
        
        // task #344 (W3a): PG canonical first; Mongo shadow after.
        await this.dualWriteToSupabase('service_job', existing._id, 'update', () =>
          this.supabaseDualWriter!.upsertServiceJob({ ...mapped, _id: existing._id, shopId: this.shopId, enterpriseId: this.enterpriseId, workOrderId, provenance: existing.provenance, softDelete: existing.softDelete, version: existing.version + 1, createdAt: existing.createdAt, updatedAt: new Date() })
        );
        await this.shadowWriteMongo('service_job', () => collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        ));
        
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
      
      // task #344 (W3a): PG canonical first; Mongo shadow after.
      await this.dualWriteToSupabase('service_job', newId, 'create', () =>
        this.supabaseDualWriter!.upsertServiceJob(newServiceJob)
      );
      await this.shadowWriteMongo('service_job', () => collection.insertOne(newServiceJob));
      
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
  // LINE ITEM INGESTION (standalone)
  // ---------------------------------------------------------------------------

  /**
   * Writes a single normalized line item to Mongo and dual-writes to PG
   * (`normalized_line_items`). Mirrors `ingestServiceJob`'s shape and dedupe
   * key contract so that callers can iterate the raw per-job lines returned
   * by `adapter.extractLineItemsFromServiceJob` and persist each one.
   *
   * Dedupe key: `sourceData.ID || sourceData.id || sourceData._sourceId`.
   * Adapters MUST set one of these — Tekmetric uses synthetic
   * `labor-<id>`/`part-<id>` to avoid cross-namespace collisions; Protractor
   * falls back to `<servicePackageId>-<index>` when an explicit line ID
   * isn't present. See `INormalizedAdapter.extractLineItemsFromServiceJob`.
   */
  async ingestLineItem(workOrderId: string, serviceJobId: string, sourceData: any): Promise<IngestionResult> {
    try {
      const mapped = this.adapter.mapLineItem(this.shopId, workOrderId, serviceJobId, sourceData);

      const collection = this.db.collection<NormalizedLineItem>(NORMALIZED_COLLECTIONS.lineItems);

      const sourceId = sourceData.ID || sourceData.id || sourceData._sourceId;
      if (!sourceId) {
        return {
          success: false,
          entityType: 'line_item',
          action: 'error',
          message: 'Line item has no ID',
        };
      }

      const existingQuery = {
        serviceJobId,
        'provenance.sourceIds.idValue': String(sourceId),
      };

      // task #552 (W3a cutover): PG-canonical change-detection, Mongo fallback
      // only while shadow writes are on.
      const existing =
        (this.supabaseDualWriter
          ? await this.supabaseDualWriter.findLineItemByNaturalKey(serviceJobId, sourceId)
          : null) ??
        (shouldShadowWriteMongo() ? await collection.findOne(existingQuery) : null);

      const contentHash = generateContentHash(mapped);

      if (existing) {
        if (!this.options.forceUpdate && existing.provenance.contentHash === contentHash) {
          return {
            success: true,
            entityType: 'line_item',
            entityId: existing._id,
            action: 'skipped',
            message: 'Content unchanged',
            contentHash,
          };
        }

        // task #344 (W3a): PG canonical first; Mongo shadow after.
        await this.dualWriteToSupabase('line_item', existing._id, 'update', () =>
          this.supabaseDualWriter!.upsertLineItem({ ...mapped, _id: existing._id, shopId: this.shopId, enterpriseId: this.enterpriseId, workOrderId, serviceJobId, provenance: existing.provenance, softDelete: existing.softDelete, version: existing.version + 1, createdAt: existing.createdAt, updatedAt: new Date() })
        );
        await this.shadowWriteMongo('line_item', () => collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        ));

        return {
          success: true,
          entityType: 'line_item',
          entityId: existing._id,
          action: 'updated',
          contentHash,
        };
      }

      const newId = generateEntityId();
      const now = new Date();
      const sourceIds = [{
        system: this.adapter.sourceSystem,
        idType: 'line_item_id',
        idValue: String(sourceId),
        isPrimary: true,
      }];

      const newLineItem: NormalizedLineItem = {
        _id: newId,
        ...mapped,
        shopId: this.shopId,
        enterpriseId: this.enterpriseId,
        workOrderId,
        serviceJobId,
        provenance: createProvenance(this.adapter.sourceSystem, sourceIds, contentHash, this.options.syncRunId),
        softDelete: createSoftDelete(),
        createdAt: now,
        updatedAt: now,
        version: 1,
        lineNumber: mapped.lineNumber || 0,
        lineType: mapped.lineType || 'misc',
        partDescription: mapped.partDescription || 'Unknown Item',
        quantity: mapped.quantity || 1,
        quantityUnit: mapped.quantityUnit || 'each',
        unitCost: mapped.unitCost || 0,
        unitPrice: mapped.unitPrice || 0,
        extendedPrice: mapped.extendedPrice || 0,
        taxable: mapped.taxable !== false,
        customFields: {},
      } as NormalizedLineItem;

      // task #344 (W3a): PG canonical first; Mongo shadow after.
      await this.dualWriteToSupabase('line_item', newId, 'create', () =>
        this.supabaseDualWriter!.upsertLineItem(newLineItem)
      );
      await this.shadowWriteMongo('line_item', () => collection.insertOne(newLineItem));

      return {
        success: true,
        entityType: 'line_item',
        entityId: newId,
        action: 'created',
        contentHash,
      };
    } catch (error) {
      return {
        success: false,
        entityType: 'line_item',
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
      
      // task #552 (W3a cutover): PG-canonical change-detection, Mongo fallback
      // only while shadow writes are on.
      const existing =
        (this.supabaseDualWriter
          ? await this.supabaseDualWriter.findPaymentByNaturalKey(workOrderId, sourceId)
          : null) ??
        (shouldShadowWriteMongo() ? await collection.findOne(existingQuery) : null);
      
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
        
        // task #344 (W3a): PG canonical first; Mongo shadow after.
        await this.dualWriteToSupabase('payment', existing._id, 'update', () =>
          this.supabaseDualWriter!.upsertPayment({ ...mapped, _id: existing._id, shopId: this.shopId, enterpriseId: this.enterpriseId, workOrderId, provenance: existing.provenance, softDelete: existing.softDelete, version: existing.version + 1, createdAt: existing.createdAt, updatedAt: new Date() })
        );
        await this.shadowWriteMongo('payment', () => collection.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...mapped,
              updatedAt: new Date(),
              version: existing.version + 1,
            },
          }
        ));
        
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
      
      // task #344 (W3a): PG canonical first; Mongo shadow after.
      await this.dualWriteToSupabase('payment', newId, 'create', () =>
        this.supabaseDualWriter!.upsertPayment(newPayment)
      );
      await this.shadowWriteMongo('payment', () => collection.insertOne(newPayment));
      
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
    serviceJobs: IngestionResult[];
    lineItems: IngestionResult[];
    payments: IngestionResult[];
    inspections: IngestionResult[];
    recommendations: IngestionResult[];
  }> {
    const workOrderResult = await this.ingestWorkOrder(sourceData);
    
    const serviceJobs: IngestionResult[] = [];
    const lineItems: IngestionResult[] = [];
    const payments: IngestionResult[] = [];
    const inspections: IngestionResult[] = [];
    const recommendations: IngestionResult[] = [];
    
    if (workOrderResult.success && workOrderResult.entityId) {
      const workOrderId = workOrderResult.entityId;
      
      // task #552 (W3a cutover): resolve the vehicle id (used to link the
      // Mongo-only inspection/recommendation entities) from PG first; fall back
      // to Mongo only while shadow writes are on.
      const vehicleData = this.adapter.extractVehicleFromWorkOrder(sourceData);
      let vehicleId = '';
      if (vehicleData?.vin && this.supabaseDualWriter) {
        const pgVehicle = await this.supabaseDualWriter.findVehicleByNaturalKey(this.shopId, vehicleData.vin, undefined);
        if (pgVehicle?._id) vehicleId = String(pgVehicle._id);
      }
      if (!vehicleId && shouldShadowWriteMongo()) {
        const vehicleQuery: any = { shopId: this.shopId };
        if (vehicleData?.vin) {
          vehicleQuery.vin = vehicleData.vin;
        }
        const vehicleDoc = await this.db.collection(NORMALIZED_COLLECTIONS.vehicles).findOne(vehicleQuery);
        if (vehicleDoc?._id) vehicleId = String(vehicleDoc._id);
      }

      // Standalone service-job + line-item ingestion. This is the gap that
      // task #360 closes: the work-order path used to only embed jobs into
      // `normalized_work_orders.serviceJobs` (and `job_index`), which left
      // PG `normalized_service_jobs` / `normalized_line_items` empty and
      // forced job-search to fall back to Mongo (#359). We iterate the RAW
      // per-source service jobs (the simplified embedded shape lacks the
      // source ID and nested line items needed for dedupe + FK linkage),
      // ingest each one, then walk its line items in the same order so
      // `line_items.service_job_id` resolves correctly.
      const rawServiceJobs = this.adapter.extractRawServiceJobsFromWorkOrder(sourceData);
      // Task #946: child-entity writes used to run strictly serially — a
      // dense work order (dozens of jobs × lines + payments/inspections/
      // recommendations) paid one full DB round-trip per entity, one at a
      // time. Fan them out with bounded concurrency instead. Line items
      // still run AFTER (and only with) their own service job so the
      // `service_job_id` FK linkage is preserved; ordering WITHIN each
      // entity family is retained in the result arrays by writing into
      // pre-sized index slots. Distinct entities dedupe on distinct
      // natural keys, so concurrent upserts of different rows don't race
      // each other.
      const sjWrite = await this.ingestServiceJobsAndLineItemsBounded(workOrderId, rawServiceJobs);
      serviceJobs.push(...sjWrite.serviceJobs);
      lineItems.push(...sjWrite.lineItems);

      const paymentData = this.adapter.extractPaymentsFromWorkOrder(sourceData);
      const inspectionData = this.adapter.extractInspectionsFromWorkOrder(sourceData);
      const recommendationData = this.adapter.extractRecommendationsFromWorkOrder(sourceData);
      const limit = pLimit(INGESTION_WRITE_CONCURRENCY);
      const [payResults, inspResults, recResults] = await Promise.all([
        Promise.all(paymentData.map((payment: any) => limit(() => this.ingestPayment(workOrderId, payment)))),
        Promise.all(inspectionData.map((inspection: any) => limit(() => this.ingestInspection(workOrderId, vehicleId, inspection)))),
        Promise.all(recommendationData.map((rec: any) => limit(() => this.ingestRecommendation(vehicleId, rec, workOrderId)))),
      ]);
      payments.push(...payResults);
      inspections.push(...inspResults);
      recommendations.push(...recResults);
    }
    
    return {
      workOrder: workOrderResult,
      serviceJobs,
      lineItems,
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
  
  /**
   * Public, typed replay path for the task #360 backfill (and any future
   * backfills that need to populate `normalized_service_jobs` /
   * `normalized_line_items` from an existing work order's raw payload
   * without re-upserting the work order itself). Mirrors the inner loop of
   * `ingestWorkOrderWithAllEntities` exactly so behavior stays in sync.
   */
  async replayServiceJobsAndLineItemsFromRawPayload(
    workOrderId: string,
    sourceData: any,
  ): Promise<{ serviceJobs: IngestionResult[]; lineItems: IngestionResult[] }> {
    const rawServiceJobs = this.adapter.extractRawServiceJobsFromWorkOrder(sourceData);
    return this.ingestServiceJobsAndLineItemsBounded(workOrderId, rawServiceJobs);
  }

  /**
   * Shared service-job + line-item write core (task #946). Ingests each raw
   * service job, then its line items, with bounded concurrency across jobs
   * (and across a job's lines). A line item is only written after its own
   * service job succeeded, so `line_items.service_job_id` FK linkage is
   * preserved exactly as in the old serial loop. Result arrays keep the
   * source order of service jobs (and of lines within each job) so callers
   * relying on positional correspondence see no behavior change.
   */
  private async ingestServiceJobsAndLineItemsBounded(
    workOrderId: string,
    rawServiceJobs: any[],
  ): Promise<{ serviceJobs: IngestionResult[]; lineItems: IngestionResult[] }> {
    const serviceJobs: IngestionResult[] = new Array(rawServiceJobs.length);
    const lineItemsByJob: IngestionResult[][] = new Array(rawServiceJobs.length);
    // Two separate pools: a job task holds its slot while awaiting its
    // lines, so lines MUST draw from a different pool — sharing one limiter
    // would deadlock once every job slot is parked waiting on line slots
    // that can never be granted.
    const jobLimit = pLimit(INGESTION_WRITE_CONCURRENCY);
    const lineLimit = pLimit(INGESTION_WRITE_CONCURRENCY);
    await Promise.all(
      rawServiceJobs.map((rawJob, jobIdx) =>
        jobLimit(async () => {
          const sjResult = await this.ingestServiceJob(workOrderId, rawJob);
          serviceJobs[jobIdx] = sjResult;
          if (sjResult.success && sjResult.entityId) {
            const rawLines = this.adapter.extractLineItemsFromServiceJob(rawJob);
            // Lines fan out through the line pool; source order is
            // restored positionally below.
            const lineResults: IngestionResult[] = new Array(rawLines.length);
            await Promise.all(
              rawLines.map((rawLine: any, lineIdx: number) =>
                lineLimit(() => this.ingestLineItem(workOrderId, sjResult.entityId!, rawLine)).then(
                  (r) => {
                    lineResults[lineIdx] = r;
                  },
                ),
              ),
            );
            lineItemsByJob[jobIdx] = lineResults;
          } else {
            lineItemsByJob[jobIdx] = [];
          }
        }),
      ),
    );
    return { serviceJobs, lineItems: lineItemsByJob.flat() };
  }

  async ingestWorkOrderBatchWithAllEntities(workOrders: any[]): Promise<{
    workOrders: IngestionBatchResult;
    serviceJobs: { created: number; updated: number; skipped: number; errors: number };
    lineItems: { created: number; updated: number; skipped: number; errors: number };
    payments: { created: number; updated: number; skipped: number; errors: number };
    inspections: { created: number; updated: number; skipped: number; errors: number };
    recommendations: { created: number; updated: number; skipped: number; errors: number };
  }> {
    const workOrderResults: IngestionResult[] = [];
    let woCreated = 0, woUpdated = 0, woSkipped = 0, woErrors = 0;
    let sjCreated = 0, sjUpdated = 0, sjSkipped = 0, sjErrors = 0;
    let liCreated = 0, liUpdated = 0, liSkipped = 0, liErrors = 0;
    let payCreated = 0, payUpdated = 0, paySkipped = 0, payErrors = 0;
    let inspCreated = 0, inspUpdated = 0, inspSkipped = 0, inspErrors = 0;
    let recCreated = 0, recUpdated = 0, recSkipped = 0, recErrors = 0;

    // Pre-fetch ACES for every VIN in this batch in ONE DataOne round-trip
    // (previously one lookup per work order inside writeToJobIndex — ~400
    // sequential round-trips on a dense backfill chunk). writeToJobIndex reads
    // this cache instead.
    //
    // We map EVERY VIN to its enrichment — including multiple distinct VINs
    // that collapse to the same squish — so the cached value is identical to
    // calling enrichVinWithAces() per VIN (acesFromDecoded on the same decoded
    // row). That avoids the squish-dedup gap where a second same-squish VIN
    // would otherwise miss the cache and write null ACES on a content-change
    // update. job_index content is therefore unchanged (and contentHash
    // excludes ACES anyway → no churn).
    //
    // On a bulk-lookup failure we leave the cache `null` so writeToJobIndex
    // falls back to the per-VIN path, preserving the old soft-fail resilience
    // (a single batch hiccup no longer nulls ACES for the whole chunk).
    const batchVins = workOrders.map(
      (wo) => this.adapter.extractVehicleFromWorkOrder(wo)?.vin,
    );
    try {
      this._acesBatchCache = await enrichVinsWithAcesAllVins(batchVins);
    } catch (err) {
      console.warn(
        `[ingest] Bulk ACES prefetch failed for shop ${this.shopId} ` +
          `(${batchVins.length} VINs); falling back to per-VIN: ` +
          `${(err as Error)?.message || err}`,
      );
      this._acesBatchCache = null;
    }

    try {
    for (const wo of workOrders) {
      const result = await this.ingestWorkOrderWithAllEntities(wo);
      workOrderResults.push(result.workOrder);
      
      switch (result.workOrder.action) {
        case 'created': woCreated++; break;
        case 'updated': woUpdated++; break;
        case 'skipped': woSkipped++; break;
        case 'error': woErrors++; break;
      }

      for (const sj of result.serviceJobs) {
        switch (sj.action) {
          case 'created': sjCreated++; break;
          case 'updated': sjUpdated++; break;
          case 'skipped': sjSkipped++; break;
          case 'error': sjErrors++; break;
        }
      }

      for (const li of result.lineItems) {
        switch (li.action) {
          case 'created': liCreated++; break;
          case 'updated': liUpdated++; break;
          case 'skipped': liSkipped++; break;
          case 'error': liErrors++; break;
        }
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
    } finally {
      this._acesBatchCache = null;
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
      serviceJobs: {
        created: sjCreated,
        updated: sjUpdated,
        skipped: sjSkipped,
        errors: sjErrors,
      },
      lineItems: {
        created: liCreated,
        updated: liUpdated,
        skipped: liSkipped,
        errors: liErrors,
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
  
  /**
   * Public so the historical rebuild script
   * (scripts/backfill-job-index-aces.ts Phase A) can drive Shop-Ware
   * reindex from raw repair-order payloads without re-running the full
   * normalize pipeline. The script constructs a service per shop with the
   * Shop-Ware adapter, calls extractServiceJobsFromWorkOrder, and then
   * writeToJobIndex to insert the missing job_index entries.
   */
  async writeToJobIndex(sourceData: any, serviceJobs: Partial<NormalizedServiceJob>[]): Promise<void> {
    const jobIndexCollection = this.db.collection('job_index');
    
    const vehicle = this.adapter.extractVehicleFromWorkOrder(sourceData);
    const sourceIds = this.adapter.getSourceIds(sourceData);
    const workOrderId = sourceIds.find(s => s.isPrimary)?.idValue || sourceData.ID || sourceData.id;

    // Task #382 — ACES enrichment from DataOne squish lookup. Soft-fails so
    // an indexer outage doesn't block the underlying job_index write.
    // When a batch is in flight (`_acesBatchCache` set), read the pre-fetched
    // bulk result instead of firing a per-work-order DataOne round-trip; the
    // batch already attempted every VIN, so a miss means "did not decode"
    // (same as the per-VIN call returning null). Single-WO callers leave the
    // cache null and keep the direct per-VIN lookup.
    const aces = this._acesBatchCache
      ? (vehicle?.vin ? this._acesBatchCache.get(vehicle.vin) ?? null : null)
      : await enrichVinWithAces(vehicle?.vin);

    // Task #382 — Build per-service-job line arrays with PCDB / PartsTech
    // IDs attached to each part line. Only applies to Tekmetric and Shop-Ware
    // (Protractor doesn't surface PCDB). The result is a Map<serviceJobKey,
    // line[]> so the per-job loop below can attach the matching subset to
    // its own jobIndexEntry.lines field — keeping PCDB at the line level
    // (Task #382 requirement) instead of buried in a top-level array.
    const linesByJob =
      this.adapter.sourceSystem === 'tekmetric'
        ? this.buildTekmetricLinesByJob(sourceData)
        : this.adapter.sourceSystem === 'shopware'
          ? this.buildShopWareLinesByJob(sourceData)
          : new Map<string, any[]>();

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

      // Resolve this service job's part lines. Tek keys by raw job id
      // (`job.id`); SW keys by raw service_item id; both fall back to
      // looking the title up in the lines map for older payloads.
      const jobKey =
        (job as any).sourceJobId != null
          ? String((job as any).sourceJobId)
          : job.title || '';
      const jobLines = linesByJob.get(jobKey) ?? linesByJob.get(job.title || '') ?? [];

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
        // Task #382 — DataOne is authoritative on Y/M/M when squish
        // resolves; fall back to source-supplied values otherwise. This
        // keeps shop-typed misspellings (e.g. "MERCEDES-BENZ" vs "Mercedes")
        // from polluting the scoring corpus.
        vin: vehicle?.vin,
        year: aces?.year ?? vehicle?.year,
        make: aces?.make ?? vehicle?.make,
        model: aces?.model ?? vehicle?.model,
        engine: vehicle?.engineDescription,
        // Task #382 — ACES IDs from DataOne, nested under `vehicle.*` to
        // match the canonical shape used by the Tek live indexer
        // (lib/integrations/tekmetric/job-index.ts) and by the rebuild +
        // coverage tooling. Null when squish ambiguous.
        vehicle: {
          vin: vehicle?.vin,
          year: aces?.year ?? vehicle?.year,
          make: aces?.make ?? vehicle?.make,
          model: aces?.model ?? vehicle?.model,
          engine: vehicle?.engineDescription,
          acesVehicleId: aces?.acesVehicleId ?? null,
          acesEngineId: aces?.acesEngineId ?? null,
          submodelKey: aces?.submodelKey ?? null,
          acesDecodedAt: aces?.acesDecodedAt ?? null,
        },
        // Task #382 — Lines array with PCDB / PartsTech IDs on part lines
        // (Tek + SW). Empty array when nothing present so consumers always
        // see a uniform shape.
        lines: jobLines,
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
  
  /**
   * Task #382 — Build a Map<sourceJobId, line[]> for a Tekmetric raw RO
   * payload. Each part line carries PCDB / PartsTech IDs when present so
   * the writeToJobIndex caller can attach the matching subset directly to
   * its own job entry. Labor lines are emitted too (so `lines` mirrors
   * what the live Tekmetric indexer in lib/integrations/tekmetric/job-index.ts
   * produces) — keeps the SW + Tek dual-write paths shape-consistent.
   */
  // Public so the ACES coverage smoke test can exercise the
  // representative-path line-builder behavior (per-line PCDB capture)
  // without spinning up a full Mongo + service instance.
  buildTekmetricLinesByJob(sourceData: any): Map<string, any[]> {
    const out = new Map<string, any[]>();
    const jobs = Array.isArray(sourceData?.jobs) ? sourceData.jobs : [];
    for (const job of jobs) {
      const lines: any[] = [];
      const labors = Array.isArray(job.labor) ? job.labor : [];
      for (const labor of labors) {
        const hours = labor.hours || 0;
        const rate = (labor.rate || 0) / 100;
        lines.push({
          lineType: 'labor',
          description: labor.name || job.name,
          quantity: 1,
          unitPrice: rate,
          extendedPrice: hours * rate,
          hours,
        });
      }
      const parts = Array.isArray(job.parts) ? job.parts : [];
      for (const part of parts) {
        const qty = part.quantity || 1;
        const unit = (part.retail || part.cost || 0) / 100;
        lines.push({
          lineType: 'part',
          description: part.name || part.description || '',
          partNumber: part.partNumber,
          manufacturer: part.brand,
          quantity: qty,
          unitPrice: unit,
          extendedPrice: qty * unit,
          ...extractTekmetricPcdb(part),
        });
      }
      const key = String(job.id);
      out.set(key, lines);
      if (job.name) out.set(job.name, lines);
    }
    return out;
  }

  /**
   * Task #382 — Same idea for Shop-Ware. Shop-Ware repair-order payloads
   * carry parts under `service_items[].parts` (or `parts` at the RO root
   * for older payloads); we tolerate both. The result is keyed by
   * service_item id so each writeToJobIndex iteration finds its lines.
   */
  // Public for the same reason as buildTekmetricLinesByJob — see above.
  buildShopWareLinesByJob(sourceData: any): Map<string, any[]> {
    const out = new Map<string, any[]>();
    const items = Array.isArray(sourceData?.service_items) ? sourceData.service_items : [];
    for (const item of items) {
      const lines: any[] = [];
      const labors = Array.isArray(item.labors) ? item.labors : [];
      for (const labor of labors) {
        lines.push({
          lineType: 'labor',
          description: labor.name,
          quantity: 1,
          unitPrice: 0,
          extendedPrice: 0,
          hours: labor.hours,
        });
      }
      const parts = Array.isArray(item.parts) ? item.parts : [];
      for (const part of parts) {
        const qty = part.quantity || 1;
        const unit = (part.sell_price_cents ?? 0) / 100;
        lines.push({
          lineType: 'part',
          description: part.description || part.name || '',
          partNumber: part.number || part.part_number || part.partNumber,
          manufacturer: part.brand,
          quantity: qty,
          unitPrice: unit,
          extendedPrice: qty * unit,
          ...extractShopWarePcdb(part),
        });
      }
      const key = String(item.id);
      out.set(key, lines);
      if (item.name) out.set(item.name, lines);
    }
    // Fallback: older flat-parts payloads (no service_items wrapper).
    if (out.size === 0 && Array.isArray(sourceData?.parts)) {
      const lines: any[] = [];
      for (const part of sourceData.parts) {
        const qty = part.quantity || 1;
        const unit = (part.sell_price_cents ?? 0) / 100;
        lines.push({
          lineType: 'part',
          description: part.description || part.name || '',
          partNumber: part.number || part.part_number || part.partNumber,
          manufacturer: part.brand,
          quantity: qty,
          unitPrice: unit,
          extendedPrice: qty * unit,
          ...extractShopWarePcdb(part),
        });
      }
      out.set('', lines);
    }
    return out;
  }

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
  
  /**
   * task #344 (W3a polarity flip): PG is now canonical for the six
   * normalized entities. This helper awaits the PG write and **rethrows
   * on failure** — the surrounding `ingestX` try/catch turns it into an
   * `IngestionResult{ success:false, action:'error' }` so the caller
   * sees the failure. The pre-existing rich pgCode/pgConstraint logging
   * is preserved before the rethrow so on-call still gets the
   * structured diagnostic.
   *
   * The legacy method name is retained so call-site diffs stay small;
   * see `docs/db-migration-map.md` §10 for the cutover log.
   */
  private async dualWriteToSupabase(
    entityType: string,
    entityId: string,
    action: string,
    upsertFn: () => Promise<void>
  ): Promise<void> {
    if (!this.supabaseDualWriter) {
      throw new Error(
        `[PgCanonical] writer not initialized — cannot persist ${entityType} ${entityId} (shop ${this.shopId})`
      );
    }
    try {
      await upsertFn();
      // Task #460: per-chunk PG write fan-out. AsyncLocalStorage-scoped,
      // so it only counts when the call chain originated inside a
      // `withChunkWriteCounters` wrapper (i.e. the backfill chunk path).
      // Live/webhook ingestion paths are unaffected.
      bumpPgWrites();
    } catch (err) {
      const e = err as any;
      const cause = e?.cause as any;
      const pgCode = e?.code ?? cause?.code ?? null;
      const pgDetail = e?.detail ?? cause?.detail ?? null;
      const pgConstraint = e?.constraint ?? cause?.constraint ?? null;
      const pgColumn = e?.column ?? cause?.column ?? null;
      const pgTable = e?.table ?? cause?.table ?? null;
      const pgHint = e?.hint ?? cause?.hint ?? null;
      const causeMessage = cause?.message ?? null;
      const baseMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[PgCanonical] Postgres write failed — entity: ${entityType}, id: ${entityId}, action: ${action}, shop: ${this.shopId}, ` +
        `pgCode: ${pgCode}, pgConstraint: ${pgConstraint}, pgColumn: ${pgColumn}, pgTable: ${pgTable}, ` +
        `pgDetail: ${pgDetail ? String(pgDetail).slice(0, 500) : null}, ` +
        `pgHint: ${pgHint ? String(pgHint).slice(0, 200) : null}, ` +
        `causeMessage: ${causeMessage ? String(causeMessage).slice(0, 300) : null}, ` +
        `error: ${baseMessage}`
      );
      throw err;
    }
  }

  /**
   * Shadow-Mongo wrapper for the W3a soak window. Calls the supplied fn
   * iff `WRITE_MONGO_NORMALIZED !== '0'` (default ON during soak).
   * Mongo failures are logged but never thrown — Mongo is no longer
   * canonical, so a transient Mongo outage must not break ingestion.
   *
   * After the per-entity 24–168h soak passes, operators flip
   * `WRITE_MONGO_NORMALIZED=0` and these calls become no-ops; the
   * entire `lib/supabase-dual-writer.ts` file (renamed from its dual-
   * write origins) and the surrounding Mongo plumbing get retired in
   * the W3a-followup task.
   */
  private async shadowWriteMongo(
    entityType: string,
    fn: () => Promise<unknown>
  ): Promise<void> {
    if (!shouldShadowWriteMongo()) return;
    try {
      await fn();
      // Task #460: per-chunk Mongo shadow-write fan-out (see PG sibling above).
      bumpMongoWrites();
    } catch (err) {
      const baseMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[ShadowMongo] write failed (non-fatal) — entity: ${entityType}, shop: ${this.shopId}, error: ${baseMessage}`
      );
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
  
  /**
   * Stamps `firstIngestedVia` / `firstIngestedAt` (set-if-missing) and
   * `lastIngestedVia` / `lastIngestedAt` (always) on a normalized_work_orders
   * doc. No-op when `options.ingestionVia` isn't set, so existing callers that
   * don't pass it (e.g. tests, legacy entry points) keep their current
   * behavior. Failures are logged but never thrown — instrumentation must
   * never break the ingestion path.
   */
  private async _stampIngestionVia(workOrderId: string): Promise<void> {
    const via = this.options.ingestionVia;
    if (!via) return;
    try {
      const collection = this.db.collection(NORMALIZED_COLLECTIONS.workOrders);
      const now = new Date();
      // Two writes (rather than one with $setOnInsert) because we're not
      // upserting — we're updating an already-inserted/updated row, so
      // $setOnInsert wouldn't fire. The first updateOne is "set if missing"
      // (immutable first-writer attribution); the second is unconditional
      // (always-fresh diagnostic).
      await collection.updateOne(
        { _id: workOrderId as any, firstIngestedVia: { $exists: false } },
        { $set: { firstIngestedVia: via, firstIngestedAt: now } }
      );
      await collection.updateOne(
        { _id: workOrderId as any },
        { $set: { lastIngestedVia: via, lastIngestedAt: now } }
      );
    } catch (err: any) {
      console.log(`[NIS] _stampIngestionVia(${workOrderId}, ${via}) failed: ${err?.message}`);
    }
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
  enterpriseId?: string,
  options?: IngestionOptions
): NormalizedIngestionService {
  return new NormalizedIngestionService(db, sourceSystem, shopId, enterpriseId, options);
}
