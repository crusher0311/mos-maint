export * from './types';
export * from './client';
export * from './transform';
export { ProtractorAdapter, protractorAdapter } from './adapter';

import { integrationRegistry } from '@/lib/integrations/core/facade';
import { protractorAdapter } from './adapter';

integrationRegistry.register(protractorAdapter);
