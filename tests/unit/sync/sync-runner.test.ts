import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SyncProvider, PageResult } from "@/lib/integrations/core/sync/types";

vi.mock("@/lib/data/repositories", () => ({
  syncStateRepository: {
    findByShopAndProvider: vi.fn(),
    isStale: vi.fn().mockResolvedValue(false),
    markStale: vi.fn().mockResolvedValue(true),
    startSync: vi.fn().mockResolvedValue(true),
    updateProgress: vi.fn().mockResolvedValue(true),
    updateCursor: vi.fn().mockResolvedValue(true),
    addToOverflowQueue: vi.fn().mockResolvedValue(true),
    completeSync: vi.fn().mockResolvedValue(true),
    failSync: vi.fn().mockResolvedValue(true),
    updateOne: vi.fn().mockResolvedValue(true),
  },
}));

interface TestRecord {
  id: string;
  name: string;
}

interface TestTransformed {
  id: string;
  processedName: string;
}

function createMockProvider(): SyncProvider<TestRecord, TestTransformed> {
  return {
    provider: "test-provider",
    fetchPage: vi.fn<[number, string?, number?], Promise<PageResult<TestRecord>>>().mockResolvedValue({
      items: [
        { id: "1", name: "Record 1" },
        { id: "2", name: "Record 2" },
      ],
      hasMore: false,
    }),
    transform: vi.fn<[TestRecord, number], Promise<TestTransformed | null>>().mockImplementation(
      async (record) => ({
        id: record.id,
        processedName: record.name.toUpperCase(),
      })
    ),
    persist: vi.fn<[TestTransformed[], number], Promise<number>>().mockResolvedValue(2),
    getShopConfig: vi.fn<[number], Promise<{ configured: boolean }>>().mockResolvedValue({ configured: true }),
  };
}

describe("SyncRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("run", () => {
    it("should run a sync cycle successfully", async () => {
      const { SyncRunner } = await import("@/lib/integrations/core/sync/runner");
      const { syncStateRepository } = await import("@/lib/data/repositories");
      
      (syncStateRepository.findByShopAndProvider as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      
      const provider = createMockProvider();
      const runner = new SyncRunner(provider);
      
      const result = await runner.run(1);
      
      expect(result.success).toBe(true);
      expect(result.progress.pagesProcessed).toBe(1);
      expect(result.progress.recordsProcessed).toBe(2);
      expect(result.progress.recordsIndexed).toBe(2);
      expect(result.hasMore).toBe(false);
      
      expect(provider.fetchPage).toHaveBeenCalledWith(1, undefined, 100);
      expect(provider.transform).toHaveBeenCalledTimes(2);
      expect(provider.persist).toHaveBeenCalledWith(
        [
          { id: "1", processedName: "RECORD 1" },
          { id: "2", processedName: "RECORD 2" },
        ],
        1
      );
      expect(syncStateRepository.completeSync).toHaveBeenCalled();
    });

    it("should fail if provider is not configured", async () => {
      const { SyncRunner } = await import("@/lib/integrations/core/sync/runner");
      
      const provider = createMockProvider();
      (provider.getShopConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ configured: false });
      
      const runner = new SyncRunner(provider);
      const result = await runner.run(1);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("not configured");
    });

    it("should skip if sync already in progress", async () => {
      const { SyncRunner } = await import("@/lib/integrations/core/sync/runner");
      const { syncStateRepository } = await import("@/lib/data/repositories");
      
      (syncStateRepository.findByShopAndProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "running",
        startedAt: new Date(),
      });
      
      const provider = createMockProvider();
      const runner = new SyncRunner(provider);
      const result = await runner.run(1);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("already in progress");
    });

    it("should handle multiple pages with pagination", async () => {
      const { SyncRunner } = await import("@/lib/integrations/core/sync/runner");
      const { syncStateRepository } = await import("@/lib/data/repositories");
      
      (syncStateRepository.findByShopAndProvider as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      
      const provider = createMockProvider();
      let callCount = 0;
      (provider.fetchPage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return {
            items: [{ id: `page${callCount}`, name: `Page ${callCount}` }],
            hasMore: true,
            nextCursor: `cursor-${callCount}`,
          };
        }
        return {
          items: [{ id: "page3", name: "Page 3" }],
          hasMore: false,
        };
      });
      
      const runner = new SyncRunner(provider, { maxPagesPerCycle: 5 });
      const result = await runner.run(1);
      
      expect(result.success).toBe(true);
      expect(result.progress.pagesProcessed).toBe(3);
      expect(result.progress.recordsProcessed).toBe(3);
    });

    it("should handle transform errors gracefully", async () => {
      const { SyncRunner } = await import("@/lib/integrations/core/sync/runner");
      const { syncStateRepository } = await import("@/lib/data/repositories");
      
      (syncStateRepository.findByShopAndProvider as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      
      const provider = createMockProvider();
      let transformCount = 0;
      (provider.transform as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        transformCount++;
        if (transformCount === 1) {
          throw new Error("Transform failed");
        }
        return { id: "2", processedName: "RECORD 2" };
      });
      
      const runner = new SyncRunner(provider);
      const result = await runner.run(1);
      
      expect(result.success).toBe(true);
      expect(result.progress.recordsFailed).toBe(1);
      expect(result.progress.recordsProcessed).toBe(1);
    });

    it("should resume from existing cursor", async () => {
      const { SyncRunner } = await import("@/lib/integrations/core/sync/runner");
      const { syncStateRepository } = await import("@/lib/data/repositories");
      
      (syncStateRepository.findByShopAndProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "completed",
        cursor: "existing-cursor",
      });
      
      const provider = createMockProvider();
      const runner = new SyncRunner(provider);
      await runner.run(1);
      
      expect(provider.fetchPage).toHaveBeenCalledWith(1, "existing-cursor", 100);
    });

    it("should handle fetch errors", async () => {
      const { SyncRunner } = await import("@/lib/integrations/core/sync/runner");
      const { syncStateRepository } = await import("@/lib/data/repositories");
      
      (syncStateRepository.findByShopAndProvider as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      
      const provider = createMockProvider();
      (provider.fetchPage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error"));
      
      const runner = new SyncRunner(provider);
      const result = await runner.run(1);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe("API error");
      expect(syncStateRepository.failSync).toHaveBeenCalled();
    });
  });

  describe("getState", () => {
    it("should return sync state for a shop", async () => {
      const { SyncRunner } = await import("@/lib/integrations/core/sync/runner");
      const { syncStateRepository } = await import("@/lib/data/repositories");
      
      const mockState = {
        shopId: 1,
        provider: "test-provider",
        status: "completed" as const,
        cursor: "cursor-123",
        overflowQueue: [],
        lastSyncAt: new Date(),
      };
      
      (syncStateRepository.findByShopAndProvider as ReturnType<typeof vi.fn>).mockResolvedValue(mockState);
      
      const provider = createMockProvider();
      const runner = new SyncRunner(provider);
      const state = await runner.getState(1);
      
      expect(state).toEqual(expect.objectContaining({
        shopId: 1,
        provider: "test-provider",
        status: "completed",
        cursor: "cursor-123",
      }));
    });

    it("should return null when no state exists", async () => {
      const { SyncRunner } = await import("@/lib/integrations/core/sync/runner");
      const { syncStateRepository } = await import("@/lib/data/repositories");
      
      (syncStateRepository.findByShopAndProvider as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      
      const provider = createMockProvider();
      const runner = new SyncRunner(provider);
      const state = await runner.getState(999);
      
      expect(state).toBeNull();
    });
  });
});
