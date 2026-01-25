// Export modular utilities (auth, client, transform)
// Note: Types come from legacy file for full compatibility
export * from './auth';
export * from './client';
export * from './transform';
export { TekmetricAdapter, tekmetricAdapter } from './adapter';

// Re-export all functions and types from legacy file for backward compatibility
// These provide the full API used by existing routes
export {
  getShop,
  getShops,
  getCustomers,
  getCustomer,
  getVehicles,
  getVehicle,
  searchVehiclesByVin,
  getRepairOrderInspections,
  getRepairOrders,
  getRepairOrder,
  getTekmetricWorkOrderStatus,
  getTekmetricWorkOrderWithMileage,
  getJobs,
  getCannedJobs,
  addCannedJobsToRepairOrder,
  validateShopAccess,
  createAppointment,
  getAppointment,
  updateAppointment,
  deleteAppointment,
  getAppointments,
  type TekmetricShop,
  type TekmetricCustomer,
  type TekmetricVehicle,
  type TekmetricRepairOrder,
  type TekmetricRepairOrderFull,
  type TekmetricJob,
  type TekmetricCannedJob,
  type TekmetricInspection,
  type TekmetricAppointment,
  type PaginatedResponse,
  type CreateAppointmentParams,
} from '@/lib/tekmetric';

import { integrationRegistry } from '@/lib/integrations/core/facade';
import { tekmetricAdapter } from './adapter';

integrationRegistry.register(tekmetricAdapter);
