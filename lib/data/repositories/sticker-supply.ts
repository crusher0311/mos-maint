import type { Db } from "mongodb";
import { getDb } from "@/lib/data/db";
import { changeStickerSupply, readStickerSupply } from "@/lib/sticker-activity";

export async function getShopStickerSupply(shopId: number, db?: Db) {
  return readStickerSupply(db ?? await getDb(), shopId);
}

export async function updateShopStickerSupply(shopId: number, input: unknown, db?: Db) {
  return changeStickerSupply(db ?? await getDb(), shopId, input);
}
