export * from './types';
export * from './client';
export { AutoflowAdapter, autoflowAdapter } from './adapter';

import { integrationRegistry } from '@/lib/integrations/core/facade';
import { autoflowAdapter } from './adapter';

integrationRegistry.register(autoflowAdapter);
