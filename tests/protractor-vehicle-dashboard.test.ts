import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "mongodb";
import type { ProtractorVehicle } from "../lib/integrations/protractor/client";
import { saveVehicleSnapshot } from "../lib/integrations/protractor/vehicle-snapshot";

const vehicle = { ID: "vehicle-1", VIN: "1HGCM82633A004352", Year: 2003, Make: "Honda", Model: "Accord" } as ProtractorVehicle;
function fixture(fail?: string) {
  const calls: { name: string; filter: any; update: any }[] = [];
  const db = { collection: (name: string) => ({ updateOne: async (filter: any, update: any) => {
    calls.push({ name, filter, update });
    if (name === fail) throw new Error("write failed");
    return { acknowledged: true };
  } }) } as unknown as Db;
  return { db, calls };
}
test("vehicle details are durable before the shop-scoped dashboard marker", async () => {
  const { db, calls } = fixture();
  await saveVehicleSnapshot(db, 66, vehicle.VIN!.toLowerCase(), vehicle);
  assert.deepEqual(calls.map(c => c.name), ["protractor_vehicles", "dashboard_updates"]);
  assert.deepEqual(calls[0].filter, { shopId: 66, vin: vehicle.VIN });
  assert.equal(calls[0].update.$set.make, "Honda");
  assert.equal(calls[0].update.$set.model, "Accord");
  assert.match(JSON.stringify(calls[1].update), /shopVersions\.66/);
  assert.doesNotMatch(JSON.stringify(calls[1].update), /shopVersions\.67/);
});
test("failed snapshot does not publish a dashboard refresh", async () => {
  const { db, calls } = fixture("protractor_vehicles");
  await assert.rejects(saveVehicleSnapshot(db, 66, vehicle.VIN!, vehicle), /write failed/);
  assert.equal(calls.length, 1);
});
test("notification failure propagates for callback retry", async () => {
  const { db, calls } = fixture("dashboard_updates");
  await assert.rejects(saveVehicleSnapshot(db, 66, vehicle.VIN!, vehicle), /write failed/);
  assert.equal(calls.length, 2);
});
