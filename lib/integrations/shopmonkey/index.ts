export * from './types';
export * from './client';
export * from './transform';
export * from './adapter';
export { shopmonkeyAdapter } from './adapter';

import { integrationRegistry } from '@/lib/integrations/core/facade';
import { shopmonkeyAdapter } from './adapter';

integrationRegistry.register(shopmonkeyAdapter);
