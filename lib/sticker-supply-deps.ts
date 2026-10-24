import { getSession } from "./auth";
import { getShopStickerSupply, updateShopStickerSupply } from "@/lib/data/repositories/sticker-supply";
import { checkShopFeatureGate } from "./extension-route-guard";
export const stickerSupplyDeps = { getSession, getShopStickerSupply, updateShopStickerSupply, checkShopFeatureGate };
