// lib/sms-adapters/protractor-adapter.ts
// Protractor SMS Adapter implementation

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
  resolveProtractorConfig,
  fetchWorkOrderById as protractorFetchWorkOrderById,
  fetchCannedJobs as protractorFetchCannedJobs,
  protractorFetch,
} from "@/lib/integrations/protractor";

function normalizeLineType(type?: string): SMSLineItem["lineType"] {
  if (!type) return "labor";
  const normalized = type.toLowerCase();
  if (normalized.includes("labor")) return "labor";
  if (normalized.includes("part") || normalized.includes("material")) return "part";
  if (normalized.includes("sublet")) return "sublet";
  return "other";
}

function transformWorkOrder(raw: any): SMSWorkOrder {
  const vehicle = raw.ServiceItem || raw.vehicle || {};
  const packagesRaw = raw.ServicePackages?.ItemCollection || raw.ServicePackages || [];
  const packages = Array.isArray(packagesRaw) ? packagesRaw : [];

  const servicePackages: SMSServicePackage[] = packages.map((pkg: any) => {
    const linesRaw = pkg.ServicePackageLines?.ItemCollection || pkg.ServicePackageLines || [];
    const lines: SMSLineItem[] = (Array.isArray(linesRaw) ? linesRaw : []).map((line: any) => ({
      id: line.ID || "",
      lineType: normalizeLineType(line.Type || line.LineType),
      description: line.Description || "",
      partNumber: line.PartNumber || undefined,
      manufacturer: line.Manufacturer || undefined,
      quantity: parseFloat(line.Quantity || "1") || 1,
      unitPrice: parseFloat(line.Price || line.UnitPrice || "0") || 0,
      extendedPrice: parseFloat(line.ExtendedTotal || line.Total || "0") || 0,
    }));

    let laborHours = 0, laborAmount = 0, partsAmount = 0, totalAmount = 0;
    for (const line of lines) {
      if (line.lineType === "labor") {
        laborHours += line.quantity;
        laborAmount += line.extendedPrice;
      } else if (line.lineType === "part") {
        partsAmount += line.extendedPrice;
      }
      totalAmount += line.extendedPrice;
    }

    return {
      id: pkg.ID || "",
      title: pkg.ServicePackageHeader?.Title || pkg.Title || "",
      description: pkg.ServicePackageHeader?.Description || pkg.Description || "",
      code: pkg.Code || "",
      lines,
      totals: { laborHours, laborAmount, partsAmount, totalAmount },
    };
  });

  return {
    id: raw.ID || raw.id,
    workOrderNumber: raw.WorkOrderNumber || raw.workOrderNumber,
    status: raw.Status || raw.status || "Unknown",
    stage: raw.Stage || raw.stage,
    vehicle: {
      id: vehicle.ID || vehicle.id || "",
      vin: vehicle.VIN || vehicle.vin,
      year: vehicle.Year || vehicle.year,
      make: vehicle.Make || vehicle.make,
      model: vehicle.Model || vehicle.model,
      engine: vehicle.Engine || vehicle.engine,
      mileage: vehicle.Mileage || vehicle.mileage,
      customerId: vehicle.CustomerID || vehicle.customerId,
    },
    servicePackages,
    createdAt: raw.Header?.CreationTime ? new Date(raw.Header.CreationTime) : undefined,
    updatedAt: raw.Header?.LastModifiedTime ? new Date(raw.Header.LastModifiedTime) : undefined,
  };
}

class ProtractorAdapter implements ISMSAdapter {
  provider: SMSProvider = "protractor";

  async isConfigured(shopId: number): Promise<boolean> {
    const config = await resolveProtractorConfig(shopId);
    return config.configured;
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
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: "Protractor not configured" };
    }

    try {
      const pageSize = 100;
      const maxWorkOrders = options?.limit || 5000;
      let allWorkOrders: any[] = [];
      let page = 1;

      while (allWorkOrders.length < maxWorkOrders) {
        const result = await protractorFetch<{ ItemCollection: any[] }>(
          `/WorkOrder?Page=${page}&PageSize=${pageSize}`,
          config,
          { method: "GET" }
        );

        if (!result.ok || !result.data?.ItemCollection) break;
        
        const items = result.data.ItemCollection;
        if (items.length === 0) break;
        
        allWorkOrders = allWorkOrders.concat(items);
        if (items.length < pageSize) break;
        page++;
      }

      let workOrders = allWorkOrders.map(transformWorkOrder);

      if (options?.stages?.length) {
        workOrders = workOrders.filter(wo => 
          options.stages!.includes(wo.stage || "")
        );
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
    const result = await protractorFetchWorkOrderById(shopId, workOrderId);
    if (!result.ok || !result.workOrder) {
      return { ok: false, error: result.error || "Work order not found" };
    }
    return { ok: true, workOrder: transformWorkOrder(result.workOrder) };
  }

  async addServicePackageToWorkOrder(
    shopId: number,
    workOrderId: string,
    servicePackage: Omit<SMSServicePackage, "id">
  ): Promise<{ ok: boolean; error?: string }> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: "Protractor not configured" };
    }

    const existingResult = await this.getWorkOrderById(shopId, workOrderId);
    if (!existingResult.ok || !existingResult.workOrder) {
      return { ok: false, error: "Work order not found" };
    }

    const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
    const mapLineType = (lineType: string): string => {
      switch (lineType) {
        case "labor": return "LaborLine";
        case "part": return "PartLine";
        case "sublet": return "SubletLine";
        default: return "OtherLine";
      }
    };

    const protractorLines = servicePackage.lines.map((line, idx) => ({
      ID: ZERO_GUID,
      Rank: idx + 1,
      Type: mapLineType(line.lineType),
      Description: line.description,
      Quantity: String(line.quantity),
      Unit: line.lineType === "labor" ? "Hour" : "Each",
      Price: line.unitPrice,
      PriceUnit: line.lineType === "labor" ? "Hour" : "Each",
      MinimumCharge: 0,
      Total: line.extendedPrice,
      Discount: 0,
      ExtendedTotal: line.extendedPrice,
      TotalCost: 0,
      PartNumber: line.partNumber || "",
      Manufacturer: line.manufacturer || "",
      Completed: false,
    }));

    const existingPackages = existingResult.workOrder.servicePackages.map(pkg => ({
      ID: pkg.id,
      Code: pkg.code,
      ServicePackageHeader: {
        Title: pkg.title,
        Description: pkg.description,
      },
      ServicePackageLines: {
        ItemCollection: pkg.lines.map(l => ({
          ID: l.id,
          Type: mapLineType(l.lineType),
          Description: l.description,
          Quantity: String(l.quantity),
          Price: l.unitPrice,
          ExtendedTotal: l.extendedPrice,
          PartNumber: l.partNumber || "",
          Manufacturer: l.manufacturer || "",
        })),
      },
    }));

    const newPackage = {
      ID: ZERO_GUID,
      Chapter: "Service",
      Code: servicePackage.code || `PKG-${Date.now()}`,
      Rank: existingPackages.length + 1,
      ServicePackageHeader: {
        Title: servicePackage.title,
        Description: servicePackage.description ? `${servicePackage.description} [Added by MOS]` : `[Added by MOS]`,
      },
      ServicePackageLines: {
        ItemCollection: protractorLines,
      },
    };

    const payload = {
      ID: workOrderId,
      ServicePackages: {
        ItemCollection: [...existingPackages, newPackage],
      },
    };

    const result = await protractorFetch<any>(
      `/WorkOrder/${workOrderId}`,
      config,
      { method: "POST", body: JSON.stringify(payload) }
    );

    if (!result.ok) {
      return { ok: false, error: result.error || "Failed to add service package" };
    }

    return { ok: true };
  }

  async getCannedJobs(shopId: number): Promise<{ 
    ok: boolean; 
    cannedJobs?: SMSCannedJob[]; 
    error?: string 
  }> {
    const result = await protractorFetchCannedJobs(shopId);
    if (!result.ok || !result.cannedJobs) {
      return { ok: false, error: result.error };
    }

    const cannedJobs: SMSCannedJob[] = result.cannedJobs.map((job: any) => {
      const linesRaw = job.ServicePackageLines?.ItemCollection || job.ServicePackageLines || [];
      const lines: SMSLineItem[] = (Array.isArray(linesRaw) ? linesRaw : []).map((line: any, idx: number) => ({
        id: line.ID || `line-${idx}`,
        lineType: normalizeLineType(line.Type || line.LineType),
        description: line.Description || "",
        partNumber: line.PartNumber,
        manufacturer: line.Manufacturer,
        quantity: parseFloat(line.Quantity || "1") || 1,
        unitPrice: parseFloat(line.Price || line.UnitPrice || "0") || 0,
        extendedPrice: parseFloat(line.ExtendedTotal || line.Total || "0") || 0,
      }));

      return {
        id: job.ID || "",
        code: job.Code || "",
        title: job.ServicePackageHeader?.Title || job.Title || "",
        description: job.ServicePackageHeader?.Description || job.Description,
        chapter: job.Chapter,
        lines,
      };
    });

    return { ok: true, cannedJobs };
  }

  async getVehicle(
    shopId: number, 
    vehicleId: string
  ): Promise<{ ok: boolean; vehicle?: SMSVehicle; error?: string }> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: "Protractor not configured" };
    }

    const result = await protractorFetch<any>(
      `/ServiceItem/${vehicleId}`,
      config,
      { method: "GET" }
    );

    if (!result.ok || !result.data) {
      return { ok: false, error: result.error || "Vehicle not found" };
    }

    const v = result.data;
    return {
      ok: true,
      vehicle: {
        id: v.ID || vehicleId,
        vin: v.VIN,
        year: v.Year,
        make: v.Make,
        model: v.Model,
        engine: v.Engine,
        mileage: v.Mileage,
        customerId: v.CustomerID,
      },
    };
  }

  async getVehicleByVin(
    shopId: number, 
    vin: string
  ): Promise<{ ok: boolean; vehicle?: SMSVehicle; error?: string }> {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { ok: false, error: "Protractor not configured" };
    }

    const result = await protractorFetch<{ ItemCollection: any[] }>(
      `/ServiceItem?vin=${encodeURIComponent(vin)}`,
      config,
      { method: "GET" }
    );

    if (!result.ok || !result.data?.ItemCollection?.length) {
      return { ok: false, error: "Vehicle not found" };
    }

    const v = result.data.ItemCollection[0];
    return {
      ok: true,
      vehicle: {
        id: v.ID,
        vin: v.VIN,
        year: v.Year,
        make: v.Make,
        model: v.Model,
        engine: v.Engine,
        mileage: v.Mileage,
        customerId: v.CustomerID,
      },
    };
  }
}

SMSAdapterRegistry.register(new ProtractorAdapter());

export { ProtractorAdapter };
