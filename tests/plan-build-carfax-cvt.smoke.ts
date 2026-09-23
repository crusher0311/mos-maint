/**
 * Offline reproduction of the reported 46,615-mile CARFAX service.
 * Dates, current mileage and intervals below are synthetic, not incident facts.
 * Run: npx tsx tests/plan-build-carfax-cvt.smoke.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { toAnchorKeysFromHistory, toKeyFromName } from "../lib/service-keys";
import { triage, convertToCache, type OEMItem } from "../lib/plan-build/triage";

async function main() {
  const req = createRequire(import.meta.url);
  const path = req.resolve("server-only");
  req.cache[path] = { id: path, filename: path, loaded: true, exports: {} } as any;
  const { parseCarfaxPayload } = await import("../lib/integrations/carfax");
  const date = "03/01/2025";
  const serviceDate = new Date(2025, 2, 1);
  const oem: OEMItem = {
    maintenance_id: "fixture-cvt", name: "Replace CVT fluid",
    miles: 30000, months: 24,
  };
  assert.equal(toKeyFromName(oem.name!), "trans_auto");
  assert.deepEqual(toAnchorKeysFromHistory("Transmission fluid changed"), ["trans_auto"]);

  function build(phrases: string[], category = false, currentMiles = 60000,
    today = new Date(2026, 0, 1), shop = false) {
    const report = parseCarfaxPayload({
      serviceHistory: {
        displayRecords: category ? [] : [{
          type: "service", displayDate: date, odometer: "46,615", text: phrases,
        }],
        serviceCategories: category ? [{
          serviceName: phrases.join("; "), dateOfLastService: date,
          odometerOfLastService: "46,615",
        }] : [],
      },
    }, "OFFLINE-FIXTURE");
    assert.equal(report.ok, true);
    const buckets = triage({
      oemItems: [oem],
      carfaxRecords: (report.serviceRecords || []).map(r => ({
        date: r.date ?? undefined, odometer: r.odometer ?? undefined,
        description: r.description ?? undefined,
      })),
      carfaxCategories: report.serviceCategories || [],
      shopServiceHistory: shop ? [{
        serviceName: "CVT fluid service", mileage: 46615, date: serviceDate,
      }] : [],
      currentMiles, today, dviFindings: [], vehicleYear: 2020,
      vehicleTransType: "CVT",
    });
    const row = Object.values(buckets).flat().find(r => r.serviceKey === "trans_auto");
    assert.ok(row, "CVT recommendation must resolve to transmission-fluid key");
    return { row, buckets };
  }

  for (const category of [false, true]) {
    for (const phrases of [
      ["Transmission fluid changed"],
      ["Vehicle serviced", "Transmission fluid changed", "Transmission checked"],
      ["Transmission fluid changed", "Differential fluid checked"],
    ]) {
      const { row, buckets } = build(phrases, category);
      assert.equal(row.last?.miles, 46615);
      assert.equal(row.last?.date?.getTime(), serviceDate.getTime());
      assert.equal(row.last?.source, "carfax");
      assert.equal(row.dueAtMiles, 76615);
      assert.equal(row.dueAtDate?.getTime(), new Date(2027, 2, 1).getTime());
      assert.ok(buckets.upcoming.includes(row));
      const cached = convertToCache(row);
      assert.equal(cached.last?.miles, 46615);
      assert.equal(cached.last?.date, serviceDate.toISOString());
    }
    for (const phrase of [
      "Transmission fluid checked", "CVT fluid inspected", "Transmission checked",
      "Transfer case fluid changed", "Rear differential fluid changed",
      "Transmission mount replaced",
    ]) {
      assert.equal(build([phrase], category).row.last, undefined, phrase);
    }
    assert.equal(build(["Oil and filter changed", "Transmission fluid checked"], category).row.last, undefined);
    const mileageDue = build(["Transmission fluid changed"], category, 80000);
    assert.ok(mileageDue.buckets.overdue.includes(mileageDue.row));
    assert.equal(mileageDue.row.dueAtMiles, 76615);
    const timeDue = build(["Transmission fluid changed"], category, 60000, new Date(2027, 3, 1));
    assert.ok(timeDue.buckets.overdue.includes(timeDue.row));
    assert.equal(timeDue.row.last?.miles, 46615);
    assert.equal(build(["Transmission fluid changed"], category, 60000, undefined, true).row.last?.source, "shop");
  }
  console.log("CARFAX CVT offline normalization, anchor, interval and cache-shape checks passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });