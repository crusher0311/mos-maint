export interface SyncConfig {
  maxPagesPerCycle: number;
  maxRecordsPerPage: number;
  maxQueuedPages: number;
  timeboxMs: number;
  cacheTtlMs: number;
  staleThresholdMs: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  maxPagesPerCycle: 3,
  maxRecordsPerPage: 100,
  maxQueuedPages: 20,
  timeboxMs: 55000,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  staleThresholdMs: 30 * 60 * 1000,
};

export interface SyncState {
  shopId: number;
  provider: string;
  status: "idle" | "running" | "completed" | "failed" | "stale";
  cursor?: string;
  cursorTimestamp?: Date;
  overflowQueue: string[];
  lastSyncAt?: Date;
  lastSweepAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface SyncProgress {
  pagesProcessed: number;
  recordsProcessed: number;
  recordsIndexed: number;
  recordsFailed: number;
  duration: number;
}

export interface SyncResult {
  success: boolean;
  progress: SyncProgress;
  error?: string;
  nextCursor?: string;
  hasMore: boolean;
}

export interface PageResult<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
  totalCount?: number;
}

export interface SyncProvider<TRecord, TTransformed> {
  provider: string;
  
  fetchPage(
    shopId: number,
    cursor?: string,
    pageSize?: number
  ): Promise<PageResult<TRecord>>;
  
  transform(
    record: TRecord,
    shopId: number
  ): Promise<TTransformed | null>;
  
  persist(
    items: TTransformed[],
    shopId: number
  ): Promise<number>;
  
  getShopConfig(shopId: number): Promise<{ configured: boolean; [key: string]: unknown }>;
  
  shouldSweep?(state: SyncState): boolean;
  
  onSweep?(shopId: number): Promise<void>;
}

export interface SyncRunner {
  run(shopId: number): Promise<SyncResult>;
  runAll(): Promise<Map<number, SyncResult>>;
  getState(shopId: number): Promise<SyncState | null>;
  resetState(shopId: number): Promise<void>;
  markStale(shopId: number): Promise<void>;
}
