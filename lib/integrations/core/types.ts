import type { SourceSystem } from '@/lib/normalized-schema';

export type SMSProvider = 'protractor' | 'tekmetric' | 'autoflow';

export type Result<T> = 
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

export interface IntegrationConfig {
  provider: SMSProvider;
  configured: boolean;
  shopId: number;
  credentials: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface NormalizedVehicle {
  id: string;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  subModel?: string;
  engine?: string;
  transmission?: string;
  mileage?: number;
  mileageUnit?: 'miles' | 'kilometers';
  licensePlate?: string;
  color?: string;
  customerId?: string;
  sourceId: string;
  sourceSystem: SourceSystem;
}

export interface NormalizedCustomer {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  sourceId: string;
  sourceSystem: SourceSystem;
}

export interface NormalizedWorkOrder {
  id: string;
  workOrderNumber?: number;
  status: string;
  stage?: string;
  vehicle: NormalizedVehicle;
  customer?: NormalizedCustomer;
  serviceJobs: NormalizedServiceJob[];
  createdAt?: Date;
  updatedAt?: Date;
  closedAt?: Date;
  sourceId: string;
  sourceSystem: SourceSystem;
}

export interface NormalizedServiceJob {
  id: string;
  title: string;
  description?: string;
  code?: string;
  status: string;
  lines: NormalizedLineItem[];
  totals: {
    laborHours: number;
    laborAmount: number;
    partsAmount: number;
    totalAmount: number;
  };
  sourceId: string;
}

export interface NormalizedLineItem {
  id: string;
  lineType: 'labor' | 'part' | 'sublet' | 'fee' | 'other';
  description: string;
  partNumber?: string;
  manufacturer?: string;
  quantity: number;
  unitPrice: number;
  extendedPrice: number;
}

export interface CannedJob {
  id: string;
  code: string;
  title: string;
  description?: string;
  chapter?: string;
  lines: NormalizedLineItem[];
  sourceSystem: SourceSystem;
}

export interface DeclinedService {
  id: string;
  serviceItemId?: string;
  title: string;
  description?: string;
  declinedAt?: Date;
  reason?: string;
  estimatedCost?: number;
  sourceId: string;
  sourceSystem: SourceSystem;
}

export interface WorkOrderQuery {
  status?: string[];
  stages?: string[];
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
  vehicleId?: string;
  customerId?: string;
}

export interface BackfillOptions {
  fromDate?: Date;
  toDate?: Date;
  maxChunks?: number;
  chunkDays?: number;
}

export interface BackfillResult {
  ok: boolean;
  chunksProcessed: number;
  totalJobsIndexed: number;
  complete: boolean;
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  recordsProcessed: number;
  error?: string;
}

export interface IIntegrationAdapter {
  provider: SMSProvider;
  priority?: number;
  
  isConfigured(shopId: number): Promise<boolean>;
  getConfig(shopId: number): Promise<IntegrationConfig | null>;
  testConnection(shopId: number): Promise<Result<{ message: string }>>;
  
  getVehicle(shopId: number, vehicleId: string): Promise<Result<NormalizedVehicle>>;
  getVehicleByVin(shopId: number, vin: string): Promise<Result<NormalizedVehicle>>;
  
  getWorkOrder(shopId: number, workOrderId: string): Promise<Result<NormalizedWorkOrder>>;
  getWorkOrders(shopId: number, options?: WorkOrderQuery): Promise<Result<NormalizedWorkOrder[]>>;
  
  getCannedJobs(shopId: number): Promise<Result<CannedJob[]>>;
  getDeclinedServices?(shopId: number, vehicleId: string): Promise<Result<DeclinedService[]>>;
  
  runBackfill?(shopId: number, options?: BackfillOptions): Promise<BackfillResult>;
  runIncrementalSync?(shopId: number): Promise<SyncResult>;
}

export interface IIntegrationClient {
  provider: SMSProvider;
  
  request<T>(endpoint: string, options?: RequestInit, shopId?: number): Promise<T>;
  
  get<T>(endpoint: string, shopId?: number): Promise<T>;
  post<T>(endpoint: string, body: any, shopId?: number): Promise<T>;
  put<T>(endpoint: string, body: any, shopId?: number): Promise<T>;
  delete<T>(endpoint: string, shopId?: number): Promise<T>;
}
