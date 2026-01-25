import type { 
  IIntegrationAdapter, 
  SMSProvider, 
  IntegrationConfig,
  Result,
  NormalizedVehicle,
  NormalizedWorkOrder,
  CannedJob,
  WorkOrderQuery,
  BackfillOptions,
  BackfillResult,
  SyncResult,
} from './types';

class IntegrationRegistry {
  private adapters: Map<SMSProvider, IIntegrationAdapter> = new Map();
  
  register(adapter: IIntegrationAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }
  
  get(provider: SMSProvider): IIntegrationAdapter | undefined {
    return this.adapters.get(provider);
  }
  
  getAll(): IIntegrationAdapter[] {
    return Array.from(this.adapters.values());
  }
  
  async getConfiguredAdapter(shopId: number): Promise<IIntegrationAdapter | null> {
    const configuredAdapters: IIntegrationAdapter[] = [];
    for (const adapter of this.adapters.values()) {
      if (await adapter.isConfigured(shopId)) {
        configuredAdapters.push(adapter);
      }
    }
    if (configuredAdapters.length === 0) return null;
    configuredAdapters.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    return configuredAdapters[0];
  }
  
  async getConfiguredProviders(shopId: number): Promise<SMSProvider[]> {
    const providers: SMSProvider[] = [];
    for (const adapter of this.adapters.values()) {
      if (await adapter.isConfigured(shopId)) {
        providers.push(adapter.provider);
      }
    }
    return providers;
  }
}

export const integrationRegistry = new IntegrationRegistry();

export class IntegrationFacade {
  async getConfiguredProvider(shopId: number): Promise<SMSProvider | null> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    return adapter?.provider ?? null;
  }
  
  async getConfig(shopId: number): Promise<IntegrationConfig | null> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    if (!adapter) return null;
    return adapter.getConfig(shopId);
  }
  
  async testConnection(shopId: number): Promise<Result<{ message: string }>> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    if (!adapter) {
      return { ok: false, error: 'No integration configured for this shop' };
    }
    return adapter.testConnection(shopId);
  }
  
  async getVehicle(shopId: number, vehicleId: string): Promise<Result<NormalizedVehicle>> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    if (!adapter) {
      return { ok: false, error: 'No integration configured for this shop' };
    }
    return adapter.getVehicle(shopId, vehicleId);
  }
  
  async getVehicleByVin(shopId: number, vin: string): Promise<Result<NormalizedVehicle>> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    if (!adapter) {
      return { ok: false, error: 'No integration configured for this shop' };
    }
    return adapter.getVehicleByVin(shopId, vin);
  }
  
  async getWorkOrder(shopId: number, workOrderId: string): Promise<Result<NormalizedWorkOrder>> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    if (!adapter) {
      return { ok: false, error: 'No integration configured for this shop' };
    }
    return adapter.getWorkOrder(shopId, workOrderId);
  }
  
  async getWorkOrders(shopId: number, options?: WorkOrderQuery): Promise<Result<NormalizedWorkOrder[]>> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    if (!adapter) {
      return { ok: false, error: 'No integration configured for this shop' };
    }
    return adapter.getWorkOrders(shopId, options);
  }
  
  async getCannedJobs(shopId: number): Promise<Result<CannedJob[]>> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    if (!adapter) {
      return { ok: false, error: 'No integration configured for this shop' };
    }
    return adapter.getCannedJobs(shopId);
  }
  
  async runBackfill(shopId: number, options?: BackfillOptions): Promise<BackfillResult> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    if (!adapter) {
      return { ok: false, chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: 'No integration configured' };
    }
    if (!adapter.runBackfill) {
      return { ok: false, chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: 'Backfill not supported' };
    }
    return adapter.runBackfill(shopId, options);
  }
  
  async runIncrementalSync(shopId: number): Promise<SyncResult> {
    const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
    if (!adapter) {
      return { ok: false, recordsProcessed: 0, error: 'No integration configured' };
    }
    if (!adapter.runIncrementalSync) {
      return { ok: false, recordsProcessed: 0, error: 'Incremental sync not supported' };
    }
    return adapter.runIncrementalSync(shopId);
  }
  
  getAdapter(provider: SMSProvider): IIntegrationAdapter | undefined {
    return integrationRegistry.get(provider);
  }
}

export const integrationFacade = new IntegrationFacade();

export async function getConfiguredAdapter(shopId: number): Promise<IIntegrationAdapter | null> {
  return integrationRegistry.getConfiguredAdapter(shopId);
}

export async function hasIntegrationConfigured(shopId: number): Promise<boolean> {
  const adapter = await integrationRegistry.getConfiguredAdapter(shopId);
  return adapter !== null;
}
