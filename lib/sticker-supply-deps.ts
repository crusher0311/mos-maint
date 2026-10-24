import { getSession } from "./auth";
import { getDb } from "./mongo";
import { checkShopFeatureGate } from "./extension-route-guard";
export const stickerSupplyDeps = { getSession, getDb, checkShopFeatureGate };
