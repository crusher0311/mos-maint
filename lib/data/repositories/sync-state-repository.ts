import { BaseRepository } from "./base-repository";
import { ObjectId } from "mongodb";

export interface SyncStateDocument {
  _id?: ObjectId;
  shopId: number;
  provider: "protractor" | "tekmetric" | "autoflow";
  status: "idle" | "running" | "completed" | "failed" | "stale";
  lastSyncAt?: Date;
  lastSuccessAt?: Date;
  cursor?: string;
  cursorTimestamp?: Date;
  overflowQueue?: string[];
  lastSweepAt?: Date;
  progress?: {
    totalPages?: number;
    processedPages?: number;
    totalRecords?: number;
    processedRecords?: number;
    percentage?: number;
  };
  metrics?: {
    duration?: number;
    recordsProcessed?: number;
    recordsFailed?: number;
    apiCalls?: number;
  };
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

class SyncStateRepositoryImpl extends BaseRepository<SyncStateDocument> {
  protected collectionName = "sync_states";
  
  async findByShopAndProvider(
    shopId: number, 
    provider: SyncStateDocument["provider"]
  ): Promise<SyncStateDocument | null> {
    return this.findOne({ shopId, provider });
  }
  
  async startSync(
    shopId: number, 
    provider: SyncStateDocument["provider"]
  ): Promise<boolean> {
    return this.upsertOne(
      { shopId, provider },
      { 
        $set: { 
          status: "running",
          startedAt: new Date(),
          error: undefined,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      }
    );
  }
  
  async updateProgress(
    shopId: number,
    provider: SyncStateDocument["provider"],
    progress: SyncStateDocument["progress"]
  ): Promise<boolean> {
    return this.updateOne(
      { shopId, provider },
      { $set: { progress, updatedAt: new Date() } }
    );
  }
  
  async updateCursor(
    shopId: number,
    provider: SyncStateDocument["provider"],
    cursor: string,
    cursorTimestamp?: Date
  ): Promise<boolean> {
    return this.updateOne(
      { shopId, provider },
      { 
        $set: { 
          cursor, 
          cursorTimestamp: cursorTimestamp || new Date(),
          updatedAt: new Date() 
        } 
      }
    );
  }
  
  async addToOverflowQueue(
    shopId: number,
    provider: SyncStateDocument["provider"],
    items: string[]
  ): Promise<boolean> {
    return this.updateOne(
      { shopId, provider },
      { 
        $push: { overflowQueue: { $each: items } },
        $set: { updatedAt: new Date() }
      }
    );
  }
  
  async popFromOverflowQueue(
    shopId: number,
    provider: SyncStateDocument["provider"],
    count: number
  ): Promise<string[]> {
    const state = await this.findByShopAndProvider(shopId, provider);
    if (!state?.overflowQueue?.length) return [];
    
    const items = state.overflowQueue.slice(0, count);
    const remaining = state.overflowQueue.slice(count);
    
    await this.updateOne(
      { shopId, provider },
      { $set: { overflowQueue: remaining, updatedAt: new Date() } }
    );
    
    return items;
  }
  
  async completeSync(
    shopId: number,
    provider: SyncStateDocument["provider"],
    metrics?: SyncStateDocument["metrics"]
  ): Promise<boolean> {
    return this.updateOne(
      { shopId, provider },
      { 
        $set: { 
          status: "completed",
          completedAt: new Date(),
          lastSuccessAt: new Date(),
          lastSyncAt: new Date(),
          metrics,
          error: undefined,
          updatedAt: new Date()
        } 
      }
    );
  }
  
  async failSync(
    shopId: number,
    provider: SyncStateDocument["provider"],
    error: string
  ): Promise<boolean> {
    return this.updateOne(
      { shopId, provider },
      { 
        $set: { 
          status: "failed",
          error,
          completedAt: new Date(),
          lastSyncAt: new Date(),
          updatedAt: new Date()
        } 
      }
    );
  }
  
  async markStale(
    shopId: number,
    provider: SyncStateDocument["provider"]
  ): Promise<boolean> {
    return this.updateOne(
      { shopId, provider },
      { $set: { status: "stale", updatedAt: new Date() } }
    );
  }
  
  async isStale(
    shopId: number,
    provider: SyncStateDocument["provider"],
    thresholdMs: number = 30 * 60 * 1000
  ): Promise<boolean> {
    const state = await this.findByShopAndProvider(shopId, provider);
    if (!state) return false;
    if (state.status !== "running") return false;
    if (!state.startedAt) return false;
    
    const elapsed = Date.now() - state.startedAt.getTime();
    return elapsed > thresholdMs;
  }
  
  async getRunningShops(provider: SyncStateDocument["provider"]): Promise<number[]> {
    const states = await this.findMany({ provider, status: "running" });
    return states.map(s => s.shopId);
  }
}

export const syncStateRepository = new SyncStateRepositoryImpl();
