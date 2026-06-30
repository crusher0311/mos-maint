import type { 
  IIntegrationAdapter, 
  IntegrationConfig,
  Result,
  NormalizedVehicle,
  NormalizedWorkOrder,
  CannedJob,
  DeclinedService,
  WorkOrderQuery,
  BackfillOptions,
  BackfillResult,
} from '@/lib/integrations/core/types';
import { findShopByShopId } from '@/lib/data/repositories/shops';
import { resolveProtractorConfig, protractorFetch, testConnection as testProtractorConnection } from './client';
import { transformVehicle, transformWorkOrder, transformCannedJob, transformDeferredWork } from './transform';
import type { ProtractorVehicle, ProtractorWorkOrder, ProtractorCannedJob, ProtractorDeferredWork } from './client';
import { withUpstreamTimeout } from '@/lib/with-upstream-timeout';

interface ProtractorShopDoc {
  shopId: number | string;
  preferences?: {
    distanceUnit?: 'miles' | 'kilometers';
  };
}

/**
 * Task #337: Protractor returns odometer values in whatever unit the shop
 * operates in. Look up the shop's distance preference so the normalized
 * `mileageUnit` field is honest (kilometers for Canadian shops) instead of
 * being hardcoded to "miles". Mirrors `getMileageUnit` in the Tekmetric
 * adapter (task #333).
 */
async function getMileageUnit(shopId: number): Promise<'miles' | 'kilometers'> {
  const shop = await findShopByShopId<ProtractorShopDoc>(shopId, { "preferences.distanceUnit": 1 });
  return shop?.preferences?.distanceUnit === 'kilometers' ? 'kilometers' : 'miles';
}

export class ProtractorAdapter implements IIntegrationAdapter {
  provider = 'protractor' as const;
  priority = 10;

  async isConfigured(shopId: number): Promise<boolean> {
    const config = await resolveProtractorConfig(shopId);
    return config.configured;
  }

  async getConfig(shopId: number): Promise<IntegrationConfig | null> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) return null;
    
    return {
      provider: 'protractor',
      configured: true,
      shopId,
      credentials: {
        connectionId: config.connectionId,
        hasApiKey: Boolean(config.apiKey),
      },
    };
  }

  async testConnection(shopId: number): Promise<Result<{ message: string }>> {
    const result = await testProtractorConnection(shopId);
    if (!result.ok) {
      return { ok: false, error: result.error || 'Connection test failed' };
    }
    return { ok: true, data: { message: 'Connection successful' } };
  }

  async getVehicle(shopId: number, vehicleId: string): Promise<Result<NormalizedVehicle>> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: 'Protractor not configured for this shop' };
    }

    const [result, mileageUnit] = await Promise.all([
      protractorFetch<ProtractorVehicle>(
        `/ServiceItem/${vehicleId}`,
        config,
        {},
        0,
        shopId
      ),
      getMileageUnit(shopId),
    ]);

    if (!result.ok || !result.data) {
      return { ok: false, error: result.error || 'Vehicle not found' };
    }

    return { ok: true, data: transformVehicle(result.data, { mileageUnit }) };
  }

  async getVehicleByVin(shopId: number, vin: string): Promise<Result<NormalizedVehicle>> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: 'Protractor not configured for this shop' };
    }

    const [result, mileageUnit] = await Promise.all([
      protractorFetch<{ ItemCollection?: ProtractorVehicle[] }>(
        `/ServiceItem/Search/${encodeURIComponent(vin)}`,
        config,
        {},
        0,
        shopId
      ),
      getMileageUnit(shopId),
    ]);

    if (!result.ok) {
      return { ok: false, error: result.error || 'Search failed' };
    }

    const vehicles = result.data?.ItemCollection || [];
    const match = vehicles.find(v => v.VIN?.toUpperCase() === vin.toUpperCase());

    if (!match) {
      return { ok: false, error: 'Vehicle not found' };
    }

    return { ok: true, data: transformVehicle(match, { mileageUnit }) };
  }

  async getWorkOrder(shopId: number, workOrderId: string): Promise<Result<NormalizedWorkOrder>> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: 'Protractor not configured for this shop' };
    }

    const [result, mileageUnit] = await Promise.all([
      protractorFetch<ProtractorWorkOrder>(
        `/WorkOrder/${workOrderId}`,
        config,
        {},
        0,
        shopId
      ),
      getMileageUnit(shopId),
    ]);

    if (!result.ok || !result.data) {
      return { ok: false, error: result.error || 'Work order not found' };
    }

    return { ok: true, data: transformWorkOrder(result.data, { mileageUnit }) };
  }

  async getWorkOrders(shopId: number, options?: WorkOrderQuery): Promise<Result<NormalizedWorkOrder[]>> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: 'Protractor not configured for this shop' };
    }

    const mileageUnit = await getMileageUnit(shopId);
    const allWorkOrders: NormalizedWorkOrder[] = [];
    const pageSize = options?.limit || 100;
    let skip = options?.offset || 0;
    let hasMore = true;
    const maxPages = 50;
    let pageCount = 0;

    while (hasMore && pageCount < maxPages) {
      const params = new URLSearchParams();
      if (options?.fromDate) params.set('startDate', options.fromDate.toISOString().split('T')[0]);
      if (options?.toDate) params.set('endDate', options.toDate.toISOString().split('T')[0]);
      params.set('take', String(pageSize));
      params.set('skip', String(skip));

      const result = await protractorFetch<{ ItemCollection?: ProtractorWorkOrder[] }>(
        `/WorkOrder/?${params.toString()}`,
        config,
        {},
        0,
        shopId
      );

      if (!result.ok) {
        if (skip === 0) {
          return { ok: false, error: result.error || 'Failed to fetch work orders' };
        }
        break;
      }

      const pageItems = result.data?.ItemCollection || [];
      allWorkOrders.push(...pageItems.map(item => transformWorkOrder(item, { mileageUnit })));

      if (pageItems.length < pageSize) {
        hasMore = false;
      } else {
        skip += pageSize;
        pageCount++;
      }
    }

    return { ok: true, data: allWorkOrders };
  }

  async getCannedJobs(shopId: number): Promise<Result<CannedJob[]>> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: 'Protractor not configured for this shop' };
    }

    const allJobs: CannedJob[] = [];
    const pageSize = 100;
    let skip = 0;
    let hasMore = true;
    const maxPages = 50;
    let pageCount = 0;

    while (hasMore && pageCount < maxPages) {
      const params = new URLSearchParams();
      params.set('take', String(pageSize));
      params.set('skip', String(skip));

      // Cap each page at 6s. A slow/hung Protractor API must not block the
      // extension canned-jobs request indefinitely — on timeout we return
      // whatever pages we already collected and let the caller's stale-cache
      // fallback cover a total miss (mirrors the Tekmetric branch's per-page
      // timeout in app/api/extension/canned-jobs/route.ts). The sentinel is a
      // synthetic non-ok Result so the existing handling below kicks in.
      const result = await withUpstreamTimeout(
        protractorFetch<{ ItemCollection?: ProtractorCannedJob[] }>(
          `/CannedJob/?${params.toString()}`,
          config,
          {},
          0,
          shopId
        ),
        6000,
        `protractor canned-jobs skip=${skip} shop=${shopId}`,
        { ok: false as const, error: 'protractor canned-jobs page timed out' },
      );

      if (!result.ok) {
        // On the very first page, a timeout/error means we have nothing to
        // return — surface the failure so the route falls back to stale cache.
        // On a later page, keep the pages we already collected (partial result).
        if (skip === 0) {
          return { ok: false, error: result.error || 'Failed to fetch canned jobs' };
        }
        break;
      }

      const pageItems = result.data?.ItemCollection || [];
      allJobs.push(...pageItems.map(transformCannedJob));

      if (pageItems.length < pageSize) {
        hasMore = false;
      } else {
        skip += pageSize;
        pageCount++;
      }
    }

    return { ok: true, data: allJobs };
  }

  async getDeclinedServices(shopId: number, vehicleId: string): Promise<Result<DeclinedService[]>> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: 'Protractor not configured for this shop' };
    }

    const result = await protractorFetch<{ ItemCollection?: ProtractorDeferredWork[] }>(
      `/DeferredWork/ServiceItem/${vehicleId}`,
      config,
      {},
      0,
      shopId
    );

    if (!result.ok) {
      return { ok: false, error: result.error || 'Failed to fetch deferred work' };
    }

    const items = result.data?.ItemCollection || [];
    return { ok: true, data: items.map(transformDeferredWork) };
  }

  async runBackfill(shopId: number, options?: BackfillOptions): Promise<BackfillResult> {
    try {
      const { runProtractorBackfill } = await import('@/lib/integrations/protractor/sync');
      const result = await runProtractorBackfill(shopId);
      return {
        ok: !result.error,
        chunksProcessed: result.chunksProcessed,
        totalJobsIndexed: result.totalJobsIndexed,
        complete: result.complete,
        error: result.error,
      };
    } catch (err: any) {
      return { 
        ok: false, 
        chunksProcessed: 0, 
        totalJobsIndexed: 0, 
        complete: false, 
        error: err.message 
      };
    }
  }
}

export const protractorAdapter = new ProtractorAdapter();
