import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/mongo", () => ({
  getDb: vi.fn().mockResolvedValue({
    collection: vi.fn().mockReturnValue({
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    }),
  }),
}));

describe("TekmetricAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("adapter structure", () => {
    it("should export tekmetricAdapter with required methods", async () => {
      const tekmetricModule = await import("@/lib/integrations/tekmetric");
      
      expect(tekmetricModule).toBeDefined();
      expect(typeof tekmetricModule.tekmetricAdapter).toBe("object");
      
      const adapter = tekmetricModule.tekmetricAdapter;
      expect(adapter.provider).toBe("tekmetric");
      expect(typeof adapter.isConfigured).toBe("function");
      expect(typeof adapter.getVehicle).toBe("function");
      expect(typeof adapter.getVehicleByVin).toBe("function");
      expect(typeof adapter.getWorkOrder).toBe("function");
      expect(typeof adapter.getWorkOrders).toBe("function");
    });

    it("should export legacy functions for backward compatibility", async () => {
      const tekmetricModule = await import("@/lib/integrations/tekmetric");
      
      expect(typeof tekmetricModule.getVehicle).toBe("function");
      expect(typeof tekmetricModule.getRepairOrders).toBe("function");
      expect(typeof tekmetricModule.getCustomer).toBe("function");
      expect(typeof tekmetricModule.getJobs).toBe("function");
    });
  });

  describe("isConfigured", () => {
    it("should return false when shop not found", async () => {
      const { getDb } = await import("@/lib/mongo");
      
      (getDb as ReturnType<typeof vi.fn>).mockResolvedValue({
        collection: vi.fn().mockReturnValue({
          findOne: vi.fn().mockResolvedValue(null),
        }),
      });
      
      const { tekmetricAdapter } = await import("@/lib/integrations/tekmetric");
      const result = await tekmetricAdapter.isConfigured(999);
      
      expect(result).toBe(false);
    });
  });
});
