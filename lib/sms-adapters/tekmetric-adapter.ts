import {
  ISMSAdapter,
  SMSProvider,
  SMSWorkOrder,
  SMSServicePackage,
  SMSLineItem,
  SMSVehicle,
  SMSCannedJob,
  SMSAdapterRegistry,
} from "@/lib/sms-adapter";
import {
  getVehicle as tekmetricGetVehicle,
  searchVehiclesByVin,
  getRepairOrders,
  getRepairOrder,
  getJobs,
  getCannedJobs as tekmetricGetCannedJobs,
  isConfigured as tekmetricHasCredentials,
} from "@/lib/integrations/tekmetric/client";
import { shopRepository } from "@/lib/data/repositories";
import type { TekmetricVehicle, TekmetricRepairOrder, TekmetricJob, TekmetricCannedJob } from "@/lib/integrations/tekmetric/types";

function transformVehicle(v: TekmetricVehicle): SMSVehicle {
  return {
    id: String(v.id),
    vin: v.vin,
    year: v.year,
    make: v.make,
    model: v.model,
    engine: v.engine,
    mileage: v.mileageIn || v.mileageOut,
    customerId: v.customerId ? String(v.customerId) : undefined,
  };
}

function transformJob(job: TekmetricJob): SMSServicePackage {
  const lines: SMSLineItem[] = [];
  
  if (job.laborAmount && job.laborAmount > 0) {
    lines.push({
      id: `${job.id}-labor`,
      lineType: "labor",
      description: `${job.name} - Labor`,
      quantity: 1,
      unitPrice: job.laborAmount,
      extendedPrice: job.laborAmount,
    });
  }
  
  if (job.partsAmount && job.partsAmount > 0) {
    lines.push({
      id: `${job.id}-parts`,
      lineType: "part",
      description: `${job.name} - Parts`,
      quantity: 1,
      unitPrice: job.partsAmount,
      extendedPrice: job.partsAmount,
    });
  }

  return {
    id: String(job.id),
    title: job.name,
    description: job.authorized ? "Authorized" : "Not Authorized",
    code: String(job.id),
    lines,
    totals: {
      laborHours: 0,
      laborAmount: job.laborAmount || 0,
      partsAmount: job.partsAmount || 0,
      totalAmount: job.totalAmount || 0,
    },
  };
}

function transformRepairOrder(ro: TekmetricRepairOrder, jobs: TekmetricJob[] = []): SMSWorkOrder {
  return {
    id: String(ro.id),
    workOrderNumber: ro.repairOrderNumber,
    status: ro.status || "Unknown",
    stage: ro.label?.text,
    vehicle: {
      id: String(ro.vehicleId),
      customerId: String(ro.customerId),
      mileage: ro.mileageIn || ro.mileageOut,
    },
    servicePackages: jobs.map(transformJob),
    createdAt: ro.createdDate ? new Date(ro.createdDate) : undefined,
    updatedAt: ro.updatedDate ? new Date(ro.updatedDate) : undefined,
  };
}

function transformCannedJob(cj: TekmetricCannedJob): SMSCannedJob {
  const lines: SMSLineItem[] = [];
  
  if (cj.laborAmount && cj.laborAmount > 0) {
    lines.push({
      id: `${cj.id}-labor`,
      lineType: "labor",
      description: `${cj.name} - Labor`,
      quantity: 1,
      unitPrice: cj.laborAmount,
      extendedPrice: cj.laborAmount,
    });
  }
  
  if (cj.partsAmount && cj.partsAmount > 0) {
    lines.push({
      id: `${cj.id}-parts`,
      lineType: "part",
      description: `${cj.name} - Parts`,
      quantity: 1,
      unitPrice: cj.partsAmount,
      extendedPrice: cj.partsAmount,
    });
  }

  return {
    id: String(cj.id),
    code: String(cj.id),
    title: cj.name,
    lines,
  };
}

class TekmetricAdapter implements ISMSAdapter {
  provider: SMSProvider = "tekmetric";

  async isConfigured(shopId: number): Promise<boolean> {
    if (!tekmetricHasCredentials()) return false;
    const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
    return tekmetricShopId !== null;
  }

  async getWorkOrders(
    shopId: number,
    options?: {
      status?: string[];
      stages?: string[];
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
    }
  ): Promise<{ ok: boolean; workOrders?: SMSWorkOrder[]; error?: string }> {
    try {
      const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
      if (!tekmetricShopId) {
        return { ok: false, error: "Tekmetric shop ID not found" };
      }

      const result = await getRepairOrders(tekmetricShopId, {
        size: options?.limit || 100,
        status: options?.status?.[0],
        updatedAfter: options?.fromDate,
        updatedBefore: options?.toDate,
      });

      const workOrders: SMSWorkOrder[] = [];
      for (const ro of result.content) {
        const jobs = await getJobs(ro.id, tekmetricShopId);
        workOrders.push(transformRepairOrder(ro, jobs.content || []));
      }

      return { ok: true, workOrders };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  async getWorkOrderById(
    shopId: number,
    workOrderId: string
  ): Promise<{ ok: boolean; workOrder?: SMSWorkOrder; error?: string }> {
    try {
      const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
      if (!tekmetricShopId) {
        return { ok: false, error: "Tekmetric shop ID not found" };
      }
      const ro = await getRepairOrder(parseInt(workOrderId), tekmetricShopId);
      const jobs = await getJobs(ro.id, tekmetricShopId);
      
      return { ok: true, workOrder: transformRepairOrder(ro, jobs.content || []) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  async addServicePackageToWorkOrder(
    _shopId: number,
    _workOrderId: string,
    _servicePackage: Omit<SMSServicePackage, "id">
  ): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "Adding service packages is not supported for Tekmetric" };
  }

  async getCannedJobs(shopId: number): Promise<{ 
    ok: boolean; 
    cannedJobs?: SMSCannedJob[]; 
    error?: string 
  }> {
    try {
      const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
      if (!tekmetricShopId) {
        return { ok: false, error: "Tekmetric shop ID not found" };
      }

      const result = await tekmetricGetCannedJobs(tekmetricShopId);
      const cannedJobs = result.content.map(transformCannedJob);
      
      return { ok: true, cannedJobs };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  async getVehicle(
    shopId: number, 
    vehicleId: string
  ): Promise<{ ok: boolean; vehicle?: SMSVehicle; error?: string }> {
    try {
      const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
      if (!tekmetricShopId) {
        return { ok: false, error: "Tekmetric shop ID not found" };
      }
      const vehicle = await tekmetricGetVehicle(parseInt(vehicleId), tekmetricShopId);
      
      return { ok: true, vehicle: transformVehicle(vehicle) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  async getVehicleByVin(
    shopId: number, 
    vin: string
  ): Promise<{ ok: boolean; vehicle?: SMSVehicle; error?: string }> {
    try {
      const tekmetricShopId = await shopRepository.getTekmetricShopId(shopId);
      if (!tekmetricShopId) {
        return { ok: false, error: "Tekmetric shop ID not found" };
      }

      const result = await searchVehiclesByVin(tekmetricShopId, vin);
      
      if (!result.content || result.content.length === 0) {
        return { ok: false, error: "Vehicle not found" };
      }

      return { ok: true, vehicle: transformVehicle(result.content[0]) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }
}

SMSAdapterRegistry.register(new TekmetricAdapter());

export { TekmetricAdapter };
