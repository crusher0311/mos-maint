import type { 
  IIntegrationAdapter, 
  IntegrationConfig,
  Result,
  NormalizedVehicle,
  NormalizedWorkOrder,
  CannedJob,
  WorkOrderQuery,
} from '@/lib/integrations/core/types';
import { resolveAutoflowConfig, testConnection as testAutoflowConnection } from './client';

export class AutoflowAdapter implements IIntegrationAdapter {
  provider = 'autoflow' as const;
  priority = 50;

  async isConfigured(shopId: number): Promise<boolean> {
    const config = await resolveAutoflowConfig(shopId);
    return config.configured;
  }

  async getConfig(shopId: number): Promise<IntegrationConfig | null> {
    const config = await resolveAutoflowConfig(shopId);
    if (!config.configured) return null;
    
    return {
      provider: 'autoflow',
      configured: true,
      shopId,
      credentials: {
        domain: config.domain,
        subdomain: config.subdomain,
      },
    };
  }

  async testConnection(shopId: number): Promise<Result<{ message: string }>> {
    const result = await testAutoflowConnection(shopId);
    if (!result.ok) {
      return { ok: false, error: result.error || 'Connection test failed' };
    }
    return { ok: true, data: { message: 'Connection successful' } };
  }

  async getVehicle(shopId: number, vehicleId: string): Promise<Result<NormalizedVehicle>> {
    return { ok: false, error: 'AutoFlow does not support vehicle lookup' };
  }

  async getVehicleByVin(shopId: number, vin: string): Promise<Result<NormalizedVehicle>> {
    return { ok: false, error: 'AutoFlow does not support vehicle lookup by VIN' };
  }

  async getWorkOrder(shopId: number, workOrderId: string): Promise<Result<NormalizedWorkOrder>> {
    return { ok: false, error: 'AutoFlow does not support work order lookup' };
  }

  async getWorkOrders(shopId: number, options?: WorkOrderQuery): Promise<Result<NormalizedWorkOrder[]>> {
    return { ok: false, error: 'AutoFlow does not support work order listing' };
  }

  async getCannedJobs(shopId: number): Promise<Result<CannedJob[]>> {
    return { ok: false, error: 'AutoFlow does not support canned jobs' };
  }
}

export const autoflowAdapter = new AutoflowAdapter();
