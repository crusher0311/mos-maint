export * from './client';
export * from './transform';
export * from './sync';
export * from './jobs-prewarm';
export { ProtractorAdapter, protractorAdapter } from './adapter';

import { integrationRegistry } from '@/lib/integrations/core/facade';
import { protractorAdapter } from './adapter';

integrationRegistry.register(protractorAdapter);
