import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";

let mongoWorkOrder: any = null;
let mongoVehicle: any = null;
const mongoUpdates: Array<{ collection: string; filter: any; update: any; options: any }> = [];
const pgWorkOrderUpdates: any[] = [];
const pgVehicleUpdates: any[] = [];
let pgWorkOrder: any = null;
let pgVehicle: any = null;

const dbStub = {
  __esModule: true,
  getDb: async () => ({
    collection(name: string) {
      return {
        findOne: async () => name === "protractor_work_orders"
          ? mongoWorkOrder
          : name === "vehicles"
            ? mongoVehicle
            : null,
        updateOne: async (filter: any, update: any, options?: any) => {
          mongoUpdates.push({ collection: name, filter, update, options });
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    },
  }),
};

const protractorPgStub = {
  __esModule: true,
  findCachedWorkOrderByProviderIdentity: async () => pgWorkOrder,
  markCachedWorkOrderTerminal: async (...args: any[]) => {
    pgWorkOrderUpdates.push(args);
  },
};
const vehiclePgStub = {
  __esModule: true,
  findVehicleByProtractorWorkOrder: async () => pgVehicle,
  upsertVehicleSnapshot: async (...args: any[]) => {
    pgVehicleUpdates.push(args);
  },
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request.includes("pg/protractor-cache")) return protractorPgStub;
  if (request.includes("pg/pre-normalized")) return vehiclePgStub;
  if (request === "@/lib/data/db" || request.endsWith("/lib/data/db")) return dbStub;
  if (request.includes("integration-cache-write-mode")) {
    return {
      __esModule: true,
      isProtractorCachePgCanonical: () => true,
      shouldShadowWriteMongoProtractorCache: () => false,
      shadowWriteMongoIntegrationCache: async () => undefined,
    };
  }
  if (request.includes("legacy-store-write-mode")) {
    return {
      __esModule: true,
      isLegacyVehiclesPgCanonical: () => true,
      shouldShadowWriteMongoLegacyVehicles: () => true,
      shadowWriteMongoLegacyStore: async () => {
        throw new Error("terminal update must not use shadow upsert");
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const require = createRequire(import.meta.url);
  const workOrders = require("../lib/data/repositories/protractor-work-orders");
  const vehicles = require("../lib/data/repositories/vehicles");

  mongoWorkOrder = {
    _id: "mongo-wo-id",
    shopId: "42",
    workOrderId: "wo-1",
    status: "Open",
  };
  pgWorkOrder = null;
  const splitMatch = await workOrders.findCachedWorkOrderByProviderIdentity(42, "wo-1");
  assert(splitMatch, "Mongo writer evidence prevents a PG miss from proving absence");
  await workOrders.markCachedWorkOrderTerminal(42, splitMatch!, "Deleted", new Date(1));
  assert.equal(pgWorkOrderUpdates.length, 0);
  assert.equal(mongoUpdates.length, 1);
  assert.deepEqual(mongoUpdates[0].filter, {
    _id: "mongo-wo-id",
    shopId: { $in: [42, "42"] },
  });
  assert.equal(mongoUpdates[0].options, undefined, "terminal mutation never upserts");

  mongoUpdates.length = 0;
  pgWorkOrder = { shopId: 42, workOrderId: "wo-1", status: "Open" };
  const dualMatch = await workOrders.findCachedWorkOrderByProviderIdentity(42, "wo-1");
  await workOrders.markCachedWorkOrderTerminal(42, dualMatch!, "Deleted", new Date(2));
  assert.equal(pgWorkOrderUpdates.length, 1);
  assert.equal(mongoUpdates.length, 1, "existing Mongo mirror is updated by matched id");

  mongoUpdates.length = 0;
  pgVehicle = {
    shopId: 42,
    vin: "1HGCM82633A004352",
    status: { sources: [{ provider: "protractor", workOrderId: "wo-1" }] },
  };
  mongoVehicle = {
    _id: "mongo-vehicle-id",
    shopId: "42",
    vin: "1HGCM82633A004352",
    status: { sources: [{ provider: "protractor", workOrderId: "wo-1" }] },
  };
  const vehicleMatch = await vehicles.findVehicleByProtractorWorkOrder(42, "wo-1");
  await vehicles.removeProtractorWorkOrderSource(vehicleMatch!, 42, "wo-1", new Date(3));
  assert.equal(pgVehicleUpdates.length, 1);
  assert.equal(mongoUpdates.length, 1);
  assert.deepEqual(mongoUpdates[0].filter, {
    _id: "mongo-vehicle-id",
    shopId: { $in: ["42", 42] },
  });
  assert.equal(mongoUpdates[0].options, undefined, "string-shop Mongo mirror is not duplicated");

  console.log("Protractor terminal store routing checks passed");
}

main()
  .finally(() => {
    (Module as any)._load = originalLoad;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });