export * from './types';
export * from './client';
export * from './api';
export * from './transform';
export * from './adapter';
export { tekmetricAdapter } from './adapter';

import { integrationRegistry } from '@/lib/integrations/core/facade';
import { tekmetricAdapter } from './adapter';

integrationRegistry.register(tekmetricAdapter);
