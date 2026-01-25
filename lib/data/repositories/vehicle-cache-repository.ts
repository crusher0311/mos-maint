import { BaseRepository } from "./base-repository";
import { ObjectId } from "mongodb";

export interface ProtractorVehicleCache {
  _id?: ObjectId;
  shopId: number;
  vehicleId: string;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  engine?: string;
  transmission?: string;
  mileage?: number;
  customerId?: string;
  data?: Record<string, unknown>;
  cachedAt: Date;
  expiresAt?: Date;
}

export interface ProtractorWorkOrderCache {
  _id?: ObjectId;
  shopId: number;
  workOrderId: string;
  vehicleId?: string;
  customerId?: string;
  status?: string;
  jobs?: Array<{
    id?: string;
    name?: string;
    laborAmount?: number;
    partsAmount?: number;
    status?: string;
  }>;
  totalAmount?: number;
  createdAt?: Date;
  completedAt?: Date;
  data?: Record<string, unknown>;
  cachedAt: Date;
  expiresAt?: Date;
}

export interface ProtractorDeferredWorkCache {
  _id?: ObjectId;
  shopId: number;
  vehicleId: string;
  items?: Array<{
    id?: string;
    description?: string;
    amount?: number;
    declinedAt?: Date;
  }>;
  data?: Record<string, unknown>;
  cachedAt: Date;
  expiresAt?: Date;
}

export interface ProtractorCannedJobsCache {
  _id?: ObjectId;
  shopId: number;
  jobs?: Array<{
    id?: string;
    name?: string;
    description?: string;
    laborAmount?: number;
    partsAmount?: number;
    category?: string;
  }>;
  cachedAt: Date;
  expiresAt?: Date;
}

class ProtractorVehicleCacheRepository extends BaseRepository<ProtractorVehicleCache> {
  protected collectionName = "protractor_vehicles";
  
  async findByVehicleId(shopId: number, vehicleId: string): Promise<ProtractorVehicleCache | null> {
    return this.findOne({ shopId, vehicleId });
  }
  
  async findByVin(shopId: number, vin: string): Promise<ProtractorVehicleCache | null> {
    return this.findOne({ shopId, vin });
  }
  
  async upsertVehicle(vehicle: Omit<ProtractorVehicleCache, "_id">): Promise<boolean> {
    return this.upsertOne(
      { shopId: vehicle.shopId, vehicleId: vehicle.vehicleId },
      { $set: vehicle }
    );
  }
  
  async isExpired(shopId: number, vehicleId: string): Promise<boolean> {
    const cached = await this.findByVehicleId(shopId, vehicleId);
    if (!cached) return true;
    if (!cached.expiresAt) return false;
    return new Date() > cached.expiresAt;
  }
}

class ProtractorWorkOrderCacheRepository extends BaseRepository<ProtractorWorkOrderCache> {
  protected collectionName = "protractor_work_orders";
  
  async findByWorkOrderId(shopId: number, workOrderId: string): Promise<ProtractorWorkOrderCache | null> {
    return this.findOne({ shopId, workOrderId });
  }
  
  async findByVehicleId(shopId: number, vehicleId: string): Promise<ProtractorWorkOrderCache[]> {
    return this.findMany({ shopId, vehicleId });
  }
  
  async upsertWorkOrder(workOrder: Omit<ProtractorWorkOrderCache, "_id">): Promise<boolean> {
    return this.upsertOne(
      { shopId: workOrder.shopId, workOrderId: workOrder.workOrderId },
      { $set: workOrder }
    );
  }
  
  async findRecentByShop(shopId: number, limit = 100): Promise<ProtractorWorkOrderCache[]> {
    return this.findMany(
      { shopId },
      { sort: { completedAt: -1 }, limit }
    );
  }
}

class ProtractorDeferredWorkCacheRepository extends BaseRepository<ProtractorDeferredWorkCache> {
  protected collectionName = "protractor_deferred_work";
  
  async findByVehicleId(shopId: number, vehicleId: string): Promise<ProtractorDeferredWorkCache | null> {
    return this.findOne({ shopId, vehicleId });
  }
  
  async upsertDeferredWork(deferred: Omit<ProtractorDeferredWorkCache, "_id">): Promise<boolean> {
    return this.upsertOne(
      { shopId: deferred.shopId, vehicleId: deferred.vehicleId },
      { $set: deferred }
    );
  }
}

class ProtractorCannedJobsCacheRepository extends BaseRepository<ProtractorCannedJobsCache> {
  protected collectionName = "protractor_canned_jobs";
  
  async findByShop(shopId: number): Promise<ProtractorCannedJobsCache | null> {
    return this.findOne({ shopId });
  }
  
  async upsertCannedJobs(cache: Omit<ProtractorCannedJobsCache, "_id">): Promise<boolean> {
    return this.upsertOne(
      { shopId: cache.shopId },
      { $set: cache }
    );
  }
}

export const protractorVehicleCache = new ProtractorVehicleCacheRepository();
export const protractorWorkOrderCache = new ProtractorWorkOrderCacheRepository();
export const protractorDeferredWorkCache = new ProtractorDeferredWorkCacheRepository();
export const protractorCannedJobsCache = new ProtractorCannedJobsCacheRepository();
