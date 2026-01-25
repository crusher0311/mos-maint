export * from './types';
export * from './client';
export * from './transform';
export { ProtractorAdapter, protractorAdapter } from './adapter';

// Re-export specialized functions from legacy file for backward compatibility
// These will be gradually migrated to proper modular locations
export {
  fetchVehicleByVin,
  fetchVehicleById,
  fetchActiveWorkOrders,
  fetchWorkOrderById,
  fetchActiveInspections,
  fetchAllActiveInspections,
  fetchInvoiceById,
  fetchInvoicesForVehicle,
  findCachedJobPricing,
  fetchDeferredWork,
  upsertProtractorVehicleSnapshot,
  upsertProtractorWorkOrderSnapshot,
  upsertProtractorInvoiceSnapshot,
  upsertProtractorDeferredWorkSnapshot,
  fetchVehicleWithCache,
  fetchDeferredWorkWithCache,
  fetchCannedJobs,
  fetchCannedJobById,
  fetchServicePackageTemplates,
  fetchServicePackageTemplateDetail,
  resolveWorkOrderGuid,
  applyCannedJobToWorkOrder,
  fetchWorkOrdersForVehicle,
  upsertCannedJobsCache,
  getCannedJobsFromCache,
  enrichCannedJobsWithDetails,
  fetchCannedJobsWithCache,
  createProtractorAppointment,
  getProtractorAppointments,
  addDeferredWorkToWorkOrder,
} from '../protractor';

// Re-export types from legacy file  
export type { ProtractorConfig } from '../protractor';

import { integrationRegistry } from '@/lib/integrations/core/facade';
import { protractorAdapter } from './adapter';

integrationRegistry.register(protractorAdapter);
