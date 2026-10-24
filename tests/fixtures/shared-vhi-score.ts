import type { VHIData, PlanItem } from "../../components/vehicle-health-report/VehicleHealthReport";

const item: PlanItem = {
  key: "oil_change", serviceKey: "oil_change", title: "Engine Oil Change", category: "engine",
  intervalMiles: 5000, intervalMonths: 6, last: null, dueAtMiles: null, dueAtDate: null,
  milesToGo: -1000, daysToGo: null, bump: "red", source: "oem", reason: null,
  usingShopInterval: false, declined: false, matchedDeferred: null, protractorDeferredId: null,
};
export const base: VHIData = {
  vin: "TEST", vehicle: { year: 2020, make: "Honda", model: "Accord", engine: null },
  currentMiles: 60000, customerName: "Fixture Customer",
  buckets: { overdue: [item], dueSoon: [], upcoming: [] },
};
