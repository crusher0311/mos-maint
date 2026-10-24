import type { CustomerMileageAnchor } from "./public-report-mileage";

export const publicVehicleKey = (shopId: number, vin: string) => `${shopId}:${vin.toUpperCase()}`;

export async function readCustomerMileage(db: any, shopId: number, vin: string): Promise<CustomerMileageAnchor | null> {
  const doc = await db.collection("public_report_state").findOne({ _id: publicVehicleKey(shopId, vin) }, { maxTimeMS: 1500 });
  return doc?.customerMileage ?? null;
}
