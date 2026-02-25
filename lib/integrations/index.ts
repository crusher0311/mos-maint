export * from './core';

import './protractor/index';
import './tekmetric/index';
import './autoflow/index';
import { integrationRegistry } from './core/facade';
import { shopWareAdapter } from './shopware/adapter';
integrationRegistry.register(shopWareAdapter);

export { protractorAdapter } from './protractor/adapter';
export { tekmetricAdapter } from './tekmetric/adapter';
export { autoflowAdapter } from './autoflow/adapter';
export { shopWareAdapter } from './shopware/adapter';

export {
  resolveProtractorConfig,
  protractorFetch,
  computeAuthentication,
  testConnection as testProtractorConnection,
} from './protractor/client';

export {
  getValidToken as getTekmetricToken,
  refreshToken as refreshTekmetricToken,
  clearCachedToken as clearTekmetricToken,
  isConfigured as isTekmetricConfigured,
} from './tekmetric/auth';

export {
  getShop as getTekmetricShop,
  getShops as getTekmetricShops,
  getVehicle as getTekmetricVehicle,
  getRepairOrder as getTekmetricRepairOrder,
  getRepairOrders as getTekmetricRepairOrders,
  getCannedJobs as getTekmetricCannedJobs,
  testConnection as testTekmetricConnection,
} from './tekmetric/client';

export {
  resolveAutoflowConfig,
  fetchDviByInvoice,
  testConnection as testAutoflowConnection,
} from './autoflow/client';

export type { ProtractorConfig, ProtractorVehicle, ProtractorWorkOrder, ProtractorCannedJob } from './protractor/types';
export type { TekmetricShop, TekmetricVehicle, TekmetricRepairOrder, TekmetricCannedJob } from './tekmetric/types';
export type { AutoflowConfig, DviResult, DviCategory, DviItem } from './autoflow/types';
