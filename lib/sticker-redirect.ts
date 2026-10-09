import { generateShareToken } from "./report-share";

export type StickerScanDestination = "appointment" | "website" | "vhi";
export const STICKER_REPORT_TTL_MS = 60 * 60 * 1000;
export const VEHICLE_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{24}$/;
export const STICKER_VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Dependencies keep scan resolution testable without touching live stores. */
export async function resolveStickerScan(
  shop: { stickerConfig?: { scanDestination?: StickerScanDestination; appointmentUrl?: string }; websiteUrl?: string },
  shopId: number,
  reference: string | null,
  deps: {
    resolveVehicle: (reference: string, shopId: number) => Promise<string | null>;
    canViewVhi: () => Promise<boolean>;
    now?: () => number;
  },
): Promise<{ kind: "vhi" | "appointment" | "website" | "none"; url: string | null }> {
  const destination = shop.stickerConfig?.scanDestination || "appointment";
  if (destination === "vhi" && reference && VEHICLE_REFERENCE_PATTERN.test(reference)) {
    const vin = await deps.resolveVehicle(reference, shopId);
    if (vin && STICKER_VIN_PATTERN.test(vin) && await deps.canViewVhi()) {
      const token = generateShareToken(vin, String(shopId), (deps.now?.() ?? Date.now()) + STICKER_REPORT_TTL_MS);
      return { kind: "vhi", url: `/report/${vin}?token=${encodeURIComponent(token)}` };
    }
  }
  const appointment = webUrl(shop.stickerConfig?.appointmentUrl);
  const website = webUrl(shop.websiteUrl);
  if (destination === "website" && website) return { kind: "website", url: website };
  if (appointment) return { kind: "appointment", url: appointment };
  if (website) return { kind: "website", url: website };
  return { kind: "none", url: null };
}
