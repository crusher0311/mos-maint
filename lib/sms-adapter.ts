// lib/sms-adapter.ts
// Shop Management System (SMS) Adapter Interface
// Provides abstraction for multi-SMS support (Protractor, Tekmetric, AutoFlow, etc.)

export type SMSProvider = "protractor" | "tekmetric" | "autoflow";

export type SMSVehicle = {
  id: string;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  engine?: string;
  mileage?: number;
  customerId?: string;
};

export type SMSWorkOrder = {
  id: string;
  workOrderNumber?: number;
  status: string;
  stage?: string;
  vehicle: SMSVehicle;
  servicePackages: SMSServicePackage[];
  createdAt?: Date;
  updatedAt?: Date;
};

export type SMSServicePackage = {
  id: string;
  title: string;
  description?: string;
  code?: string;
  lines: SMSLineItem[];
  totals: {
    laborHours: number;
    laborAmount: number;
    partsAmount: number;
    totalAmount: number;
  };
};

export type SMSLineItem = {
  id: string;
  lineType: "labor" | "part" | "sublet" | "other";
  description: string;
  partNumber?: string;
  manufacturer?: string;
  quantity: number;
  unitPrice: number;
  extendedPrice: number;
};

export type SMSCannedJob = {
  id: string;
  code: string;
  title: string;
  description?: string;
  chapter?: string;
  lines: SMSLineItem[];
};

export interface ISMSAdapter {
  provider: SMSProvider;
  
  isConfigured(shopId: number): Promise<boolean>;
  
  getWorkOrders(shopId: number, options?: {
    status?: string[];
    stages?: string[];
    fromDate?: Date;
    toDate?: Date;
    limit?: number;
  }): Promise<{ ok: boolean; workOrders?: SMSWorkOrder[]; error?: string }>;
  
  getWorkOrderById(shopId: number, workOrderId: string): Promise<{ 
    ok: boolean; 
    workOrder?: SMSWorkOrder; 
    error?: string 
  }>;
  
  addServicePackageToWorkOrder(
    shopId: number,
    workOrderId: string,
    servicePackage: Omit<SMSServicePackage, "id">
  ): Promise<{ ok: boolean; error?: string }>;
  
  getCannedJobs(shopId: number): Promise<{ 
    ok: boolean; 
    cannedJobs?: SMSCannedJob[]; 
    error?: string 
  }>;
  
  getVehicle(shopId: number, vehicleId: string): Promise<{ 
    ok: boolean; 
    vehicle?: SMSVehicle; 
    error?: string 
  }>;
  
  getVehicleByVin(shopId: number, vin: string): Promise<{ 
    ok: boolean; 
    vehicle?: SMSVehicle; 
    error?: string 
  }>;
}

export class SMSAdapterRegistry {
  private static adapters: Map<SMSProvider, ISMSAdapter> = new Map();
  
  static register(adapter: ISMSAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }
  
  static get(provider: SMSProvider): ISMSAdapter | undefined {
    return this.adapters.get(provider);
  }
  
  static getAll(): ISMSAdapter[] {
    return Array.from(this.adapters.values());
  }
  
  static async getConfiguredAdapter(shopId: number): Promise<ISMSAdapter | null> {
    for (const adapter of this.adapters.values()) {
      if (await adapter.isConfigured(shopId)) {
        return adapter;
      }
    }
    return null;
  }
  
  static async getConfiguredProviders(shopId: number): Promise<SMSProvider[]> {
    const providers: SMSProvider[] = [];
    for (const adapter of this.adapters.values()) {
      if (await adapter.isConfigured(shopId)) {
        providers.push(adapter.provider);
      }
    }
    return providers;
  }
}

export async function getSMSAdapter(shopId: number): Promise<ISMSAdapter | null> {
  return SMSAdapterRegistry.getConfiguredAdapter(shopId);
}

export async function hasSMSConfigured(shopId: number): Promise<boolean> {
  const adapter = await getSMSAdapter(shopId);
  return adapter !== null;
}
