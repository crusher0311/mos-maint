import type { Db } from "mongodb";

/** Preserve the update handle for already-printed booking codes before replacing
 * the active print code. This write must succeed before publishing a replacement.
 * Unknown first-party codes are safe to retain: the HoverCode client reads their
 * target and refuses to replace first-party redirects with booking URLs.
 */
export async function retainLegacyStickerHovercode(
  db: Db, shopId: number, config: { hovercodeQRId?: string; qrTargetUrl?: string },
): Promise<void> {
  if (!config.hovercodeQRId || config.qrTargetUrl) return;
  await db.collection("shops").updateOne(
    { shopId },
    { $addToSet: { "stickerConfig.legacyHovercodeQRIds": config.hovercodeQRId } },
  );
}
