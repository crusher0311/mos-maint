import { writePolledSnapshot } from "./snapshot-write";

export const ACTIVE_STATUS_IDS = [1, 2, 3, 4];

/** A bounded active-RO refresh, not a vehicle/history import. Absence is never closure evidence. */
export async function refreshActiveRepairOrders(db: any, shopId: number, providerShopId: number, api: {
  getRepairOrders: (shop: number, options: any) => Promise<any>;
  getVehicle: (id: number, shop: number) => Promise<any>;
  getCustomer: (id: number, shop: number) => Promise<any>;
}, options: { maxPages?: number; budgetMs?: number } = {}) {
  const startedAt = new Date();
  const deadline = Date.now() + (options.budgetMs ?? 45_000);
  const stats = { fetched: 0, imported: 0, incomplete: 0, failed: 0, superseded: 0, pages: 0,
    listingComplete: false, partial: true, errors: [] as string[] };
  const vehicles = new Map<number, Promise<any>>();
  const customers = new Map<number, Promise<any>>();
  const seen = new Set<string>();
  // Timeouts only stop waiting. Late provider results cannot write snapshots.
  const bounded = async (work: () => Promise<any>) => {
    if (Date.now() >= deadline) throw new Error("Sync time budget reached");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Sync time budget reached")), deadline - Date.now());
      })]);
    } finally { clearTimeout(timer); }
  };
  for (let page = 0; page < (options.maxPages ?? 11); page++) {
    let response: any;
    try {
      response = await bounded(() => api.getRepairOrders(providerShopId, {
        repairOrderStatusId: ACTIVE_STATUS_IDS, page, size: 100, sortDirection: "DESC",
      }));
      if (!Array.isArray(response.content)) throw new Error("Invalid RO listing");
      stats.pages++;
    } catch {
      stats.errors.push("Active RO listing unavailable or time budget reached");
      break;
    }
    for (const ro of response.content) {
      const id = String(ro.id);
      if (seen.has(id)) continue;
      seen.add(id);
      stats.fetched++;
      if (!Number.isSafeInteger(Number(ro.id)) || Number(ro.id) <= 0 || Number(ro.shopId) !== providerShopId) {
        stats.failed++; continue;
      }
      if (Date.now() >= deadline) { stats.failed++; continue; }
      let vehicle: any = ro.vehicle;
      let customer: any = ro.customer;
      let enrichmentFailed = false;
      if (!vehicle && ro.vehicleId) {
        if (!vehicles.has(ro.vehicleId)) vehicles.set(ro.vehicleId, bounded(() => api.getVehicle(ro.vehicleId, providerShopId)));
        try { vehicle = await vehicles.get(ro.vehicleId); } catch { enrichmentFailed = true; }
      }
      if (!customer && ro.customerId && Date.now() < deadline) {
        if (!customers.has(ro.customerId)) customers.set(ro.customerId, bounded(() => api.getCustomer(ro.customerId, providerShopId)));
        try { customer = await customers.get(ro.customerId); } catch { enrichmentFailed = true; }
      }
      if ((vehicle?.shopId != null && Number(vehicle.shopId) !== providerShopId) ||
          (customer?.shopId != null && Number(customer.shopId) !== providerShopId)) {
        stats.failed++; continue;
      }
      const vin = typeof vehicle?.vin === "string" ? vehicle.vin.trim().toUpperCase() : undefined;
      const mileage = [ro.milesIn, ro.milesOut, vehicle?.mileageIn, vehicle?.mileageOut]
        .find(value => typeof value === "number" && value > 0);
      const incomplete = !vin || !mileage || enrichmentFailed;
      try {
        const wrote = await writePolledSnapshot(db, shopId, id, startedAt, {
          tekmetricShopId: providerShopId, workOrderNumber: ro.repairOrderNumber,
          status: ro.repairOrderStatus?.name || ro.repairOrderStatus?.code || "Unknown",
          statusCode: ro.repairOrderStatus?.code, label: ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || null,
          labelColor: ro.color || null, vehicleId: ro.vehicleId, customerId: ro.customerId,
          vin, odometer: mileage, vehicleYear: vehicle?.year, vehicleMake: vehicle?.make,
          vehicleModel: vehicle?.model, vehicleEngine: vehicle?.engine,
          customerName: customer ? `${customer.firstName || ""} ${customer.lastName || ""}`.trim() : undefined,
          data: ro, updatedDate: ro.updatedDate, createdDate: ro.createdDate,
          fetchedAt: new Date(), contextRecoveryNeeded: incomplete &&
            !["invoice", "invoiced", "posted", "closed", "deleted", "void"].includes(String(ro.repairOrderStatus?.name || "").toLowerCase()),
        }, { createdAt: new Date() });
        if (wrote) stats.imported++; else stats.superseded++;
        if (incomplete) stats.incomplete++;
        if (enrichmentFailed) stats.failed++;
      } catch { stats.failed++; }
    }
    if (response.last === true) { stats.listingComplete = true; break; }
    if (Date.now() >= deadline) break;
  }
  stats.partial = !stats.listingComplete || stats.failed > 0 || stats.incomplete > 0 || stats.superseded > 0;
  return stats;
}
