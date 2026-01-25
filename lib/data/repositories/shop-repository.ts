import { BaseRepository } from "./base-repository";
import { ObjectId } from "mongodb";

export interface ShopDocument {
  _id?: ObjectId;
  shopId: number;
  name: string;
  ownerId?: string;
  features?: {
    maintenance?: boolean;
    jobLookup?: boolean;
    commonFailures?: boolean;
    oilSticker?: boolean;
    keytags?: boolean;
    autoBooking?: boolean;
    partCrossReference?: boolean;
  };
  integrations?: {
    protractor?: {
      apiKey?: string;
      apiUrl?: string;
      shopIdentifier?: string;
      connectionId?: string;
      backfillState?: {
        status: string;
        startedAt?: Date;
        completedAt?: Date;
        progress?: number;
        error?: string;
      };
    };
    tekmetric?: {
      shopId?: number;
      accessToken?: string;
      refreshToken?: string;
      tokenExpiresAt?: Date;
    };
    autoflow?: {
      webhookToken?: string;
      lastWebhookAt?: Date;
    };
  };
  syncState?: {
    lastSyncAt?: Date;
    syncCursor?: string;
    overflowQueue?: string[];
    lastSweepAt?: Date;
  };
  settings?: {
    distanceUnit?: "miles" | "kilometers";
    serviceIntervalMiles?: number;
    serviceIntervalMonths?: number;
    businessHours?: Record<string, { open: string; close: string }>;
    holidays?: string[];
  };
  createdAt?: Date;
  updatedAt?: Date;
}

class ShopRepositoryImpl extends BaseRepository<ShopDocument> {
  protected collectionName = "shops";
  
  async findByShopId(shopId: number): Promise<ShopDocument | null> {
    return this.findOne({ shopId });
  }
  
  async findByOwnerId(ownerId: string): Promise<ShopDocument[]> {
    return this.findMany({ ownerId });
  }
  
  async getProtractorConfig(shopId: number): Promise<ShopDocument["integrations"] | null> {
    const shop = await this.findByShopId(shopId);
    return shop?.integrations || null;
  }
  
  async getTekmetricShopId(shopId: number): Promise<number | null> {
    const shop = await this.findByShopId(shopId);
    return shop?.integrations?.tekmetric?.shopId || null;
  }
  
  async updateSyncState(
    shopId: number,
    syncState: Partial<ShopDocument["syncState"]>
  ): Promise<boolean> {
    return this.updateOne(
      { shopId },
      { $set: { syncState, updatedAt: new Date() } }
    );
  }
  
  async updateBackfillState(
    shopId: number,
    backfillState: ShopDocument["integrations"] extends { protractor?: { backfillState?: infer T } } ? T : never
  ): Promise<boolean> {
    return this.updateOne(
      { shopId },
      { 
        $set: { 
          "integrations.protractor.backfillState": backfillState,
          updatedAt: new Date()
        } 
      }
    );
  }
  
  async getFeatures(shopId: number): Promise<ShopDocument["features"] | null> {
    const shop = await this.findByShopId(shopId);
    return shop?.features || null;
  }
}

export const shopRepository = new ShopRepositoryImpl();
