import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/mongo", () => ({
  getDb: vi.fn().mockResolvedValue({
    collection: vi.fn().mockReturnValue({
      findOne: vi.fn(),
      find: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      }),
      insertOne: vi.fn().mockResolvedValue({ insertedId: "test-id" }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      countDocuments: vi.fn().mockResolvedValue(0),
    }),
  }),
}));

describe("ShopRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findByShopId", () => {
    it("should find a shop by shopId", async () => {
      const { shopRepository } = await import("@/lib/data/repositories");
      const { getDb } = await import("@/lib/mongo");
      
      const mockShop = {
        shopId: 1,
        name: "Test Shop",
        features: { maintenance: true },
      };
      
      const mockCollection = {
        findOne: vi.fn().mockResolvedValue(mockShop),
      };
      
      (getDb as ReturnType<typeof vi.fn>).mockResolvedValue({
        collection: vi.fn().mockReturnValue(mockCollection),
      });
      
      const result = await shopRepository.findByShopId(1);
      
      expect(mockCollection.findOne).toHaveBeenCalledWith({ 
        $or: [{ shopId: "1" }, { shopId: 1 }] 
      });
      expect(result).toEqual(mockShop);
    });

    it("should return null when shop not found", async () => {
      const { shopRepository } = await import("@/lib/data/repositories");
      const { getDb } = await import("@/lib/mongo");
      
      const mockCollection = {
        findOne: vi.fn().mockResolvedValue(null),
      };
      
      (getDb as ReturnType<typeof vi.fn>).mockResolvedValue({
        collection: vi.fn().mockReturnValue(mockCollection),
      });
      
      const result = await shopRepository.findByShopId(999);
      
      expect(result).toBeNull();
    });
  });

  describe("getFeatures", () => {
    it("should return features for a shop", async () => {
      const { shopRepository } = await import("@/lib/data/repositories");
      const { getDb } = await import("@/lib/mongo");
      
      const mockShop = {
        shopId: 1,
        features: {
          maintenance: true,
          jobLookup: true,
          commonFailures: false,
        },
      };
      
      const mockCollection = {
        findOne: vi.fn().mockResolvedValue(mockShop),
      };
      
      (getDb as ReturnType<typeof vi.fn>).mockResolvedValue({
        collection: vi.fn().mockReturnValue(mockCollection),
      });
      
      const features = await shopRepository.getFeatures(1);
      
      expect(features).toEqual({
        maintenance: true,
        jobLookup: true,
        commonFailures: false,
      });
    });

    it("should return null when shop has no features", async () => {
      const { shopRepository } = await import("@/lib/data/repositories");
      const { getDb } = await import("@/lib/mongo");
      
      const mockShop = {
        shopId: 1,
        name: "Test Shop",
      };
      
      const mockCollection = {
        findOne: vi.fn().mockResolvedValue(mockShop),
      };
      
      (getDb as ReturnType<typeof vi.fn>).mockResolvedValue({
        collection: vi.fn().mockReturnValue(mockCollection),
      });
      
      const features = await shopRepository.getFeatures(1);
      
      expect(features).toBeNull();
    });
  });

  describe("updateSyncState", () => {
    it("should update sync state for a shop", async () => {
      const { shopRepository } = await import("@/lib/data/repositories");
      const { getDb } = await import("@/lib/mongo");
      
      const mockCollection = {
        updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      };
      
      (getDb as ReturnType<typeof vi.fn>).mockResolvedValue({
        collection: vi.fn().mockReturnValue(mockCollection),
      });
      
      const syncState = {
        lastSyncAt: new Date(),
        syncCursor: "cursor-123",
      };
      
      const result = await shopRepository.updateSyncState(1, syncState);
      
      expect(result).toBe(true);
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { shopId: 1 },
        expect.objectContaining({
          $set: expect.objectContaining({
            syncState,
          }),
        }),
        undefined
      );
    });
  });
});
