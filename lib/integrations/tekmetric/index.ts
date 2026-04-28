export * from './types';
export * from './auth';
export * from './client';
export * from './probe';
export * from './transform';
export { TekmetricAdapter, tekmetricAdapter } from './adapter';

import { integrationRegistry } from '@/lib/integrations/core/facade';
import { tekmetricAdapter } from './adapter';

integrationRegistry.register(tekmetricAdapter);
