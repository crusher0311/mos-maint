import { getDb } from '@/lib/mongo';
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
  SyncResult,
} from '@/lib/integrations/core/types';
import {
  isConfigured,
  testConnection as testSwConnection,
  getVehicle as getSwVehicle,
  searchVehiclesByVin,
  getRepairOrder,
  getRepairOrders,
  getCannedJobs as getSwCannedJobs,
  getPastRecommendations,
} from './client';
import {
  transformVehicle,
  transformRepairOrder,
  transformCannedJob,
  transformPastRecommendation,
} from './transform';

async function getSwConfig(shopId: number): Promise<{ tenantId: number; swShopId: number } | null> {
  const db = await getDb();
  const shop = await db.collection('shops').findOne(
    { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
    { projection: { 'shopware': 1 } }
  );

  const cfg = shop?.shopware;
  if (!cfg?.tenantId || !cfg?.swShopId) return null;
  return { tenantId: cfg.tenantId, swShopId: cfg.swShopId };
}

export class ShopWareAdapter implements IIntegrationAdapter {
  provider = 'shopware' as const;
  priority = 10;

  async isConfigured(shopId: number): Promise<boolean> {
    if (!isConfigured()) return false;
    const cfg = await getSwConfig(shopId);
    return cfg !== null;
  }

  async getConfig(shopId: number): Promise<IntegrationConfig | null> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) return null;

    return {
      provider: 'shopware',
      configured: true,
      shopId,
      credentials: {
        tenantId: cfg.tenantId,
        swShopId: cfg.swShopId,
      },
    };
  }

  async testConnection(shopId: number): Promise<Result<{ message: string }>> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) return { ok: false, error: 'Shop-Ware not configured for this shop' };

    const result = await testSwConnection(cfg.tenantId);
    if (!result.ok) return { ok: false, error: result.error ?? 'Connection test failed' };
    return { ok: true, data: { message: 'Shop-Ware connection successful' } };
  }

  async getVehicle(shopId: number, vehicleId: string): Promise<Result<NormalizedVehicle>> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) return { ok: false, error: 'Shop-Ware not configured' };

    try {
      const vehicle = await getSwVehicle(cfg.tenantId, parseInt(vehicleId, 10), shopId);
      return { ok: true, data: transformVehicle(vehicle) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'Vehicle not found' };
    }
  }

  async getVehicleByVin(shopId: number, vin: string): Promise<Result<NormalizedVehicle>> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) return { ok: false, error: 'Shop-Ware not configured' };

    try {
      const matches = await searchVehiclesByVin(cfg.tenantId, vin, shopId);
      if (!matches.length) return { ok: false, error: 'Vehicle not found' };
      return { ok: true, data: transformVehicle(matches[0]) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'Search failed' };
    }
  }

  async getWorkOrder(shopId: number, workOrderId: string): Promise<Result<NormalizedWorkOrder>> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) return { ok: false, error: 'Shop-Ware not configured' };

    try {
      const ro = await getRepairOrder(cfg.tenantId, parseInt(workOrderId, 10), shopId);
      return { ok: true, data: transformRepairOrder(ro) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'Work order not found' };
    }
  }

  async getWorkOrders(shopId: number, options?: WorkOrderQuery): Promise<Result<NormalizedWorkOrder[]>> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) return { ok: false, error: 'Shop-Ware not configured' };

    try {
      const ros = await getRepairOrders(cfg.tenantId, shopId, {
        shop_id: cfg.swShopId,
        updated_after: options?.fromDate?.toISOString(),
        vehicle_id: options?.vehicleId ? parseInt(options.vehicleId, 10) : undefined,
        customer_id: options?.customerId ? parseInt(options.customerId, 10) : undefined,
      });

      return { ok: true, data: ros.map(transformRepairOrder) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'Failed to fetch work orders' };
    }
  }

  async getCannedJobs(shopId: number): Promise<Result<CannedJob[]>> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) return { ok: false, error: 'Shop-Ware not configured' };

    try {
      const jobs = await getSwCannedJobs(cfg.tenantId, shopId);
      return { ok: true, data: jobs.map(transformCannedJob) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'Failed to fetch canned jobs' };
    }
  }

  async getDeclinedServices(shopId: number, vehicleId: string): Promise<Result<DeclinedService[]>> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) return { ok: false, error: 'Shop-Ware not configured' };

    try {
      const recs = await getPastRecommendations(cfg.tenantId, parseInt(vehicleId, 10), shopId);
      return { ok: true, data: recs.map(transformPastRecommendation) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'Failed to fetch declined services' };
    }
  }

  async runIncrementalSync(shopId: number): Promise<SyncResult> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) return { ok: false, recordsProcessed: 0, error: 'Shop-Ware not configured' };

    try {
      const db = await getDb();
      const shop = await db.collection('shops').findOne(
        { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
        { projection: { 'shopware.lastSyncAt': 1 } }
      );

      const lastSyncAt = shop?.shopware?.lastSyncAt
        ? new Date(shop.shopware.lastSyncAt).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const ros = await getRepairOrders(cfg.tenantId, shopId, {
        shop_id: cfg.swShopId,
        updated_after: lastSyncAt,
        associations: 'services,services.labors,services.parts,customer,vehicle',
      });

      await db.collection('shops').updateOne(
        { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
        { $set: { 'shopware.lastSyncAt': new Date().toISOString() } }
      );

      return { ok: true, recordsProcessed: ros.length };
    } catch (err: any) {
      return { ok: false, recordsProcessed: 0, error: err.message };
    }
  }

  async runBackfill(shopId: number, options?: BackfillOptions): Promise<BackfillResult> {
    const cfg = await getSwConfig(shopId);
    if (!cfg) {
      return { ok: false, chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: 'Shop-Ware not configured' };
    }

    try {
      const fromDate = options?.fromDate ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

      const ros = await getRepairOrders(cfg.tenantId, shopId, {
        shop_id: cfg.swShopId,
        closed_after: fromDate.toISOString(),
        associations: 'services,services.labors,services.parts,customer,vehicle',
      });

      const db = await getDb();
      await db.collection('shops').updateOne(
        { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
        { $set: { 'shopware.lastBackfillAt': new Date().toISOString(), 'shopware.lastSyncAt': new Date().toISOString() } }
      );

      const totalJobs = ros.reduce((sum, ro) => sum + (ro.services?.length ?? 0), 0);

      return {
        ok: true,
        chunksProcessed: 1,
        totalJobsIndexed: totalJobs,
        complete: true,
      };
    } catch (err: any) {
      return { ok: false, chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: err.message };
    }
  }
}

export const shopWareAdapter = new ShopWareAdapter();
