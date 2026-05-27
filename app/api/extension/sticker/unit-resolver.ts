/**
 * Task #491 — pure resolver for the extension sticker config's
 * `useKilometers` field. Lives in its own module so smoke tests can
 * import it without dragging in the full sticker route runtime
 * (canvas-renderer, carfax/server-only, GCS, etc.).
 *
 * Precedence:
 *   1. `stickerConfig.useKilometers` (explicit boolean — true OR false
 *      always wins; a shop that intentionally pinned "miles" on a km
 *      shop keeps miles).
 *   2. Shop's main distance preference, `preferences.distanceUnit`
 *      ("kilometers" → true) with legacy `settings.distanceUnit`
 *      fallback.
 *   3. Default false (miles).
 */
export function resolveStickerUseKilometers(
  stickerConfig: { useKilometers?: unknown } | null | undefined,
  shopDoc: any,
): boolean {
  if (typeof stickerConfig?.useKilometers === "boolean") {
    return stickerConfig.useKilometers;
  }
  const shopDistanceUnit =
    shopDoc?.preferences?.distanceUnit ?? shopDoc?.settings?.distanceUnit;
  return shopDistanceUnit === "kilometers";
}
