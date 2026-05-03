/**
 * MOS Normalized Data Adapters — Core
 *
 * Shared interface, helpers, and factory for per-provider adapter classes.
 * Provider implementations live alongside their integration in
 * `lib/integrations/<provider>/normalized-adapter.ts`.
 */

import { ObjectId } from 'mongodb';
import { createHash } from 'crypto';
import {
  SourceSystem,
  NormalizedVehicle,
  NormalizedCustomer,
  NormalizedWorkOrder,
  NormalizedServiceJob,
  NormalizedLineItem,
  NormalizedInspection,
  NormalizedRecommendation,
  NormalizedPayment,
  NormalizedComponentHistory,
  Provenance,
  SourceId,
  SoftDelete,
  VehicleSnapshot,
  CustomerSnapshot,
  StatusChange,
  TechnicianAssignment,
  PaymentRecord,
  OdometerReading,
  WorkOrderStatus,
  ServiceJobStatus,
  LineItemType,
  PartCondition,
  LaborType,
  PaymentMethod,
  PaymentStatus,
  DistanceUnit,
  InspectionStatus,
  InspectionFinding,
  RecommendationStatus,
} from '@/lib/normalized-schema';

// =============================================================================
// ADAPTER INTERFACE
// =============================================================================

export interface INormalizedAdapter {
  sourceSystem: SourceSystem;

  mapVehicle(shopId: number, sourceData: any, enterpriseId?: string): Partial<NormalizedVehicle>;
  mapCustomer(shopId: number, sourceData: any, enterpriseId?: string): Partial<NormalizedCustomer>;
  mapWorkOrder(shopId: number, sourceData: any, enterpriseId?: string): Partial<NormalizedWorkOrder>;
  mapServiceJob(shopId: number, workOrderId: string, sourceData: any): Partial<NormalizedServiceJob>;
  mapLineItem(shopId: number, workOrderId: string, serviceJobId: string, sourceData: any): Partial<NormalizedLineItem>;
  mapPayment(shopId: number, workOrderId: string, sourceData: any): Partial<NormalizedPayment>;
  mapInspection(shopId: number, workOrderId: string, vehicleId: string, sourceData: any): Partial<NormalizedInspection>;
  mapRecommendation(shopId: number, vehicleId: string, sourceData: any): Partial<NormalizedRecommendation>;

  extractVehicleFromWorkOrder(sourceData: any): Partial<NormalizedVehicle> | null;
  extractCustomerFromWorkOrder(sourceData: any): Partial<NormalizedCustomer> | null;
  extractServiceJobsFromWorkOrder(sourceData: any): Partial<NormalizedServiceJob>[];
  extractPaymentsFromWorkOrder(sourceData: any): any[];
  extractInspectionsFromWorkOrder(sourceData: any): any[];
  extractRecommendationsFromWorkOrder(sourceData: any): any[];

  getSourceIds(sourceData: any): SourceId[];
}

// Re-export the schema symbols that adapter implementations rely on, so
// per-provider files can import from this single core module.
export type {
  SourceSystem,
  NormalizedVehicle,
  NormalizedCustomer,
  NormalizedWorkOrder,
  NormalizedServiceJob,
  NormalizedLineItem,
  NormalizedInspection,
  NormalizedRecommendation,
  NormalizedPayment,
  NormalizedComponentHistory,
  Provenance,
  SourceId,
  SoftDelete,
  VehicleSnapshot,
  CustomerSnapshot,
  StatusChange,
  TechnicianAssignment,
  PaymentRecord,
  OdometerReading,
  WorkOrderStatus,
  ServiceJobStatus,
  LineItemType,
  PartCondition,
  LaborType,
  PaymentMethod,
  PaymentStatus,
  DistanceUnit,
  InspectionStatus,
  InspectionFinding,
  RecommendationStatus,
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function generateContentHash(data: any): string {
  const normalized = JSON.stringify(data, Object.keys(data).sort());
  return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

export function generateEntityId(): string {
  return new ObjectId().toHexString();
}

export function createProvenance(
  sourceSystem: SourceSystem,
  sourceIds: SourceId[],
  contentHash: string,
  syncRunId?: string
): Provenance {
  const now = new Date();
  return {
    sourceSystem,
    sourceIds,
    firstSeenAt: now,
    lastSeenAt: now,
    lastSyncedAt: now,
    syncRunId,
    contentHash,
    writebackStatus: {
      status: 'not_applicable',
      retryCount: 0,
    },
  };
}

export function createSoftDelete(): SoftDelete {
  return {
    isDeleted: false,
  };
}

export function parseDate(value: any): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

export function parseNumber(value: any): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  return isNaN(num) ? undefined : num;
}

export function cleanString(value: any): string | undefined {
  if (!value) return undefined;
  const str = String(value).trim();
  return str.length > 0 ? str : undefined;
}

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

import { ProtractorAdapter } from '@/lib/integrations/protractor/normalized-adapter';
import { TekmetricAdapter } from '@/lib/integrations/tekmetric/normalized-adapter';

export { ProtractorAdapter, TekmetricAdapter };

const adapters: Record<SourceSystem, INormalizedAdapter | null> = {
  protractor: new ProtractorAdapter(),
  tekmetric: new TekmetricAdapter(),
  autoflow: null,
  autovitals: null,
  mitchell: null,
  shopware: null,
  rowriter: null,
  shopmonkey: null,
  shopboss: null,
  alldata: null,
  identifix: null,
  manual: null,
  import: null,
  unknown: null,
};

export function getAdapter(sourceSystem: SourceSystem): INormalizedAdapter | null {
  return adapters[sourceSystem] || null;
}

export function getSupportedSystems(): SourceSystem[] {
  return Object.keys(adapters).filter(
    (key) => adapters[key as SourceSystem] !== null
  ) as SourceSystem[];
}
