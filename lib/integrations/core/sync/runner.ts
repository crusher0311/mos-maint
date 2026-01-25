import { syncStateRepository, type SyncStateDocument } from "@/lib/data/repositories";
import {
  SyncConfig,
  SyncProvider,
  SyncResult,
  SyncState,
  SyncProgress,
  DEFAULT_SYNC_CONFIG,
  SyncRunner as ISyncRunner,
} from "./types";

export class SyncRunner<TRecord, TTransformed> implements ISyncRunner {
  private provider: SyncProvider<TRecord, TTransformed>;
  private config: SyncConfig;
  
  constructor(
    provider: SyncProvider<TRecord, TTransformed>,
    config: Partial<SyncConfig> = {}
  ) {
    this.provider = provider;
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
  }
  
  async run(shopId: number): Promise<SyncResult> {
    const startTime = Date.now();
    const progress: SyncProgress = {
      pagesProcessed: 0,
      recordsProcessed: 0,
      recordsIndexed: 0,
      recordsFailed: 0,
      duration: 0,
    };
    
    try {
      const shopConfig = await this.provider.getShopConfig(shopId);
      if (!shopConfig.configured) {
        return {
          success: false,
          progress,
          error: `${this.provider.provider} not configured for shop ${shopId}`,
          hasMore: false,
        };
      }
      
      const isStale = await syncStateRepository.isStale(
        shopId,
        this.provider.provider as SyncStateDocument["provider"],
        this.config.staleThresholdMs
      );
      
      if (isStale) {
        await syncStateRepository.markStale(
          shopId,
          this.provider.provider as SyncStateDocument["provider"]
        );
      }
      
      const existingState = await syncStateRepository.findByShopAndProvider(
        shopId,
        this.provider.provider as SyncStateDocument["provider"]
      );
      
      if (existingState?.status === "running" && !isStale) {
        return {
          success: false,
          progress,
          error: "Sync already in progress",
          hasMore: false,
        };
      }
      
      await syncStateRepository.startSync(
        shopId,
        this.provider.provider as SyncStateDocument["provider"]
      );
      
      let cursor = existingState?.cursor;
      let hasMore = true;
      let pagesThisCycle = 0;
      
      while (
        hasMore &&
        pagesThisCycle < this.config.maxPagesPerCycle &&
        Date.now() - startTime < this.config.timeboxMs
      ) {
        const pageResult = await this.provider.fetchPage(
          shopId,
          cursor,
          this.config.maxRecordsPerPage
        );
        
        progress.pagesProcessed++;
        pagesThisCycle++;
        
        const transformedItems: TTransformed[] = [];
        for (const record of pageResult.items) {
          try {
            const transformed = await this.provider.transform(record, shopId);
            if (transformed) {
              transformedItems.push(transformed);
            }
            progress.recordsProcessed++;
          } catch {
            progress.recordsFailed++;
          }
        }
        
        if (transformedItems.length > 0) {
          const indexed = await this.provider.persist(transformedItems, shopId);
          progress.recordsIndexed += indexed;
        }
        
        cursor = pageResult.nextCursor;
        hasMore = pageResult.hasMore;
        
        if (cursor) {
          await syncStateRepository.updateCursor(
            shopId,
            this.provider.provider as SyncStateDocument["provider"],
            cursor
          );
        }
        
        await syncStateRepository.updateProgress(
          shopId,
          this.provider.provider as SyncStateDocument["provider"],
          {
            processedPages: progress.pagesProcessed,
            processedRecords: progress.recordsProcessed,
            percentage: pageResult.totalCount
              ? Math.round((progress.recordsProcessed / pageResult.totalCount) * 100)
              : undefined,
          }
        );
      }
      
      if (hasMore && cursor) {
        await syncStateRepository.addToOverflowQueue(
          shopId,
          this.provider.provider as SyncStateDocument["provider"],
          [cursor]
        );
      }
      
      progress.duration = Date.now() - startTime;
      
      const shouldSweep = this.provider.shouldSweep
        ? this.provider.shouldSweep(await this.toSyncState(existingState))
        : false;
        
      if (shouldSweep && this.provider.onSweep) {
        await this.provider.onSweep(shopId);
      }
      
      await syncStateRepository.completeSync(
        shopId,
        this.provider.provider as SyncStateDocument["provider"],
        {
          duration: progress.duration,
          recordsProcessed: progress.recordsProcessed,
          recordsFailed: progress.recordsFailed,
          apiCalls: progress.pagesProcessed,
        }
      );
      
      return {
        success: true,
        progress,
        nextCursor: cursor,
        hasMore,
      };
    } catch (error) {
      progress.duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      await syncStateRepository.failSync(
        shopId,
        this.provider.provider as SyncStateDocument["provider"],
        errorMessage
      );
      
      return {
        success: false,
        progress,
        error: errorMessage,
        hasMore: false,
      };
    }
  }
  
  async runAll(): Promise<Map<number, SyncResult>> {
    const results = new Map<number, SyncResult>();
    return results;
  }
  
  async getState(shopId: number): Promise<SyncState | null> {
    const state = await syncStateRepository.findByShopAndProvider(
      shopId,
      this.provider.provider as SyncStateDocument["provider"]
    );
    return state ? this.toSyncState(state) : null;
  }
  
  async resetState(shopId: number): Promise<void> {
    await syncStateRepository.updateOne(
      { shopId, provider: this.provider.provider as SyncStateDocument["provider"] },
      {
        $set: {
          status: "idle",
          cursor: undefined,
          cursorTimestamp: undefined,
          overflowQueue: [],
          error: undefined,
          updatedAt: new Date(),
        },
      }
    );
  }
  
  async markStale(shopId: number): Promise<void> {
    await syncStateRepository.markStale(
      shopId,
      this.provider.provider as SyncStateDocument["provider"]
    );
  }
  
  private toSyncState(doc: SyncStateDocument | null): SyncState {
    if (!doc) {
      return {
        shopId: 0,
        provider: this.provider.provider,
        status: "idle",
        overflowQueue: [],
      };
    }
    
    return {
      shopId: doc.shopId,
      provider: doc.provider,
      status: doc.status,
      cursor: doc.cursor,
      cursorTimestamp: doc.cursorTimestamp,
      overflowQueue: doc.overflowQueue || [],
      lastSyncAt: doc.lastSyncAt,
      lastSweepAt: doc.lastSweepAt,
      startedAt: doc.startedAt,
      completedAt: doc.completedAt,
      error: doc.error,
    };
  }
}
