import type { Db } from "mongodb";
import { parseVhiLink } from "./external-api/vhi-link-webhook";

export class AppFueledQrUnavailable extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

/** Read the existing durable inbox, never create a second URL store. Receipt
 * order is not source order: only a single distinct validated URL is usable. */
export async function readAppFueledQrDestination(db: Db, shopId: number, vin: string): Promise<string | null> {
  const urls = await db.collection("partner_vhi_links").aggregate<{ _id: string }>([
    { $match: { partnerId: "appfueled", shopId, vin } },
    { $group: { _id: "$vhiUrl" } },
    { $limit: 2 },
  ], { maxTimeMS: 1500 }).toArray();
  if (urls.length !== 1) return null;
  return parseVhiLink({ shopId, vin, deliveryId: "qr-read", vhiUrl: urls[0]._id })?.vhiUrl ?? null;
}

export async function requireAppFueledQrDestination(db: Db, shopId: number, vin: string, allowed: () => Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([(async () => {
  if (!await allowed()) throw new AppFueledQrUnavailable("AppFueled VHI QR access is not enabled. Choose your shop link or ask an administrator to enable it. Stored URLs are retained.", 403);
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new AppFueledQrUnavailable("A valid VIN is required for an AppFueled VHI QR.");
  const url = await readAppFueledQrDestination(db, shopId, vin);
  if (!url) throw new AppFueledQrUnavailable("AppFueled's VHI URL is missing or conflicting for this vehicle. Choose your shop link or contact your service advisor.");
  return url;
  })(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppFueledQrUnavailable("AppFueled VHI lookup is temporarily unavailable. Please retry.", 503)), 5000);
  })]); } finally { if (timer) clearTimeout(timer); }
}
