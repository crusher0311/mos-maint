import { vi } from "vitest";

export interface MockFetchOptions {
  status?: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
}

export function createMockFetch(responses: Map<string, MockFetchOptions> | MockFetchOptions) {
  return vi.fn().mockImplementation((url: string) => {
    const options = responses instanceof Map
      ? responses.get(url) || { status: 404, ok: false, json: { error: "Not found" } }
      : responses;
    
    return Promise.resolve({
      ok: options.ok ?? true,
      status: options.status ?? 200,
      json: () => Promise.resolve(options.json ?? {}),
      text: () => Promise.resolve(options.text ?? JSON.stringify(options.json ?? {})),
    });
  });
}

export function createMockRepository<T>() {
  return {
    findOne: vi.fn<[unknown], Promise<T | null>>().mockResolvedValue(null),
    findMany: vi.fn<[unknown, unknown?], Promise<T[]>>().mockResolvedValue([]),
    insertOne: vi.fn<[unknown], Promise<string>>().mockResolvedValue("mock-id"),
    updateOne: vi.fn<[unknown, unknown, unknown?], Promise<boolean>>().mockResolvedValue(true),
    upsertOne: vi.fn<[unknown, unknown], Promise<boolean>>().mockResolvedValue(true),
    deleteOne: vi.fn<[unknown], Promise<boolean>>().mockResolvedValue(true),
    count: vi.fn<[unknown], Promise<number>>().mockResolvedValue(0),
    exists: vi.fn<[unknown], Promise<boolean>>().mockResolvedValue(false),
  };
}

export const sampleShopConfig = {
  shopId: 1,
  name: "Test Shop",
  integrations: {
    protractor: {
      apiKey: "test-api-key",
      apiUrl: "https://api.test.com",
      shopIdentifier: "test-shop",
    },
    tekmetric: {
      shopId: 12345,
      accessToken: "test-token",
      refreshToken: "test-refresh",
      tokenExpiresAt: new Date(Date.now() + 3600000),
    },
  },
  features: {
    maintenance: true,
    jobLookup: true,
    commonFailures: true,
  },
};

export const sampleVehicle = {
  id: "vehicle-1",
  vin: "1HGCM82633A123456",
  year: 2020,
  make: "Honda",
  model: "Accord",
  engine: "2.0L",
  mileage: 45000,
};

export const sampleWorkOrder = {
  id: "wo-1",
  vehicleId: "vehicle-1",
  customerId: "customer-1",
  status: "completed",
  jobs: [
    { name: "Oil Change", laborAmount: 50, partsAmount: 25 },
    { name: "Tire Rotation", laborAmount: 30, partsAmount: 0 },
  ],
  totalAmount: 105,
  completedAt: new Date("2024-01-15"),
};

export const sampleJobIndex = {
  shopId: 1,
  jobName: "Oil Change",
  jobNameLower: "oil change",
  vehicleInfo: {
    year: 2020,
    make: "Honda",
    model: "Accord",
  },
  repairOrderId: "wo-1",
  completedAt: new Date("2024-01-15"),
  totalAmount: 75,
  source: "protractor" as const,
};
