import { randomBytes } from "crypto";
import type { Db } from "mongodb";
import { getStickerRedirectUrl } from "./sticker-utils";
import { STICKER_VIN_PATTERN } from "./sticker-redirect";

export interface StickerVehicleReference {
  _id: string;
  shopId: number;
  vin: string;
  createdAt: Date;
}

/** Issued only from authenticated generation routes, never from public VIN input.
 * References are durable bearer capabilities. They deliberately have no TTL:
 * the printed reference outlives the one-hour report token minted on each scan.
 */
export async function createStickerQrTarget(db: Db, shopId: number, rawVin?: unknown): Promise<string> {
  if (rawVin === undefined || rawVin === null || rawVin === "") return getStickerRedirectUrl(shopId);
  const vin = typeof rawVin === "string" ? rawVin.trim().toUpperCase() : "";
  // Incomplete/nonstandard records must still print; only usable VINs receive
  // a report capability. Persistence failures for valid VINs still propagate.
  if (!STICKER_VIN_PATTERN.test(vin)) return getStickerRedirectUrl(shopId);
  const reference = randomBytes(18).toString("base64url");
  await db.collection<StickerVehicleReference>("sticker_vehicle_references").insertOne({
    _id: reference, shopId, vin, createdAt: new Date(),
  });
  return getStickerRedirectUrl(shopId, reference);
}
