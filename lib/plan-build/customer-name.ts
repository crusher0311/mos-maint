/**
 * Pure customer-name fallback resolver, lifted out of
 * `app/api/plan-build/route.ts` so the four-source priority chain can be
 * exercised end-to-end from regression smoke tests without pulling in the
 * route's Mongo / Protractor / Shop-Ware / DataOne dependencies.
 *
 * The plan greets the customer by name on the cover. A silent regression in
 * the fallback — e.g. accepting `"Unknown Customer"` from Tekmetric, dropping
 * the Protractor branch, or letting an empty string slip through Shop-Ware —
 * would surface the WRONG name on the plan, which the customer notices
 * immediately. Keep this file pure: no I/O, no `process.env`, just
 * deterministic transforms over the four lookup results the route hands in.
 */

export interface TekmetricWorkOrderForName {
  customerName?: string | null;
}

export interface ProtractorVehicleForName {
  CustomerName?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
}

export interface ShopWareWorkOrderForName {
  customerName?: string | null;
}

export interface VehicleDocForName {
  customerName?: string | null;
}

export interface CustomerNameSources {
  /** Latest Tekmetric `tekmetric_work_orders` doc for the VIN/shop, or null. */
  tekmetricWorkOrder?: TekmetricWorkOrderForName | null;
  /** `protractorVehicleResult.vehicle` when the Protractor lookup succeeded. */
  protractorVehicle?: ProtractorVehicleForName | null;
  /** Latest Shop-Ware `cached_work_orders` doc for the VIN/shop, or null. */
  shopWareWorkOrder?: ShopWareWorkOrderForName | null;
  /** Matching `vehicles` collection doc, or null. */
  vehicleDoc?: VehicleDocForName | null;
}

/**
 * The literal sentinel that Tekmetric stamps on a work order whose customer
 * record is missing. We must NEVER greet a customer with this value, so the
 * Tekmetric branch falls through to Protractor / Shop-Ware / vehicles when
 * it sees this value.
 */
export const TEKMETRIC_UNKNOWN_CUSTOMER_SENTINEL = "Unknown Customer";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolves the customer name to greet on the plan cover by trying four
 * sources in priority order:
 *   1. Tekmetric work order (skipping the `"Unknown Customer"` sentinel)
 *   2. Protractor vehicle record (CustomerName, else FirstName + LastName)
 *   3. Shop-Ware cached work order
 *   4. The `vehicles` collection
 *
 * Returns `null` when every source is missing/empty so the route can render
 * a generic greeting rather than a wrong one.
 */
export function resolveCustomerName(sources: CustomerNameSources): string | null {
  // 1. Tekmetric — winner unless the cached WO carries the "Unknown Customer"
  // sentinel (or no name at all). We do NOT trim: if Tekmetric has stored a
  // whitespace-only name that's a data bug we should see fall through, not
  // silently surface.
  const tekName = nonEmptyString(sources.tekmetricWorkOrder?.customerName);
  if (tekName && tekName !== TEKMETRIC_UNKNOWN_CUSTOMER_SENTINEL) {
    return tekName;
  }

  // 2. Protractor — `CustomerName` if present, otherwise concatenate first
  // and last name (mirroring the route's original `.filter(Boolean).join(" ")`
  // so a present-but-empty FirstName doesn't yield a leading space).
  const v = sources.protractorVehicle;
  if (v) {
    const direct = nonEmptyString(v.CustomerName);
    if (direct) return direct;

    const composed = [v.FirstName, v.LastName]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(" ");
    if (composed.length > 0) return composed;
  }

  // 3. Shop-Ware cached_work_orders.
  const swName = nonEmptyString(sources.shopWareWorkOrder?.customerName);
  if (swName) return swName;

  // 4. Vehicles collection — last resort.
  const vDocName = nonEmptyString(sources.vehicleDoc?.customerName);
  if (vDocName) return vDocName;

  return null;
}
