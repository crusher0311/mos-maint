import { getDb } from "@/lib/data/db";
import { customStickerQr } from "@/lib/sticker-qr-image";

/** Preserve the sticker routes' numeric shop scope and projected config read. */
export async function findStickerQrShop(shopId: number) {
  const db = await getDb();
  return db.collection("shops").findOne({ shopId }, { projection: { stickerConfig: 1 } });
}

export async function readCustomStickerQr(shopId: number): Promise<string> {
  return customStickerQr(await getDb(), shopId);
}

function mediaKey(shopId: number) {
  return { _id: `sticker-custom-qr:${shopId}` as any, shopId, type: "sticker_custom_qr" };
}

export async function saveCustomStickerQr(shopId: number, dataUri: string) {
  const db = await getDb();
  return db.collection("shop_media").updateOne(
    mediaKey(shopId),
    { $set: { dataUri, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function deleteCustomStickerQr(shopId: number) {
  const db = await getDb();
  return db.collection("shop_media").deleteOne(mediaKey(shopId));
}
