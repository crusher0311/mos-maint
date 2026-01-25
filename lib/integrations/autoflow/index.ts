export * from './types';
export * from './client';
export { AutoflowAdapter, autoflowAdapter } from './adapter';

// Re-export specialized functions from legacy file for backward compatibility
export {
  resolveAutoflowConfig,
  fetchDviByInvoice,
  upsertDviSnapshot,
  fetchDviWithCache,
} from '../autoflow';

// Re-export types from legacy file
export type { DviItem, DviCategory, DviResult } from '../autoflow';

import { integrationRegistry } from '@/lib/integrations/core/facade';
import { autoflowAdapter } from './adapter';

integrationRegistry.register(autoflowAdapter);
