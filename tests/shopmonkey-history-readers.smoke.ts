import assert from "node:assert/strict";
import { findShopmonkeyRo, shopmonkeyRoMileage } from "../lib/plan-build/shopmonkey-ro";
import { resolveOpenRoMileage, pickMileageInput } from "../lib/plan-build/open-ro-mileage";
import { detectMileageDiscrepancy, shopHistoryLabelFromProvider } from "../lib/plan-build/mileage-discrepancy";
import { resolveCustomerName } from "../lib/plan-build/customer-name";
import { triage } from "../lib/plan-build/triage";
import { buildRecord, matchLastPerformed } from "../lib/last-performed-match";
import { searchMongoJobIndex } from "../lib/mongo-job-search";

async function main() {
  const vin = "1HGCM82633A004352"; // Synthetic fixture, not customer evidence.
  const now = new Date("2026-10-20T00:00:00Z");
  const ro = {
    workOrderNumber: 12, odometerOut: 0, odometerIn: 52000, updatedAt: now,
    status: "completed", closedDate: new Date("2026-05-01"),
    vehicle: { vin }, customer: { fullName: "Fixture Customer" },
  };
  let fixtureRows = [
    { ...ro, workOrderNumber: 11, odometerIn: 40000, closedDate: new Date("2025-01-01"), updatedAt: new Date("2026-10-23") },
    ro,
  ];
  const roDb = { collection(name: string) {
    assert.equal(name, "normalized_work_orders");
    return { find(query: any, options: any) {
      assert.deepEqual(query.shopId.$in, [195, "195"]);
      assert.equal(query["provenance.sourceIds.system"], "shopmonkey");
      assert.equal(query["softDelete.isDeleted"].$ne, true);
      assert.equal(options.maxTimeMS, 2000);
      assert.deepEqual(options.hint, { shopId: 1, closedDate: -1 });
      if (query.$or) {
        assert.deepEqual(query.$or.at(-1)["provenance.sourceIds"].$elemMatch,
          { system: "shopmonkey", idType: "repair_order_id", idValue: "order-fixture" });
      } else assert.equal(query["vehicle.vin"], vin);
      return { limit(cap: number) {
        assert.equal(cap, 501);
        return { async toArray() { return [...fixtureRows]; } };
      } };
    } };
  } };
  assert.equal(await findShopmonkeyRo(roDb, [195, "195"], {}), null);
  await findShopmonkeyRo(roDb, [195, "195"], { roId: "order-fixture" });
  const reading = await resolveOpenRoMileage({ db: roDb, shopIdVariants: [195, "195"], vin: vin.toLowerCase(), provider: "shopmonkey" });
  assert.equal(reading?.miles, 52000);
  assert.equal(reading?.integration, "shopmonkey");
  assert.equal(reading?.roDate?.toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(pickMileageInput({ vehicleDocMileage: null, openRoLookup: reading, now }).mileageInputSource, "open_ro");
  assert.equal(pickMileageInput({ vehicleDocMileage: null, openRoLookup: reading, now }).staleActual, true,
    "recently imported historical mileage must remain stale");
  const emptyEstimate = { ...ro, status: "estimate", checkInDate: now, closedDate: null, odometerIn: null, odometerOut: null } as any;
  fixtureRows = [...fixtureRows, emptyEstimate];
  const historical = await resolveOpenRoMileage({ db: roDb, shopIdVariants: [195, "195"], vin, provider: "shopmonkey" });
  assert.equal(historical?.miles, 52000, "mileage-less estimate must not hide invoice mileage");
  assert.equal(historical?.roDate?.toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(pickMileageInput({ vehicleDocMileage: null, openRoLookup: historical, now }).staleActual, true);
  assert.equal(await findShopmonkeyRo(roDb, [195, "195"], { vin }), emptyEstimate,
    "customer context should still use the active estimate");
  fixtureRows = [emptyEstimate];
  const explicit = await findShopmonkeyRo(roDb, [195, "195"], { vin, roId: "order-fixture", requireMileage: true });
  assert.equal(explicit, emptyEstimate, "explicit RO lookup must not substitute another visit");
  assert.equal(shopmonkeyRoMileage(explicit), null);
  fixtureRows = [ro];
  fixtureRows = [...fixtureRows, { ...ro, status: "work_in_progress", checkInDate: now, closedDate: null, odometerIn: 53000 } as any];
  const active = await resolveOpenRoMileage({ db: roDb, shopIdVariants: [195, "195"], vin, provider: "shopmonkey" });
  assert.equal(active?.miles, 53000);
  assert.equal(pickMileageInput({ vehicleDocMileage: null, openRoLookup: active, now }).staleActual, false);
  assert.equal(shopmonkeyRoMileage({ odometerOut: "bad", odometerIn: -1 }), null);
  assert.equal(resolveCustomerName({ shopmonkeyWorkOrder: ro }), "Fixture Customer");
  assert.equal(resolveCustomerName({ shopmonkeyWorkOrder: { customer: { fullName: " ", companyName: "Fleet" } } }), "Fleet");
  assert.equal(resolveCustomerName({ shopmonkeyWorkOrder: { customer: { fullName: "Unknown Customer" } } }), null);
  assert.equal(detectMileageDiscrepancy({
    currentMiles: 48000, shopHistory: [{ mileage: 50000, date: now }],
    shopHistoryLabel: shopHistoryLabelFromProvider("shopmonkey"),
  })?.priorSource, "Shopmonkey");

  // The provider-neutral history intake used by plan-build and last-performed
  // must preserve Shopmonkey service date/mileage over older CARFAX history.
  const history = { serviceName: "Replace engine oil and filter", mileage: 50000, date: new Date("2026-10-01") };
  const buckets = triage({
    oemItems: [{ maintenance_id: 1, name: history.serviceName, miles: 10000, months: 12, intervals: [{ units: "Miles", value: 10000 }], notes: null }],
    shopServiceHistory: [history], carfaxRecords: [{ date: "2025-01-01", odometer: 30000, description: "Oil and filter changed" }],
    currentMiles: 52000, today: now, dviFindings: [],
  });
  const oil = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming].find(x => x.last?.miles === 50000);
  assert.ok(oil);
  assert.equal(oil.last?.source, "shop");
  assert.equal(oil.dueAtMiles, 60000);
  const matched = matchLastPerformed({
    records: [buildRecord("shop", history.serviceName, history.date, history.mileage)],
    currentMiles: 52000, milesPerDay: null,
  }, history.serviceName);
  assert.ok(matched);

  const queries: any[] = [];
  const searchDb = { collection(name: string) {
    assert.equal(name, "job_index");
    return { aggregate(pipeline: any[], options: any) {
      const match = pipeline[0].$match;
      queries.push(match);
      const shopId = match.shopId.$in[0];
      const flat = match.sourceSystem === "shopmonkey";
      if (flat) {
        assert.equal(options.maxTimeMS, 2000);
        assert.deepEqual(options.hint, { shopId: 1, title: 1 });
        assert.equal(match["job.keywords"].$exists, false);
        assert.ok(new RegExp(match.$and[0].title.$regex, "i").test("Oil change"));
      }
      return { async toArray() {
        if (shopId === 195 && flat) return [{ _id: "sm", shopId, sourceSystem: "shopmonkey", title: "Oil change", performedAt: now }];
        if (shopId === 196 && !flat) return Array.from({ length: 8 }, (_, i) => ({ _id: `tek-${i}`, shopId, job: { title: "Oil change" }, performedAt: now }));
        return [];
      } };
    } };
  } };
  const jobs = await searchMongoJobIndex(searchDb as any, [196, 195], ["oil"], undefined, 2);
  assert.deepEqual(jobs.map(j => j.shopId), [196, 195], "busy shop must not starve Shopmonkey");
  assert.equal(jobs[1].sourceSystem, "shopmonkey");
  assert.equal((await searchMongoJobIndex(searchDb as any, [195], ["oil"]))[0]._id, "sm");
  assert.equal((await searchMongoJobIndex(searchDb as any, [], ["oil"])).length, 0);
  assert.ok(queries.every(q => q.shopId.$in.length === 2));
  console.log("Shopmonkey history reader checks passed");
}
main().catch(err => { console.error(err); process.exitCode = 1; });
