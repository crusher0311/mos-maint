import {
  ISMSAdapter,
  SMSProvider,
  SMSWorkOrder,
  SMSServicePackage,
  SMSVehicle,
  SMSCannedJob,
  SMSAdapterRegistry,
} from "@/lib/sms-adapter";
import {
  resolveAutoflowConfig,
  fetchDviByInvoice,
} from "@/lib/integrations/autoflow/client";

class AutoFlowAdapter implements ISMSAdapter {
  provider: SMSProvider = "autoflow";

  async isConfigured(shopId: number): Promise<boolean> {
    const config = await resolveAutoflowConfig(shopId);
    return config.configured;
  }

  async getWorkOrders(
    _shopId: number,
    _options?: {
      status?: string[];
      stages?: string[];
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
    }
  ): Promise<{ ok: boolean; workOrders?: SMSWorkOrder[]; error?: string }> {
    return { 
      ok: false, 
      error: "AutoFlow is a DVI-only integration and does not support work order listing" 
    };
  }

  async getWorkOrderById(
    shopId: number,
    workOrderId: string
  ): Promise<{ ok: boolean; workOrder?: SMSWorkOrder; error?: string }> {
    try {
      const dviResult = await fetchDviByInvoice(shopId, workOrderId);
      
      if (!dviResult.ok) {
        return { ok: false, error: dviResult.error };
      }

      const workOrder: SMSWorkOrder = {
        id: workOrderId,
        workOrderNumber: parseInt(workOrderId) || undefined,
        status: "Unknown",
        vehicle: {
          id: "",
          vin: dviResult.vin || undefined,
          mileage: dviResult.mileage || undefined,
        },
        servicePackages: [],
        createdAt: dviResult.timestamp ? new Date(dviResult.timestamp) : undefined,
      };

      return { ok: true, workOrder };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  async addServicePackageToWorkOrder(
    _shopId: number,
    _workOrderId: string,
    _servicePackage: Omit<SMSServicePackage, "id">
  ): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "AutoFlow is a DVI-only integration and does not support adding service packages" };
  }

  async getCannedJobs(_shopId: number): Promise<{ 
    ok: boolean; 
    cannedJobs?: SMSCannedJob[]; 
    error?: string 
  }> {
    return { 
      ok: false, 
      error: "AutoFlow is a DVI-only integration and does not support canned jobs" 
    };
  }

  async getVehicle(
    _shopId: number, 
    _vehicleId: string
  ): Promise<{ ok: boolean; vehicle?: SMSVehicle; error?: string }> {
    return { 
      ok: false, 
      error: "AutoFlow is a DVI-only integration and does not support vehicle lookup" 
    };
  }

  async getVehicleByVin(
    _shopId: number, 
    _vin: string
  ): Promise<{ ok: boolean; vehicle?: SMSVehicle; error?: string }> {
    return { 
      ok: false, 
      error: "AutoFlow is a DVI-only integration and does not support vehicle lookup" 
    };
  }
}

SMSAdapterRegistry.register(new AutoFlowAdapter());

export { AutoFlowAdapter };
