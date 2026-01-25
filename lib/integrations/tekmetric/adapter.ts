import { shopRepository } from '@/lib/data/repositories';
import type { 
  IIntegrationAdapter, 
  IntegrationConfig,
  Result,
  NormalizedVehicle,
  NormalizedWorkOrder,
  CannedJob,
  WorkOrderQuery,
  BackfillOptions,
  BackfillResult,
  SyncResult,
} from '@/lib/integrations/core/types';
import { 
  isConfigured,
  testConnection as testTekmetricConnection,
  getVehicle as getTekmetricVehicle,
  searchVehiclesByVin,
  getRepairOrder,
  getRepairOrders,
  getCannedJobs as getTekmetricCannedJobs,
  getJobs,
} from './client';
import { transformVehicle, transformRepairOrder, transformCannedJob } from './transform';

export class TekmetricAdapter implements IIntegrationAdapter {
  provider = 'tekmetric' as const;
  priority = 10;

  async isConfigured(shopId: number): Promise<boolean> {
    if (!isConfigured()) return false;
    
    const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
    return Boolean(tekmetricShopId);
  }

  async getConfig(shopId: number): Promise<IntegrationConfig | null> {
    if (!await this.isConfigured(shopId)) return null;
    
    const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
    
    return {
      provider: 'tekmetric',
      configured: true,
      shopId,
      credentials: {
        tekmetricShopId,
      },
    };
  }

  async testConnection(shopId: number): Promise<Result<{ message: string }>> {
    const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
    if (!tekmetricShopId) {
      return { ok: false, error: 'Tekmetric shop ID not configured' };
    }
    
    const result = await testTekmetricConnection(tekmetricShopId);
    if (!result.ok) {
      return { ok: false, error: result.error || 'Connection test failed' };
    }
    return { ok: true, data: { message: 'Connection successful' } };
  }

  async getVehicle(shopId: number, vehicleId: string): Promise<Result<NormalizedVehicle>> {
    try {
      const vehicle = await getTekmetricVehicle(parseInt(vehicleId, 10), shopId);
      return { ok: true, data: transformVehicle(vehicle) };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Vehicle not found' };
    }
  }

  async getVehicleByVin(shopId: number, vin: string): Promise<Result<NormalizedVehicle>> {
    const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
    if (!tekmetricShopId) {
      return { ok: false, error: 'Tekmetric shop ID not configured' };
    }
    
    try {
      const result = await searchVehiclesByVin(tekmetricShopId, vin);
      const match = result.content?.find(v => v.vin?.toUpperCase() === vin.toUpperCase());
      
      if (!match) {
        return { ok: false, error: 'Vehicle not found' };
      }
      
      return { ok: true, data: transformVehicle(match) };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Search failed' };
    }
  }

  async getWorkOrder(shopId: number, workOrderId: string): Promise<Result<NormalizedWorkOrder>> {
    try {
      const ro = await getRepairOrder(parseInt(workOrderId, 10), shopId);
      const jobs = await getJobs(ro.id, shopId);
      return { ok: true, data: transformRepairOrder(ro, undefined, undefined, jobs.content) };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Work order not found' };
    }
  }

  async getWorkOrders(shopId: number, options?: WorkOrderQuery): Promise<Result<NormalizedWorkOrder[]>> {
    const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
    if (!tekmetricShopId) {
      return { ok: false, error: 'Tekmetric shop ID not configured' };
    }
    
    try {
      const allWorkOrders: NormalizedWorkOrder[] = [];
      let page = 0;
      const size = options?.limit || 100;
      let hasMore = true;
      const maxPages = 50;
      
      while (hasMore && page < maxPages) {
        const result = await getRepairOrders(tekmetricShopId, {
          page,
          size,
          vehicleId: options?.vehicleId ? parseInt(options.vehicleId, 10) : undefined,
          customerId: options?.customerId ? parseInt(options.customerId, 10) : undefined,
          updatedAfter: options?.fromDate,
          updatedBefore: options?.toDate,
        });
        
        for (const ro of result.content) {
          allWorkOrders.push(transformRepairOrder(ro));
        }
        
        if (result.last || result.content.length < size) {
          hasMore = false;
        } else {
          page++;
        }
      }
      
      return { ok: true, data: allWorkOrders };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Failed to fetch work orders' };
    }
  }

  async getCannedJobs(shopId: number): Promise<Result<CannedJob[]>> {
    const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
    if (!tekmetricShopId) {
      return { ok: false, error: 'Tekmetric shop ID not configured' };
    }
    
    try {
      const allJobs: CannedJob[] = [];
      let page = 0;
      let hasMore = true;
      const maxPages = 50;
      
      while (hasMore && page < maxPages) {
        const result = await getTekmetricCannedJobs(tekmetricShopId, { page, size: 100 });
        allJobs.push(...result.content.map(transformCannedJob));
        
        if (result.last || result.content.length < 100) {
          hasMore = false;
        } else {
          page++;
        }
      }
      
      return { ok: true, data: allJobs };
    } catch (err: any) {
      return { ok: false, error: err.message || 'Failed to fetch canned jobs' };
    }
  }

  async runIncrementalSync(shopId: number): Promise<SyncResult> {
    const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
    if (!tekmetricShopId) {
      return { ok: false, recordsProcessed: 0, error: 'Tekmetric shop ID not configured' };
    }
    
    try {
      const { runIncrementalSyncCycle } = await import('@/lib/tekmetric-incremental-sync');
      const result = await runIncrementalSyncCycle();
      const totalSynced = result.results.reduce((acc, r) => acc + (r.synced || 0), 0);
      return {
        ok: true,
        recordsProcessed: totalSynced,
      };
    } catch (err: any) {
      return { ok: false, recordsProcessed: 0, error: err.message };
    }
  }
}

export const tekmetricAdapter = new TekmetricAdapter();
