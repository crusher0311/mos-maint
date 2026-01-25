import { describe, it, expect, vi, beforeEach } from "vitest";

describe("ProtractorAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("module exports", () => {
    it("should export protractorAdapter", async () => {
      vi.doMock("@/lib/mongo", () => ({
        getDb: vi.fn().mockResolvedValue({
          collection: vi.fn().mockReturnValue({
            findOne: vi.fn().mockResolvedValue(null),
            updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
          }),
        }),
      }));
      
      const { protractorAdapter } = await import("@/lib/integrations/protractor/adapter");
      
      expect(protractorAdapter).toBeDefined();
      expect(protractorAdapter.provider).toBe("protractor");
    });

    it("should implement IIntegrationAdapter interface", async () => {
      vi.doMock("@/lib/mongo", () => ({
        getDb: vi.fn().mockResolvedValue({
          collection: vi.fn().mockReturnValue({
            findOne: vi.fn().mockResolvedValue(null),
          }),
        }),
      }));
      
      const { protractorAdapter } = await import("@/lib/integrations/protractor/adapter");
      
      expect(typeof protractorAdapter.isConfigured).toBe("function");
      expect(typeof protractorAdapter.getConfig).toBe("function");
      expect(typeof protractorAdapter.testConnection).toBe("function");
      expect(typeof protractorAdapter.getVehicle).toBe("function");
      expect(typeof protractorAdapter.getVehicleByVin).toBe("function");
      expect(typeof protractorAdapter.getWorkOrder).toBe("function");
      expect(typeof protractorAdapter.getWorkOrders).toBe("function");
      expect(typeof protractorAdapter.getCannedJobs).toBe("function");
    });
  });
});
